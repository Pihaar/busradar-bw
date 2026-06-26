"""
Busradar BW — Caching primitives.

* `_Cache` — single-slot async cache with tick-aware expiry.
* Per-endpoint dict caches + locks + inflight maps for journey,
  stationboard, and line-search.
* `_inflight` — per-viewport singleflight map shared with the SSE handler.
* `cached_singleflight()` — generic cached + singleflight wrapper used by
  the SSE-side fetch helpers.

Direction: imports hafas only — for `cached_singleflight` to surface upstream
errors verbatim. No back-edge from sse_handler/proxy.
"""

from __future__ import annotations

import asyncio
import random
import time


CACHE_TTL = 9.5
STOPS_CACHE_TTL = 86400.0

_JOURNEY_CACHE_TTL = 30
_STATIONBOARD_CACHE_TTL = 10
_LINE_SEARCH_CACHE_TTL = 30


class _Cache:
    def __init__(self, ttl: float = CACHE_TTL, daily_reset_hour: int | None = None):
        self._data: dict | None = None
        self._key: tuple | None = None
        self._ts: float = 0
        self._mono_ts: float = 0.0
        self._jitter: float = 0.0
        self._lock = asyncio.Lock()
        self._ttl = ttl
        self._daily_reset_hour = daily_reset_hour

    def _is_expired(self) -> bool:
        if self._ts == 0:
            return True
        if self._daily_reset_hour is not None:
            from datetime import datetime
            cached_dt = datetime.fromtimestamp(self._ts)
            now = datetime.now()
            reset_today = now.replace(hour=self._daily_reset_hour, minute=0, second=0, microsecond=0)
            if now >= reset_today and cached_dt < reset_today:
                return True
            return False
        return (time.time() - self._ts) >= self._ttl

    async def get(self, key: tuple) -> dict | None:
        async with self._lock:
            if self._key == key and not self._is_expired():
                return self._data
            return None

    async def get_tick_aware(self, key: tuple, tracker) -> dict | None:
        """Return cached data if key matches and tick-based expiry hasn't passed. Thread-safe."""
        async with self._lock:
            if self._key != key or self._data is None:
                return None
            age = time.monotonic() - self._mono_ts if self._mono_ts else 0.0
            remaining = tracker.cache_expiry_seconds(age, fallback_ttl=self._ttl)
            if remaining > self._jitter:
                return self._data
            return None

    async def set(self, key: tuple, data: dict):
        async with self._lock:
            self._key = key
            self._data = data
            self._ts = time.time()
            self._mono_ts = time.monotonic()
            self._jitter = random.uniform(0, 0.5)

    @property
    def stale_data(self) -> dict | None:
        return self._data


# Module-level singletons. The legacy `cache` slot is no longer used by the
# vehicles path (SSE owns that via `_inflight`) but stays alive because the
# coverage test still resets it.
cache = _Cache(ttl=CACHE_TTL)
stops_cache = _Cache(daily_reset_hour=3)

_journey_cache: dict = {}
_journey_cache_lock = asyncio.Lock()
_inflight_journey: dict[str, asyncio.Future] = {}

_stationboard_cache: dict = {}
_stationboard_cache_lock = asyncio.Lock()
_inflight_stationboard: dict[tuple, asyncio.Future] = {}

# Viewport-keyed singleflight map for the SSE vehicles fetch.
_inflight: dict[tuple, asyncio.Future] = {}

_line_search_cache: dict = {}


async def cached_singleflight(
    cache: dict,
    lock: asyncio.Lock,
    inflight: dict,
    key,
    ttl: float,
    evict_at: int,
    evict_keep: int,
    fetch_fn,
) -> dict:
    """Generic cached + singleflight wrapper. Used by the SSE-side fetch
    helpers so that concurrent subscribers asking for the same key share
    one upstream call. Returns the cached/fresh value or {"error": "upstream"}
    on failure. Cancellation of the originator propagates to all piggybackers.

    Contract for `fetch_fn`: `async () -> dict`. If the dict contains an
    `"error"` key the result is NOT cached and is propagated verbatim.
    On any exception, the future is set to the exception and re-raised;
    piggybackers fall through to start their own fetch (matches the
    viewport singleflight retry semantics).

    Identity-compare on inflight pop: only the originator that installed
    its own future is allowed to remove it. Without this guard a new
    coroutine that successfully inserted a fresh future under the same
    key could be evicted by a stale piggybacker's cleanup.
    """
    cached = cache.get(key)
    if cached and (time.time() - cached[0]) < ttl:
        return cached[1]

    # Singleflight: if a fetch is in flight, await it under shield so a
    # piggybacker's own cancellation can't cancel the shared future.
    existing = inflight.get(key)
    if existing is not None:
        try:
            return await asyncio.shield(existing)
        except asyncio.CancelledError:
            raise
        except Exception:
            # Originator's future errored. Fall through and start our own
            # fetch — matches `_fetch_vehicles_for_viewport`'s retry semantics
            # so a single failure on the shared future doesn't poison every
            # piggybacker.
            pass

    loop = asyncio.get_running_loop()
    fut: asyncio.Future = loop.create_future()
    inflight[key] = fut
    try:
        res = await fetch_fn()
        # Capture the cache timestamp right before the write so a slow
        # `fetch_fn` (HAFAS at 10s) doesn't stamp the entry as already half-aged.
        write_now = time.time()
        if "error" in res:
            out = {"error": res["error"]}
        else:
            async with lock:
                cache[key] = (write_now, res)
                if len(cache) > evict_at:
                    oldest = sorted(cache, key=lambda k: cache[k][0])[:evict_keep]
                    for k in oldest:
                        cache.pop(k, None)
            out = res
        if not fut.done():
            fut.set_result(out)
        return out
    except asyncio.CancelledError:
        # Originator cancelled mid-flight. Propagate cancellation to
        # piggybackers waiting on `shield(existing)`.
        if not fut.done():
            fut.cancel()
        raise
    except Exception as e:
        if not fut.done():
            fut.set_exception(e)
        raise
    finally:
        # Identity-compare: only remove if `inflight[key]` is still OUR
        # future. A racing originator may have replaced it after our error;
        # popping then would silently evict the new owner.
        if inflight.get(key) is fut:
            inflight.pop(key, None)
