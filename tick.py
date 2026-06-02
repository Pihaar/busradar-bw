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

_TICK_ENABLED = os.environ.get("BUSRADAR_TICK_CALIBRATOR", "on").lower().strip() != "off"


# --- Monotonic clock helper ---
_mono = time.monotonic


# --- Classes ---

class ClientActivity:
    def __init__(self):
        self.last_ts: float = 0.0

    def touch(self):
        self.last_ts = _mono()

    def is_active(self) -> bool:
        return _mono() - self.last_ts < ACTIVE_CLIENT_WINDOW


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
        secs_until = self.seconds_until_next_tick()
        if secs_until is None:
            return max(0.0, fallback_ttl - age)
        return max(0.0, secs_until + TICK_BUFFER)

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
        # After reboot monotonic resets; load_persisted() rejects stale via age check.
        try:
            tmp = TICK_STATE_FILE.with_suffix('.tmp')
            tmp.write_text(json.dumps({"mono_offset": time.time() - ts}))
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


def inject_tick_hints(result: dict, tracker: TickTracker) -> dict:
    """Shallow copy + dynamische Tick-Felder. Original bleibt unverändert."""
    out = dict(result)
    secs = tracker.seconds_until_next_tick()
    if secs is not None:
        out["nextFreshDataIn"] = round(secs + TICK_BUFFER, 2)
    else:
        out["nextFreshDataIn"] = None
    age = tracker.data_age()
    out["dataAge"] = round(age, 2) if age is not None else None
    return out


# --- Calibrator ---

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
            return True
        await asyncio.sleep(1.0)
    return False


async def tick_calibrator(app, breaker, tracker: TickTracker, activity: ClientActivity,
                          hafas_endpoint: str, build_envelope):
    calib_failures = 0
    log.info("[tick_calibrator] started, waiting for first client")
    try:
        while not activity.is_active():
            await asyncio.sleep(5.0)
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
                target = pred
                for _ in range(20):
                    if target - _mono() >= interval:
                        break
                    target += TICK_PERIOD
                wait = max(1.0, (target - 1.0) - _mono())
            else:
                wait = interval
            await asyncio.sleep(wait)

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
