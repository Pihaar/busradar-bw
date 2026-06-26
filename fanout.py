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
from contextlib import suppress
from dataclasses import dataclass, field
from typing import Optional, Union

log = logging.getLogger("busradar")


# === Constants ===

MAX_SUBSCRIBERS_PER_IP = 20      # IPv4 = /32, IPv6 = /64 canonicalized
MAX_SUBSCRIBERS_GLOBAL = 500
MAX_INFLIGHT = 200                # LRU-evict ältester
QUEUE_MAXSIZE = 32
SLOW_CONSUMER_DROP_THRESHOLD = 5  # consecutive drops → disconnect
CONNECTION_ID_BYTES = 32          # 32 * 8 / 1.33 ≈ 192-bit Entropy via urlsafe
CAP_REJECT_LOG_RATE = 60.0        # 1 warning per ip-hash per minute
INFLECTION_SUBSCRIBERS = 100      # log.warning above this
INFLECTION_VIEWPORTS = 50
BBOX_QUANTIZE_DEG = 0.01          # ~1.1 km grid; viewports <1.1km collapse on purpose


# === Selection Tagged Union ===
# Mutually exclusive subscriber state: either a selected journey, a selected
# stationboard, or neither. The type tag enforces the mutex at parse time
# (Pydantic), saving us from defending the invariant in code.

@dataclass(frozen=True)
class JourneySelection:
    jid: str


@dataclass(frozen=True)
class StationSelection:
    lid: str


Selection = Union[None, JourneySelection, StationSelection]


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
    selection: Selection = None
    event_queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=QUEUE_MAXSIZE))
    task: Optional[asyncio.Task] = None
    created_at: float = field(default_factory=time.monotonic)
    consecutive_drops: int = 0
    last_seen_tick_seq: int = 0


# === Tick fanout primitives ===

tick_condition: asyncio.Condition = asyncio.Condition()
tick_seq: int = 0


async def fire_tick() -> int:
    """Bump the monotonic tick counter and wake every subscriber waiting on it.

    Called by `tick.feed()` when a new HAFAS tick is detected. The Condition
    notify_all() must run inside the `async with condition` block, otherwise
    asyncio raises RuntimeError.
    """
    global tick_seq
    async with tick_condition:
        tick_seq += 1
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

    async def subscribe(self, ip: str) -> Subscriber:
        """Allocate a new connection-id, enforce caps under lock, register."""
        ip = canonicalize_ip(ip)
        async with self._lock:
            # Per-IP cap (skipped if ip is empty — e.g. unix socket / malformed)
            if ip:
                ip_set = self._per_ip.get(ip, set())
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
            if ip:
                self._per_ip.setdefault(ip, set()).add(cid)

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
            if sub.ip and sub.ip in self._per_ip:
                self._per_ip[sub.ip].discard(connection_id)
                if not self._per_ip[sub.ip]:
                    del self._per_ip[sub.ip]
            # Reset one-shot inflection warn when dropping back below threshold
            if self._inflection_warned and len(self._subs) <= INFLECTION_SUBSCRIBERS // 2:
                self._inflection_warned = False

    def get(self, connection_id: str) -> Optional[Subscriber]:
        """Lock-free lookup. Dict access is atomic under CPython's GIL."""
        return self._subs.get(connection_id)

    def __len__(self) -> int:
        return len(self._subs)


registry = SubscriberRegistry()


# === Queue put with drop-oldest policy ===

def enqueue_event(sub: Subscriber, event: dict) -> None:
    """Drop-oldest on full queue, count consecutive drops for slow-consumer
    detection. Reset drop-counter on every successful put (even after prior
    drops in the same window)."""
    q = sub.event_queue
    try:
        q.put_nowait(event)
        sub.consecutive_drops = 0
    except asyncio.QueueFull:
        # Drop oldest, retry. get_nowait may race with the consumer; suppress
        # if it does (rare but possible if the consumer just popped).
        with suppress(asyncio.QueueEmpty):
            q.get_nowait()
        try:
            q.put_nowait(event)
            sub.consecutive_drops += 1
        except asyncio.QueueFull:  # pragma: no cover — only if consumer races back
            sub.consecutive_drops += 1


def should_disconnect_slow_consumer(sub: Subscriber) -> bool:
    """5+ consecutive drops means the consumer can't keep up. The caller
    cancels the subscriber's task; the AsyncExitStack cleanup runs from
    there."""
    return sub.consecutive_drops >= SLOW_CONSUMER_DROP_THRESHOLD
