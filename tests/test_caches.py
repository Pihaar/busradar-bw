"""Tests for caches.py — _Cache tick-aware/daily-reset + cached_singleflight."""

from __future__ import annotations

import asyncio
from datetime import datetime
from unittest.mock import MagicMock

import pytest

import caches
from caches import _Cache, cached_singleflight


class TestCacheBasic:
    @pytest.mark.asyncio
    async def test_get_miss_when_never_set(self):
        c = _Cache()
        assert await c.get(("k",)) is None

    @pytest.mark.asyncio
    async def test_set_then_get_hit(self):
        c = _Cache(ttl=100)
        await c.set(("k",), {"v": 1})
        assert await c.get(("k",)) == {"v": 1}

    @pytest.mark.asyncio
    async def test_get_wrong_key_miss(self):
        c = _Cache(ttl=100)
        await c.set(("k",), {"v": 1})
        assert await c.get(("other",)) is None

    @pytest.mark.asyncio
    async def test_get_expired_by_ttl(self, monkeypatch):
        c = _Cache(ttl=10)
        await c.set(("k",), {"v": 1})
        # Advance wall clock past ttl.
        base = c._ts
        monkeypatch.setattr(caches.time, "time", lambda: base + 11)
        assert await c.get(("k",)) is None

    @pytest.mark.asyncio
    async def test_is_expired_when_ts_zero(self):
        c = _Cache()
        # Never set → _ts == 0 → expired.
        assert c._is_expired() is True

    @pytest.mark.asyncio
    async def test_stale_data_property(self):
        c = _Cache(ttl=100)
        assert c.stale_data is None
        await c.set(("k",), {"v": 9})
        assert c.stale_data == {"v": 9}


class TestCacheDailyReset:
    def _patch_dt(self, monkeypatch, now_dt):
        # _is_expired does `from datetime import datetime`, so patch the class
        # on the stdlib datetime module. Keep fromtimestamp real.
        import datetime as dt_mod

        fake = type(
            "FakeDT",
            (),
            {
                "now": staticmethod(lambda: now_dt),
                "fromtimestamp": staticmethod(dt_mod.datetime.fromtimestamp),
            },
        )
        monkeypatch.setattr(dt_mod, "datetime", fake)

    @pytest.mark.asyncio
    async def test_not_expired_before_reset_hour(self, monkeypatch):
        c = _Cache(daily_reset_hour=3)
        # cached today 02:00, now today 02:30 (before reset) → not expired.
        cached_dt = datetime(2026, 5, 23, 2, 0, 0)
        now_dt = datetime(2026, 5, 23, 2, 30, 0)
        c._ts = cached_dt.timestamp()
        self._patch_dt(monkeypatch, now_dt)
        assert c._is_expired() is False

    @pytest.mark.asyncio
    async def test_expired_after_reset_when_cached_before(self, monkeypatch):
        c = _Cache(daily_reset_hour=3)
        # Cached yesterday 04:00, now today 10:00 → past reset, cached before it.
        cached_dt = datetime(2026, 5, 22, 4, 0, 0)
        now_dt = datetime(2026, 5, 23, 10, 0, 0)
        c._ts = cached_dt.timestamp()
        self._patch_dt(monkeypatch, now_dt)
        assert c._is_expired() is True

    @pytest.mark.asyncio
    async def test_not_expired_when_cached_after_reset(self, monkeypatch):
        c = _Cache(daily_reset_hour=3)
        # Cached today 04:00 (after reset), now today 10:00 → not expired.
        cached_dt = datetime(2026, 5, 23, 4, 0, 0)
        now_dt = datetime(2026, 5, 23, 10, 0, 0)
        c._ts = cached_dt.timestamp()
        self._patch_dt(monkeypatch, now_dt)
        assert c._is_expired() is False


class TestCacheTickAware:
    class _Tracker:
        def __init__(self, remaining):
            self._remaining = remaining

        def cache_expiry_seconds(self, age, fallback_ttl):
            return self._remaining

    @pytest.mark.asyncio
    async def test_miss_when_key_differs(self):
        c = _Cache()
        await c.set(("k",), {"v": 1})
        assert await c.get_tick_aware(("other",), self._Tracker(100)) is None

    @pytest.mark.asyncio
    async def test_miss_when_data_none(self):
        c = _Cache()
        # key matches but data is None (never set).
        c._key = ("k",)
        c._data = None
        assert await c.get_tick_aware(("k",), self._Tracker(100)) is None

    @pytest.mark.asyncio
    async def test_hit_when_remaining_gt_jitter(self):
        c = _Cache()
        await c.set(("k",), {"v": 1})
        c._jitter = 0.1
        assert await c.get_tick_aware(("k",), self._Tracker(5.0)) == {"v": 1}

    @pytest.mark.asyncio
    async def test_miss_when_remaining_le_jitter(self):
        c = _Cache()
        await c.set(("k",), {"v": 1})
        c._jitter = 0.5
        assert await c.get_tick_aware(("k",), self._Tracker(0.1)) is None

    @pytest.mark.asyncio
    async def test_age_zero_when_mono_ts_unset(self):
        # _mono_ts == 0.0 → age branch takes the 0.0 path (no monotonic delta).
        c = _Cache()
        c._key = ("k",)
        c._data = {"v": 1}
        c._mono_ts = 0.0
        c._jitter = 0.0
        tracker = MagicMock()
        tracker.cache_expiry_seconds.return_value = 5.0
        assert await c.get_tick_aware(("k",), tracker) == {"v": 1}
        # age passed as 0.0 exactly.
        assert tracker.cache_expiry_seconds.call_args.args[0] == 0.0


async def _ok_fetch():
    return {"data": "fresh"}


class TestCachedSingleflight:
    def _args(self, cache, key, fetch_fn, ttl=100):
        return {
            "cache": cache,
            "lock": asyncio.Lock(),
            "inflight": {},
            "key": key,
            "ttl": ttl,
            "evict_at": 100,
            "evict_keep": 10,
            "fetch_fn": fetch_fn,
        }

    @pytest.mark.asyncio
    async def test_cache_hit_within_ttl(self):
        import time as _t

        cache = {"k": (_t.time(), {"cached": True})}
        out = await cached_singleflight(**self._args(cache, "k", _ok_fetch))
        assert out == {"cached": True}

    @pytest.mark.asyncio
    async def test_cache_stale_refetches(self, monkeypatch):
        cache = {"k": (0.0, {"cached": "old"})}  # ts=0 → very stale
        out = await cached_singleflight(**self._args(cache, "k", _ok_fetch, ttl=1))
        assert out == {"data": "fresh"}
        assert cache["k"][1] == {"data": "fresh"}

    @pytest.mark.asyncio
    async def test_fetch_error_not_cached(self):
        async def err_fetch():
            return {"error": "upstream"}

        cache = {}
        out = await cached_singleflight(**self._args(cache, "k", err_fetch))
        assert out == {"error": "upstream"}
        assert "k" not in cache

    @pytest.mark.asyncio
    async def test_eviction_trims_to_keep(self):
        # Pre-fill cache past evict_at so the write triggers eviction.
        cache = {f"old{i}": (float(i), {"i": i}) for i in range(5)}
        args = self._args(cache, "new", _ok_fetch)
        args["evict_at"] = 4
        args["evict_keep"] = 2
        out = await cached_singleflight(**args)
        assert out == {"data": "fresh"}
        # 2 oldest evicted (old0, old1).
        assert "old0" not in cache
        assert "old1" not in cache
        assert "new" in cache

    @pytest.mark.asyncio
    async def test_singleflight_piggyback_shares_result(self):
        inflight: dict = {}
        cache: dict = {}
        lock = asyncio.Lock()
        started = asyncio.Event()
        release = asyncio.Event()
        calls = [0]

        async def slow_fetch():
            calls[0] += 1
            started.set()
            await release.wait()
            return {"data": "shared"}

        common = {
            "cache": cache,
            "lock": lock,
            "inflight": inflight,
            "key": "k",
            "ttl": 100,
            "evict_at": 100,
            "evict_keep": 10,
            "fetch_fn": slow_fetch,
        }
        t1 = asyncio.create_task(cached_singleflight(**common))
        await started.wait()
        # Second caller finds the inflight future and piggybacks.
        t2 = asyncio.create_task(cached_singleflight(**common))
        await asyncio.sleep(0.01)
        release.set()
        r1, r2 = await asyncio.gather(t1, t2)
        assert r1 == r2 == {"data": "shared"}
        assert calls[0] == 1  # only the originator fetched

    @pytest.mark.asyncio
    async def test_piggybacker_falls_through_on_originator_error(self):
        inflight: dict = {}
        cache: dict = {}
        lock = asyncio.Lock()
        started = asyncio.Event()
        release = asyncio.Event()

        async def failing_originator():
            started.set()
            await release.wait()
            raise RuntimeError("originator boom")

        async def good_piggy():
            return {"data": "piggy-own"}

        orig_args = {
            "cache": cache,
            "lock": lock,
            "inflight": inflight,
            "key": "k",
            "ttl": 100,
            "evict_at": 100,
            "evict_keep": 10,
            "fetch_fn": failing_originator,
        }
        t1 = asyncio.create_task(cached_singleflight(**orig_args))
        await started.wait()
        piggy_args = dict(orig_args)
        piggy_args["fetch_fn"] = good_piggy
        t2 = asyncio.create_task(cached_singleflight(**piggy_args))
        await asyncio.sleep(0.01)
        release.set()
        # Originator raises; piggybacker falls through to its own fetch.
        results = await asyncio.gather(t1, t2, return_exceptions=True)
        assert isinstance(results[0], RuntimeError)
        assert results[1] == {"data": "piggy-own"}

    @pytest.mark.asyncio
    async def test_originator_exception_reraised_and_cleaned(self):
        inflight: dict = {}

        async def boom():
            raise ValueError("fetch failed")

        with pytest.raises(ValueError, match="fetch failed"):
            await cached_singleflight(
                cache={},
                lock=asyncio.Lock(),
                inflight=inflight,
                key="k",
                ttl=100,
                evict_at=100,
                evict_keep=10,
                fetch_fn=boom,
            )
        # Future cleaned up on the error path (identity-compare pop).
        assert "k" not in inflight

    @pytest.mark.asyncio
    async def test_originator_cancelled_propagates_to_piggyback(self):
        inflight: dict = {}
        cache: dict = {}
        lock = asyncio.Lock()
        started = asyncio.Event()

        async def hang():
            started.set()
            await asyncio.sleep(3600)
            return {"never": True}  # pragma: no cover  # cancelled before return

        common = {
            "cache": cache,
            "lock": lock,
            "inflight": inflight,
            "key": "k",
            "ttl": 100,
            "evict_at": 100,
            "evict_keep": 10,
            "fetch_fn": hang,
        }
        t1 = asyncio.create_task(cached_singleflight(**common))
        await started.wait()
        t2 = asyncio.create_task(cached_singleflight(**common))
        await asyncio.sleep(0.01)
        # Cancel the originator mid-flight; its cancel propagates to the future,
        # and the shielded piggybacker re-raises CancelledError.
        t1.cancel()
        with pytest.raises(asyncio.CancelledError):
            await t1
        with pytest.raises(asyncio.CancelledError):
            await t2

    @pytest.mark.asyncio
    async def test_identity_compare_skips_pop_of_replacement(self):
        # After the originator errors, if a racing coroutine installed a NEW
        # future under the same key, the finally block must NOT pop it.
        inflight: dict = {}
        replacement = asyncio.get_event_loop().create_future()
        replacement.set_result({"data": "replacement"})

        async def boom_then_replace():
            # Simulate a racing owner swapping in a fresh future before our
            # finally runs.
            inflight["k"] = replacement
            raise RuntimeError("boom")

        with pytest.raises(RuntimeError):
            await cached_singleflight(
                cache={},
                lock=asyncio.Lock(),
                inflight=inflight,
                key="k",
                ttl=100,
                evict_at=100,
                evict_keep=10,
                fetch_fn=boom_then_replace,
            )
        # Replacement future survives — identity-compare prevented eviction.
        assert inflight.get("k") is replacement

    @pytest.mark.asyncio
    async def test_success_skips_set_when_future_already_done(self):
        # Defensive `if not fut.done()` on the success path: if the shared
        # future is already resolved (fetch_fn reached it via inflight[key]),
        # the second set_result must be skipped, not raise InvalidStateError.
        inflight: dict = {}

        async def fetch_and_resolve():
            inflight["k"].set_result({"data": "pre-set"})
            return {"data": "fresh"}

        out = await cached_singleflight(
            cache={},
            lock=asyncio.Lock(),
            inflight=inflight,
            key="k",
            ttl=100,
            evict_at=100,
            evict_keep=10,
            fetch_fn=fetch_and_resolve,
        )
        # Returns its own `out` regardless of the pre-set future value.
        assert out == {"data": "fresh"}

    @pytest.mark.asyncio
    async def test_exception_skips_set_when_future_already_done(self):
        # Defensive `if not fut.done()` on the error path.
        inflight: dict = {}

        async def resolve_then_raise():
            inflight["k"].set_result({"data": "pre-set"})
            raise ValueError("boom after resolve")

        with pytest.raises(ValueError, match="boom after resolve"):
            await cached_singleflight(
                cache={},
                lock=asyncio.Lock(),
                inflight=inflight,
                key="k",
                ttl=100,
                evict_at=100,
                evict_keep=10,
                fetch_fn=resolve_then_raise,
            )

    @pytest.mark.asyncio
    async def test_cancel_skips_cancel_when_future_already_done(self):
        # Defensive `if not fut.done()` on the cancellation path: the future is
        # already resolved when CancelledError propagates, so fut.cancel() is
        # skipped.
        inflight: dict = {}

        async def resolve_then_cancel():
            inflight["k"].set_result({"data": "pre-set"})
            raise asyncio.CancelledError

        with pytest.raises(asyncio.CancelledError):
            await cached_singleflight(
                cache={},
                lock=asyncio.Lock(),
                inflight=inflight,
                key="k",
                ttl=100,
                evict_at=100,
                evict_keep=10,
                fetch_fn=resolve_then_cancel,
            )
