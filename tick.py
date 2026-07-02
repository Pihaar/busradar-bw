"""
Busradar BW — GPS Tick Tracking

Detects the 30-second GPS update cadence of the HAFAS API,
provides tick predictions for cache invalidation and client polling hints.

Single-Writer invariant: only tick_calibrator() calls TickTracker.feed().
Request handlers only read last_tick_ts (atomic float read, CPython GIL).

Uses time.monotonic() internally for NTP-jump immunity.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path

import httpx

log = logging.getLogger("busradar")

# --- Constants ---
TICK_PERIOD = 30.0
# SSE push cadence. The HAFAS GPS-cadence is 30 s (TICK_PERIOD above), but
# HAFAS with trainPosMode=CALC returns a freshly-computed interpolated
# position on every call. Pushing every 10 s therefore gives clients a
# distinctly new interpolated position three times per real GPS cycle,
# which matches the v1.0.0 polling rate. REPORT_ONLY subscribers still
# only see change every 30 s (HAFAS itself doesn't move faster) so
# sse_handler drops 2 out of every 3 ticks for those subs to avoid
# emitting identical payloads and spending HAFAS budget on them.
SSE_PUSH_PERIOD = 10.0
TICK_BUFFER = 1.0
ACTIVE_CLIENT_WINDOW = 120.0
ACTIVE_CALIB_INTERVAL = 300.0
IDLE_CALIB_INTERVAL = 1800.0
TICK_DETECT_CENTER = {"x": 8_660_000, "y": 49_342_000}
TICK_DETECT_RADIUS_M = 20_000
TICK_MAX_AGE = 10800.0
TICK_MIN_CHANGED_BUSES = 3
TICK_NARROW_MIN_CHANGED = 2
CALIB_MAX_FAILURES = 3
CALIB_BACKOFF_SECONDS = 1800.0
TICK_POSITIONS_CAP = 1000
TICK_STATE_FILE = Path(os.environ.get("BUSRADAR_STATE_DIR", str(Path(__file__).parent))) / ".tick_state"

# The connected-clients counter and its UUID-bound helpers used to live here.
# After the SSE migration the counter is one SSE subscriber = one connection,
# tracked by fanout.SubscriberRegistry.

_TICK_ENABLED = os.environ.get("BUSRADAR_TICK_CALIBRATOR", "on").lower().strip() != "off"


# --- Monotonic clock helper ---
_mono = time.monotonic


# --- Classes ---

class ClientActivity:
    """Tracks whether the calibrator should keep probing HAFAS at the
    ACTIVE_CALIB_INTERVAL rate.

    The original design touched only on tick-detect, which deadlocked
    when HAFAS positions didn't change (rush-hour standstill, network
    blip, depot evening) — no tick → no touch → activity goes idle
    after ACTIVE_CLIENT_WINDOW seconds → calibrator drops to
    IDLE_CALIB_INTERVAL (30 min) → SSE subscribers wait on a
    tick_condition that won't fire again for half an hour even though
    HAFAS is back to normal.

    Now: keep an explicit subscriber count. Any open SSE stream counts
    as activity, regardless of whether ticks are being detected. A
    transition from 0 → 1 subscriber sets `wakeup_event`; the
    calibrator's idle sleep waits on this event and aborts immediately
    when a subscriber joins, so the live view doesn't have to wait 30
    minutes for the next probe.

    The legacy timestamp is kept as a fallback for the brief window
    between subscriber unsubscribe and next subscribe.
    """

    def __init__(self):
        self.last_ts: float = 0.0
        self._subscribers: int = 0
        # Lazily created so the class can be instantiated outside an
        # asyncio loop (tests import it without a running loop).
        self.wakeup_event: asyncio.Event | None = None

    def _ensure_event(self):
        if self.wakeup_event is None:
            self.wakeup_event = asyncio.Event()

    def touch(self):
        self.last_ts = _mono()

    def subscriber_joined(self):
        was_zero = self._subscribers == 0
        self._subscribers += 1
        self.last_ts = _mono()
        if was_zero:
            # 0 → 1 transition. If the calibrator is idle-sleeping, this
            # cuts the sleep short so the first vehicles event for the
            # fresh subscriber lands within a tick window, not 30 min.
            self._ensure_event()
            self.wakeup_event.set()

    def subscriber_left(self):
        # Defensive against double-unsubscribe; never go negative.
        if self._subscribers > 0:
            self._subscribers -= 1

    def is_active(self) -> bool:
        if self._subscribers > 0:
            return True
        return _mono() - self.last_ts < ACTIVE_CLIENT_WINDOW

    async def wait_for_wakeup(self, timeout: float) -> bool:
        """Sleep up to `timeout` seconds, returning early if a
        0→1 subscriber transition fires the wakeup event. Returns True
        if the event fired, False on plain timeout."""
        self._ensure_event()
        self.wakeup_event.clear()
        try:
            await asyncio.wait_for(self.wakeup_event.wait(), timeout=timeout)
            return True
        except (asyncio.TimeoutError, TimeoutError):
            return False



class TickTracker:
    """GPS-Tick-Erkennung. Single-Writer: nur tick_calibrator() ruft feed() auf.
    All timestamps are time.monotonic() based (NTP-immune)."""

    def __init__(self):
        self.last_tick_ts: float | None = None
        self._last_positions: dict[str, tuple[int, int]] = {}

    def next_tick_prediction(self) -> float | None:
        ts = self.last_tick_ts
        if ts is None:
            return None
        now = _mono()
        if now - ts > TICK_MAX_AGE:
            return None
        elapsed = now - ts
        if elapsed <= 0:
            return ts + TICK_PERIOD
        cycles = int(elapsed / TICK_PERIOD) + (0 if elapsed % TICK_PERIOD == 0 else 1)
        if cycles == 0:
            cycles = 1
        return ts + cycles * TICK_PERIOD

    def seconds_until_next_tick(self) -> float | None:
        pred = self.next_tick_prediction()
        if pred is None:
            return None
        return max(0.0, pred - _mono())

    def cache_expiry_seconds(self, age: float, fallback_ttl: float = 9.5) -> float:
        """How many seconds from now until a cache entry of given age should expire.
        age = _mono() - ts_when_cache_was_set."""
        ts = self.last_tick_ts
        if ts is None or (_mono() - ts) > TICK_MAX_AGE:
            return max(0.0, fallback_ttl - age)
        now = _mono()
        cache_set_mono = now - age
        if ts > cache_set_mono:
            return 0.0
        elapsed_at_set = cache_set_mono - ts
        cycles = int(elapsed_at_set / TICK_PERIOD) + 1
        first_tick_after_cache = ts + cycles * TICK_PERIOD
        remaining = (first_tick_after_cache + TICK_BUFFER) - now
        return max(0.0, remaining)

    def data_age(self) -> float | None:
        """Seconds since last detected tick (for client hint)."""
        ts = self.last_tick_ts
        if ts is None:
            return None
        age = _mono() - ts
        if age > TICK_MAX_AGE:
            return None
        return max(0.0, min(TICK_PERIOD, age))

    def feed(self, positions: dict[str, tuple[int, int]], ts: float, min_changed: int = 3) -> bool:
        if len(positions) > TICK_POSITIONS_CAP:
            positions = dict(list(positions.items())[:TICK_POSITIONS_CAP])
        if not self._last_positions:
            self._last_positions = positions
            return False
        shared = set(self._last_positions) & set(positions)
        if len(shared) < min_changed:
            self._last_positions = positions
            return False
        changed = sum(1 for j in shared if self._last_positions[j] != positions[j])
        self._last_positions = positions
        if changed >= min_changed:
            self.last_tick_ts = ts
            self._persist_tick(ts)
            return True
        return False

    def _persist_tick(self, ts: float):
        # Stores wall-to-mono offset for cross-restart reconstruction.
        # Also stores wall_ts directly so external consumers (logger) can compute
        # tick alignment without monotonic-clock awareness.
        # After reboot monotonic resets; load_persisted() rejects stale via age check.
        try:
            tmp = TICK_STATE_FILE.with_suffix('.tmp')
            now_wall = time.time()
            tmp.write_text(json.dumps({
                "mono_offset": now_wall - ts,
                "wall_ts": now_wall,
                "period": TICK_PERIOD,
            }))
            tmp.rename(TICK_STATE_FILE)
        except Exception:
            log.debug("[tick_calibrator] failed to persist tick state")

    def load_persisted(self):
        try:
            if not TICK_STATE_FILE.exists():
                return
            data = json.loads(TICK_STATE_FILE.read_text())
            mono_offset = data.get("mono_offset")
            if mono_offset is None:
                return
            # Reconstruct: last_tick happened at wall_time = mono_ts + mono_offset
            # So mono_ts = wall_time - mono_offset; but we store offset = time.time() - mono_ts
            # On restart: new_mono_ts = time.time() - mono_offset
            restored = time.time() - mono_offset
            age = _mono() - restored
            if 0 < age < TICK_MAX_AGE:
                self.last_tick_ts = restored
                log.info("[tick_calibrator] restored tick from state file (age=%.0fs)", age)
        except Exception:
            pass
_CALIB_SEM = asyncio.Semaphore(1)


async def _calib_fetch(app, breaker, hafas_endpoint: str, build_envelope) -> dict | None:
    if breaker.is_open:
        return None
    async with _CALIB_SEM:
        try:
            payload = build_envelope("JourneyGeoPos", {
                "ring": {"cCrd": TICK_DETECT_CENTER, "maxDist": TICK_DETECT_RADIUS_M},
                "perSize": 60, "perStep": 5,
                "jnyFltrL": [{"type": "PROD", "mode": "INC", "value": "32"}],
                "trainPosMode": "REPORT_ONLY",
            })
            resp = await app.state.client.post(hafas_endpoint, json=payload, timeout=5.0)
            resp.raise_for_status()
            data = resp.json()
            if data.get("err") != "OK":
                return None
            svc = data.get("svcResL", [{}])[0]
            if svc.get("err") != "OK":
                return None
            return svc.get("res", {})
        except Exception:
            return None


async def _run_calibration(app, breaker, tracker: TickTracker, hafas_endpoint: str,
                           build_envelope, scan_seconds: int, min_changed: int) -> bool:
    tracker._last_positions = {}
    for _ in range(scan_seconds):
        if breaker.is_open:
            return False
        res = await _calib_fetch(app, breaker, hafas_endpoint, build_envelope)
        if res is None:
            await asyncio.sleep(1.0)
            continue
        positions = {}
        for j in res.get("jnyL", []):
            pos = j.get("pos") or {}
            if pos.get("x") and pos.get("y"):
                positions[j.get("jid", "")] = (pos["x"], pos["y"])
        ts = _mono()
        if tracker.feed(positions, ts, min_changed=min_changed):
            wall_sec = time.localtime().tm_sec + (time.time() % 1)
            log.info("[tick_calibrator] tick at :%04.1f (%ds scan)", wall_sec, scan_seconds)
            # Broadcast to SSE subscribers is now owned by sse_push_loop,
            # which fires every SSE_PUSH_PERIOD seconds regardless of the
            # calibrator. The calibrator only maintains last_tick_ts for
            # /api/health metadata and cache-invalidation predictions.
            return True
        await asyncio.sleep(1.0)
    return False


async def tick_calibrator(app, breaker, tracker: TickTracker, activity: ClientActivity,
                          hafas_endpoint: str, build_envelope):
    calib_failures = 0
    log.info("[tick_calibrator] started, waiting for first client")
    try:
        while not activity.is_active():
            # wait_for_wakeup returns as soon as a subscriber joins, so a
            # cold-start tab doesn't wait 5s for the next poll.
            woke = await activity.wait_for_wakeup(5.0)
            if woke:
                break
    except asyncio.CancelledError:
        log.info("[tick_calibrator] cancelled during wait")
        raise

    log.info("[tick_calibrator] cold-start scan")
    tracker.load_persisted()
    if tracker.last_tick_ts is None:
        await _run_calibration(app, breaker, tracker, hafas_endpoint, build_envelope,
                               scan_seconds=32, min_changed=TICK_MIN_CHANGED_BUSES)

    while True:
        try:
            active = activity.is_active()
            interval = ACTIVE_CALIB_INTERVAL if active else IDLE_CALIB_INTERVAL

            pred = tracker.next_tick_prediction()
            if pred and active:
                # Probe just before the predicted next tick. The original
                # code here ran a for-loop that bumped `target` by
                # TICK_PERIOD until `target - now >= interval` — which on
                # a fresh tick meant the calibrator slept ~5 minutes
                # (ACTIVE_CALIB_INTERVAL) between probes, since pred is
                # always within one TICK_PERIOD of now and the loop
                # would skip 10 cycles to reach the interval ceiling.
                # That was fine for the pre-SSE polling-cache design,
                # but with SSE-push the calibrator IS the tick source
                # for vehicle fan-out, so subscribers waited 5 minutes
                # between vehicles events while /api/health showed
                # calibrator_mode "active" and tick_age_s climbing.
                # next_tick_prediction() already returns the soonest
                # future tick; subtract 1 s of slack and floor at 1.
                wait = max(1.0, (pred - 1.0) - _mono())
                if wait > interval:
                    # Safety net: if the prediction lands implausibly
                    # far in the future, fall back to the configured
                    # interval rather than vanishing for an hour.
                    wait = interval
            else:
                wait = interval
            # Idle long-sleep is interruptible: a new subscriber sets the
            # wakeup event and we re-evaluate immediately. Active waits use
            # a plain sleep — they're at most ACTIVE_CALIB_INTERVAL=5min and
            # the predicted-tick target makes early wakeups counterproductive.
            if active:
                await asyncio.sleep(wait)
            else:
                woke = await activity.wait_for_wakeup(wait)
                if woke:
                    log.info("[tick_calibrator] woken by subscriber join")

            if breaker.is_open:
                log.debug("[tick_calibrator] breaker open, skipping")
                continue

            if calib_failures >= CALIB_MAX_FAILURES:
                log.warning("[tick_calibrator] %d failures, backing off %.0fs",
                           calib_failures, CALIB_BACKOFF_SECONDS)
                # D5: reactive backoff — check activity every 60s
                for _ in range(int(CALIB_BACKOFF_SECONDS / 60)):
                    await asyncio.sleep(60)
                    if activity.is_active() and not breaker.is_open:
                        break
                calib_failures = 0
                continue

            found = await _run_calibration(app, breaker, tracker, hafas_endpoint, build_envelope,
                                           scan_seconds=3, min_changed=TICK_NARROW_MIN_CHANGED)
            if not found:
                found = await _run_calibration(app, breaker, tracker, hafas_endpoint, build_envelope,
                                               scan_seconds=11, min_changed=TICK_NARROW_MIN_CHANGED)
            if not found:
                found = await _run_calibration(app, breaker, tracker, hafas_endpoint, build_envelope,
                                               scan_seconds=32, min_changed=TICK_MIN_CHANGED_BUSES)
            if not found:
                calib_failures += 1
                log.info("[tick_calibrator] burst missed (failures=%d)", calib_failures)
            else:
                calib_failures = 0

        except asyncio.CancelledError:
            log.info("[tick_calibrator] cancelled, shutting down")
            raise
        except Exception as e:
            log.error("[tick_calibrator] error: %s", type(e).__name__)
            await asyncio.sleep(60)


async def sse_push_loop(activity: ClientActivity):
    """SSE broadcast pacemaker. Fires fanout.fire_tick() every SSE_PUSH_PERIOD
    seconds while at least one subscriber is connected, so CALC-mode clients
    receive a freshly-computed interpolated position on that cadence. When
    no subscribers are around it sleeps on the ClientActivity wakeup and
    resumes cheaply on the first join.

    Decoupled from tick_calibrator so the push cadence (10 s) can be finer
    than the underlying HAFAS GPS-cadence (30 s). The calibrator now only
    detects the real HAFAS tick for metadata purposes.
    """
    log.info("[sse_push_loop] started (period=%.1fs)", SSE_PUSH_PERIOD)
    while True:
        try:
            if not activity.is_active():
                # No subscribers: block on the wakeup event forever (or until
                # a subscriber joins). This is symmetrical with how the
                # calibrator behaves in idle mode, avoiding wasted wakeups.
                await activity.wait_for_wakeup(3600.0)
                continue

            await asyncio.sleep(SSE_PUSH_PERIOD)

            try:
                import fanout
                await fanout.fire_tick()
            except Exception:
                log.exception("[sse_push_loop] fanout.fire_tick failed")
        except asyncio.CancelledError:
            log.info("[sse_push_loop] cancelled, shutting down")
            raise
        except Exception as e:
            log.error("[sse_push_loop] error: %s", type(e).__name__)
            await asyncio.sleep(5.0)
