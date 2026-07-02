"""
Busradar BW — SSE Subscriber Fanout

Single-process subscriber registry + tick-fanout for the SSE stack.

* `SubscriberRegistry` holds active EventSource connections keyed by
  connection-id, guards all mutations with one `asyncio.Lock` so the
  per-IP/global caps can't be overshot by a race.
* `tick_condition` (asyncio.Condition) + `tick_seq` (monotonic int)
  replace the lost-wakeup-prone `Event.set()+clear()` pattern: each
  subscriber waits on `condition.wait_for(lambda: tick_seq > local_seq)`
  and is woken atomically by `tick.feed()` calling `notify_all()`.
* Dependency direction: `tick.py` imports + writes to this module's
  `tick_condition` and `tick_seq`. The graph is acyclic (tick → fanout,
  no back-edge).

This module is intentionally single-worker. Multi-worker scaling would
need a Redis-backed registry and pub/sub for tick notification; see the
SSE-migration plan for the explicit out-of-scope note.

Python int has arbitrary precision so `tick_seq` never wraps — a future
port to a typed language must keep that property (don't pick `u64`).
"""
from __future__ import annotations

import asyncio
import ipaddress
import logging
import secrets
import time
from dataclasses import dataclass, field
from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator

log = logging.getLogger("busradar")


# === Constants ===

MAX_SUBSCRIBERS_PER_IP = 20      # IPv4 = /32, IPv6 = /64 canonicalized
MAX_SUBSCRIBERS_GLOBAL = 500
MAX_INFLIGHT = 200                # LRU-evict ältester
SLOW_CONSUMER_DROP_THRESHOLD = 5  # consecutive drops → disconnect
CONNECTION_ID_BYTES = 32          # 32 * 8 / 1.33 ≈ 192-bit Entropy via urlsafe
CAP_REJECT_LOG_RATE = 60.0        # 1 warning per ip-hash per minute
INFLECTION_SUBSCRIBERS = 100      # log.warning above this
INFLECTION_VIEWPORTS = 50
BBOX_QUANTIZE_DEG = 0.01          # ~1.1 km grid; viewports <1.1km collapse on purpose


# === Selection Tagged Union ===
# Mutually exclusive subscriber state: either a selected journey, a selected
# stationboard, or neither. The Pydantic discriminator field "kind" enforces
# the mutex at parse time AND lets the same models serve as both the SSE
# input (SelectPayload) and the subscriber-stored state, removing the
# manual dataclass→Pydantic mapping that lived in the /select handler.
#
# Each Selection type carries the metadata the SSE dispatch needs:
#   - event_name(): SSE event name to emit
#   - cache_key():  key shape for the helper's singleflight cache
# The actual fetch lives in proxy.py (module boundary keeps fanout.py free
# of HTTP/HAFAS dependencies); proxy dispatches via _fetch_for_selection().


class JourneySelection(BaseModel):
    # frozen=True for hash + immutability; extra="forbid" so the wire
    # format doesn't silently accept fields the server doesn't know about
    # (Pydantic does NOT propagate extra="forbid" from a parent model).
    model_config = ConfigDict(frozen=True, extra="forbid")
    kind: Literal["journey"] = "journey"
    jid: str = Field(max_length=300)

    def event_name(self) -> str:
        return "journey"

    def cache_key(self) -> str:
        return self.jid


class StationSelection(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")
    kind: Literal["stationboard"] = "stationboard"
    lid: str = Field(max_length=300)
    # Default DEP so the existing /select calls that don't carry board_type
    # behave as they did before. Clients that want ARR pushes set this to
    # "ARR"; the SSE handler dispatches on it.
    board_type: Literal["DEP", "ARR"] = "DEP"
    # Window the client is showing. Auto-expand on the client walks 60 → 120
    # → … → 1440 until results arrive; the live SSE push must match that
    # window or the rendered list shrinks on the first tick (midnight-wrap
    # entries vanish, +1d badges with them). Must be a multiple of 60 —
    # mismatched values are rejected with 422 rather than silently snapped,
    # so a misbehaving client gets a visible error instead of inheriting a
    # narrower window than it asked for.
    dur: int = Field(60, ge=60, le=1440)

    @field_validator("dur")
    @classmethod
    def _dur_must_be_multiple_of_60(cls, v: int) -> int:
        if v % 60 != 0:
            raise ValueError("dur must be a multiple of 60")
        return v

    def event_name(self) -> str:
        return "stationboard"

    def cache_key(self) -> tuple:
        return (self.lid, self.board_type, self.dur)


# Discriminated union for the Subscriber.selection field and SelectPayload.
Selection = Annotated[
    Union[JourneySelection, StationSelection],
    Field(discriminator="kind"),
]


# === Subscriber ===

@dataclass
class Subscriber:
    """Open EventSource. Fields are populated incrementally as the client
    sends viewport / selection POSTs; defaults mean the loop emits nothing
    useful until the client tells the server what it cares about."""
    connection_id: str
    ip: str                                    # canonicalized (IPv4 /32 or IPv6 /64)
    viewport: tuple[float, float, float, float] | None = None  # (swLat, swLon, neLat, neLon)
    pos_mode: str = "CALC"                     # "CALC" or "REPORT_ONLY"
    selection: Optional[Union[JourneySelection, StationSelection]] = None
    selection_seq: int = 0                     # monotonic; bumped on /select POST so the SSE loop can discard stale fetch results
    created_at: float = field(default_factory=time.monotonic)
    # Slow-consumer disconnect counter. Incremented when a yield batch exceeds
    # SSE_SLOW_YIELD_THRESHOLD_S (proxy.py); 5 consecutive trips → disconnect.
    consecutive_drops: int = 0
    # Per-subscriber token-bucket state for the /viewport and /select POST
    # rate-limiters. Refill is continuous at 1 token/s, cap = 3 (burst).
    post_rate_last_refill: float = field(default_factory=time.monotonic)
    post_rate_tokens: float = 3.0
    # Bbox-quantize of the viewport when /viewport was last accepted, so
    # /viewport POST can skip fire_tick() when nothing actually changed.
    last_viewport_bbox: tuple[int, int, int, int] | None = None
    # REPORT_ONLY skip anchor: push_seq at last emit (or None for "never").
    # sse_push_loop fires every 10 s but HAFAS REPORT_ONLY positions only
    # update every ~30 s, so we emit at most every 3rd push. Anchored to
    # the GLOBAL push_seq (not a per-sub wake counter) so viewport-POST
    # induced wakes from other users don't shift this sub's skip pattern.
    # None means "next push always emits" — used both on initial subscribe
    # and after any posMode toggle so the user sees new-mode data quickly.
    last_emitted_push_seq: int | None = None


# === Tick fanout primitives ===

tick_condition: asyncio.Condition = asyncio.Condition()
tick_seq: int = 0
# push_seq is a subset of tick_seq: it increments only when sse_push_loop
# triggers the fanout, not when handle_viewport does. REPORT_ONLY subscribers
# use push_seq (mod 3) to decide whether to emit — anchoring to the global
# push cadence rather than a per-sub wake-counter keeps the 3:1 skip
# pattern deterministic even when other users' viewport POSTs wake the
# stream in between pushes.
push_seq: int = 0

# Global fire_tick rate-limit: a viewport-POST can wake every subscriber
# (up to MAX_SUBSCRIBERS_GLOBAL=500), each of whom re-fetches HAFAS for
# their own bbox. An attacker oscillating a viewport across the quantize
# boundary would broadcast N HAFAS fetches per POST, per second (bounded
# only by per-IP rate limits). Global aggregate cap protects HAFAS-side
# even when many legitimate users pan at once. Token bucket, continuous
# refill: bucket size FIRE_TICK_BURST tokens, refill 1 token every
# 1/FIRE_TICK_RATE seconds. When empty, extra fire_tick calls no-op —
# subscribers still receive the next sse_push_loop tick within
# SSE_PUSH_PERIOD (≤10 s) so responsiveness degrades gracefully.
FIRE_TICK_RATE = 2.0     # tokens per second (global aggregate)
FIRE_TICK_BURST = 5.0    # burst capacity
_fire_tick_tokens: float = FIRE_TICK_BURST
_fire_tick_last_refill: float = 0.0  # time.monotonic() when tokens last topped up
_fire_tick_shed_count: int = 0       # instrumentation: sum of denials
_fire_tick_shed_log_cooldown: float = 0.0  # last-warning timestamp


async def fire_tick() -> int:
    """Bump the monotonic tick counter and wake every subscriber waiting on it.

    Called by handle_viewport when a subscriber's bbox actually changed
    (invalidating the singleflight cache key). Rate-limited globally: an
    attacker oscillating one viewport across the quantize boundary can
    otherwise force N-sub HAFAS fetches per second, amplifying by up to
    MAX_SUBSCRIBERS_GLOBAL. Falls back to the natural push cadence when
    the aggregate bucket is empty.
    """
    global tick_seq, _fire_tick_tokens, _fire_tick_last_refill
    global _fire_tick_shed_count, _fire_tick_shed_log_cooldown
    async with tick_condition:
        now = time.monotonic()
        # Continuous refill up to FIRE_TICK_BURST cap
        if _fire_tick_last_refill == 0.0:
            _fire_tick_last_refill = now
        elapsed = now - _fire_tick_last_refill
        if elapsed > 0:
            _fire_tick_tokens = min(FIRE_TICK_BURST,
                                    _fire_tick_tokens + elapsed * FIRE_TICK_RATE)
            _fire_tick_last_refill = now
        if _fire_tick_tokens < 1.0:
            _fire_tick_shed_count += 1
            # Log at most once per 60 s to keep the journal clean under
            # a sustained storm; the count line reveals the aggregate
            # damage since the last log.
            if now - _fire_tick_shed_log_cooldown > 60.0:
                log.warning(
                    "[fanout] fire_tick shed=%d, bucket empty (rate=%.1f/s burst=%.0f)",
                    _fire_tick_shed_count, FIRE_TICK_RATE, FIRE_TICK_BURST,
                )
                _fire_tick_shed_log_cooldown = now
            return tick_seq
        _fire_tick_tokens -= 1.0
        tick_seq += 1
        tick_condition.notify_all()
        return tick_seq


async def fire_push_tick() -> int:
    """Push-loop-owned variant: bumps push_seq as well as tick_seq. Called
    from sse_push_loop at SSE_PUSH_PERIOD cadence. REPORT_ONLY subs anchor
    their skip pattern on push_seq so viewport-POST-induced wakes don't
    desync their emit cadence."""
    global tick_seq, push_seq
    async with tick_condition:
        tick_seq += 1
        push_seq += 1
        tick_condition.notify_all()
        return tick_seq


# === IPv6 canonicalisation ===

def canonicalize_ip(host: str | None) -> str:
    """IPv4 stays as-is. IPv6 collapses to its /64 prefix so an attacker
    with a routed /64 can't trivially bypass per-IP caps. Malformed input
    returns the empty string (caller decides — typically count as no-cap
    bucket, i.e. global-cap-only)."""
    if not host:
        return ""
    try:
        addr = ipaddress.ip_address(host)
        if isinstance(addr, ipaddress.IPv6Address):
            net = ipaddress.ip_network(f"{host}/64", strict=False)
            return str(net.network_address)
        return host
    except ValueError:
        return ""


# === Bbox quantize ===

def quantize_bbox(bbox: tuple[float, float, float, float]) -> tuple[int, int, int, int]:
    """Quantize a (swLat, swLon, neLat, neLon) tuple onto a fixed grid so the
    HAFAS singleflight cache deduplicates pan-jitter. Below the grid size
    (~1.1 km) distinct viewports collapse to the same key — by design, all
    subscribers in that area would see the same buses anyway."""
    sw_lat, sw_lon, ne_lat, ne_lon = bbox
    q = BBOX_QUANTIZE_DEG
    return (int(sw_lat / q), int(sw_lon / q), int(ne_lat / q), int(ne_lon / q))


# === Cap-reject rate-limited logging ===

_cap_reject_log_last: dict[str, float] = {}


def _maybe_log_cap_reject(scope: str, ip: str, count: int) -> None:
    """Rate-limit cap-reject logs to 1/min per ip-hash, so a botnet attack
    can't flood the journal. IP is hashed for DPP-254 compliance."""
    import hashlib
    now = time.monotonic()
    ip_hash = hashlib.sha256(ip.encode()).hexdigest()[:8] if ip else "noip"
    key = f"{scope}:{ip_hash}"
    last = _cap_reject_log_last.get(key, 0.0)
    if now - last < CAP_REJECT_LOG_RATE:
        return
    _cap_reject_log_last[key] = now
    log.warning(
        "[fanout] cap-reject scope=%s ip_hash=%s n=%d",
        scope, ip_hash, count,
    )


# === Registry ===

class CapExceeded(Exception):
    """Raised when subscribe would exceed an IP- or global-cap.

    The `scope` ("ip" or "global") is surfaced in the 429-body so the
    frontend can show a differentiated banner. The recon trade-off (a
    scanner can probe which cap fired) is accepted in favor of UX."""
    def __init__(self, scope: str, limit: int) -> None:
        self.scope = scope
        self.limit = limit
        super().__init__(f"subscriber cap exceeded: scope={scope} limit={limit}")


class SubscriberRegistry:
    """Singleton registry. All mutations under one asyncio.Lock so the cap
    can't be overshot by two simultaneous subscribe() calls passing the
    pre-check before either is inserted."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._subs: dict[str, Subscriber] = {}
        self._per_ip: dict[str, set[str]] = {}  # ip → set of connection-ids
        self._inflection_warned = False
        # Separate one-shot for the viewports inflection — fires when many
        # subscribers track distinct quantized bboxes, signaling that the
        # singleflight cache is no longer collapsing fan-out effectively.
        self._inflection_viewports_warned = False

    async def subscribe(self, ip: str) -> Subscriber:
        """Allocate a new connection-id, enforce caps under lock, register."""
        ip = canonicalize_ip(ip)
        async with self._lock:
            # Per-IP cap. Empty IP (unix socket / malformed / proxy-stripped
            # request.client) collapses to a single shared "noip" bucket so
            # that a misconfigured trust boundary cannot bypass the cap and
            # exhaust MAX_SUBSCRIBERS_GLOBAL slots.
            bucket_key = ip if ip else ""
            ip_set = self._per_ip.get(bucket_key, set())
            if len(ip_set) >= MAX_SUBSCRIBERS_PER_IP:
                _maybe_log_cap_reject("ip", ip, len(ip_set))
                raise CapExceeded("ip", MAX_SUBSCRIBERS_PER_IP)
            # Global cap
            if len(self._subs) >= MAX_SUBSCRIBERS_GLOBAL:
                _maybe_log_cap_reject("global", ip, len(self._subs))
                raise CapExceeded("global", MAX_SUBSCRIBERS_GLOBAL)

            cid = secrets.token_urlsafe(CONNECTION_ID_BYTES)
            sub = Subscriber(connection_id=cid, ip=ip)
            self._subs[cid] = sub
            self._per_ip.setdefault(bucket_key, set()).add(cid)

            # Inflection-point logging (one-shot per process lifetime per direction)
            n = len(self._subs)
            if n > INFLECTION_SUBSCRIBERS and not self._inflection_warned:
                self._inflection_warned = True
                log.warning(
                    "[fanout] inflection_point subscribers=%d threshold=%d",
                    n, INFLECTION_SUBSCRIBERS,
                )
            return sub

    async def unsubscribe(self, connection_id: str) -> None:
        """Remove a subscriber. Idempotent — multiple calls for the same id
        are safe (cleanup path may run more than once)."""
        async with self._lock:
            sub = self._subs.pop(connection_id, None)
            if sub is None:
                return
            # Bucket key mirrors the subscribe() branch: empty IP maps to "".
            bucket_key = sub.ip if sub.ip else ""
            if bucket_key in self._per_ip:
                self._per_ip[bucket_key].discard(connection_id)
                if not self._per_ip[bucket_key]:
                    del self._per_ip[bucket_key]
            # Reset one-shot inflection warn when dropping back below threshold
            if self._inflection_warned and len(self._subs) <= INFLECTION_SUBSCRIBERS // 2:
                self._inflection_warned = False

    def get(self, connection_id: str) -> Optional[Subscriber]:
        """Lock-free lookup. Dict access is atomic under CPython's GIL."""
        return self._subs.get(connection_id)

    def __len__(self) -> int:
        return len(self._subs)

    def maybe_warn_viewport_inflection(self) -> None:
        """Count distinct quantized bboxes across subscribers; warn once when
        the population crosses INFLECTION_VIEWPORTS. Signals that singleflight
        is no longer collapsing fan-out and a master-poll architecture should
        be evaluated. One-shot per process lifetime per direction (reset when
        the count drops below half the threshold)."""
        distinct = len({sub.last_viewport_bbox for sub in self._subs.values() if sub.last_viewport_bbox is not None})
        if distinct > INFLECTION_VIEWPORTS and not self._inflection_viewports_warned:
            self._inflection_viewports_warned = True
            log.warning(
                "[fanout] inflection_point distinct_viewports=%d threshold=%d",
                distinct, INFLECTION_VIEWPORTS,
            )
        elif self._inflection_viewports_warned and distinct <= INFLECTION_VIEWPORTS // 2:
            self._inflection_viewports_warned = False


registry = SubscriberRegistry()


# === Slow-consumer detection ===
# The SSE event_generator in sse_handler.py measures wall-clock around each
# yield batch and bumps `sub.consecutive_drops` when a batch exceeds the
# slow threshold. This predicate is read-only.

def should_disconnect_slow_consumer(sub: Subscriber) -> bool:
    """5+ consecutive slow yield batches means the consumer can't keep up.
    The caller (SSE handler) breaks out of its loop; AsyncExitStack cleanup
    runs from there."""
    return sub.consecutive_drops >= SLOW_CONSUMER_DROP_THRESHOLD
