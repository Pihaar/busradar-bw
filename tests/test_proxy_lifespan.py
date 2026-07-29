"""Branch coverage for proxy.py paths the endpoint/unit suites don't reach:
lifespan startup/shutdown, the stops-rebuild wrappers, _discover_platforms,
_read_version's OSError arm, and the per-IP 429 rate-limit branches on the
REST endpoints.

Deterministic: heavy background tasks and HAFAS calls are stubbed, asyncio.sleep
is faked (no wall-clock waits), datetime.now is pinned where the schedule math
needs a fixed clock.
"""

from __future__ import annotations

import asyncio
import datetime as _dt

import pytest
from httpx import ASGITransport, AsyncClient

import proxy
import sse_handler


@pytest.fixture
async def client():
    transport = ASGITransport(app=proxy.app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


# === _read_version OSError arm (149-150) ===


class TestReadVersionOSError:
    def test_vfile_read_bytes_oserror_falls_through(self, tmp_path, monkeypatch):
        from pathlib import Path

        monkeypatch.setattr(proxy, "__file__", str(tmp_path / "proxy.py"))
        vfile = tmp_path / "VERSION"
        vfile.write_text("v1.0.0")

        orig_read_bytes = Path.read_bytes

        def boom(self, *a, **k):
            if self.name == "VERSION":
                raise OSError("disk gone")
            return orig_read_bytes(self, *a, **k)

        monkeypatch.setattr(Path, "read_bytes", boom)
        # No git in a scratch dir → falls through to "unknown".
        monkeypatch.setattr(proxy.shutil, "which", lambda _: None)
        assert proxy._read_version() == "unknown"


# === _discover_platforms (491-551) ===


class TestDiscoverPlatforms:
    class _App:
        pass

    class _Req:
        def __init__(self):
            self.app = TestDiscoverPlatforms._App()

    @pytest.mark.asyncio
    async def test_full_branch_sweep(self, monkeypatch):
        calls = []

        async def fake(app, method, req):
            calls.append(req["type"])
            if req["type"] == "ARR":
                return {"error": "upstream"}  # the `continue` arm (502-503)
            return {
                "common": {
                    "locL": [
                        {
                            "extId": "1",
                            "name": "P1",
                            "lid": "L1",
                            "crd": {"x": 8660000, "y": 49340000},
                            "gidL": ["b×de:1", "A×a:b:c:d:Gleis 5"],
                        },
                        {  # duplicate extId → seen-skip (519-521)
                            "extId": "1",
                            "name": "dup",
                            "lid": "L1",
                            "crd": {"x": 1, "y": 1},
                        },
                        {  # zero crd → skip (523-525)
                            "extId": "2",
                            "name": "nocrd",
                            "lid": "L2",
                            "crd": {"x": 0, "y": 0},
                        },
                        {  # no physical b× gid → skip (527-530)
                            "extId": "3",
                            "name": "nophys",
                            "lid": "L3",
                            "crd": {"x": 8, "y": 49},
                            "gidL": ["A×only"],
                        },
                    ]
                },
                "jnyL": [
                    {"stbStop": {"locX": 0}},
                    {"stbStop": {"locX": 1}},
                    {"stbStop": {"locX": 2}},
                    {"stbStop": {"locX": 3}},
                    {"stbStop": {"locX": 99}},  # out-of-range → skip (515-516)
                    {"stbStop": {}},  # no locX → not added to used set (511-512 false)
                ],
            }

        monkeypatch.setattr(proxy, "_hafas_call_via_app", fake)
        out = await proxy._discover_platforms(self._Req(), "A=1@L=1@")
        assert calls == ["DEP", "ARR"]
        assert len(out) == 1
        assert out[0] == {
            "name": "P1",
            "lid": "L1",
            "lat": pytest.approx(49.34, abs=1e-6),
            "lon": pytest.approx(8.66, abs=1e-6),
            "extId": "1",
            "platform": "Gleis 5",
        }

    @pytest.mark.asyncio
    async def test_physical_stop_without_platform_gid(self, monkeypatch):
        # has b× (physical) but no A× → platform stays "" (533-538 A× branch False).
        async def fake(app, method, req):
            if req["type"] == "ARR":
                return {"error": "x"}
            return {
                "common": {
                    "locL": [
                        {
                            "extId": "9",
                            "name": "NoPlat",
                            "lid": "L9",
                            "crd": {"x": 8660000, "y": 49340000},
                            "gidL": ["b×de:9"],
                        }
                    ]
                },
                "jnyL": [{"stbStop": {"locX": 0}}],
            }

        monkeypatch.setattr(proxy, "_hafas_call_via_app", fake)
        out = await proxy._discover_platforms(self._Req(), "A=1@L=1@")
        assert out[0]["platform"] == ""

    @pytest.mark.asyncio
    async def test_physical_stop_short_platform_gid_breaks(self, monkeypatch):
        # b× present (physical) AND an A× gid with < 5 colon-parts → the inner
        # `if len(parts) >= 5` guard is False but the loop still `break`s
        # (536->538 arc), leaving platform "".
        async def fake(app, method, req):
            if req["type"] == "ARR":
                return {"error": "x"}
            return {
                "common": {
                    "locL": [
                        {
                            "extId": "8",
                            "name": "ShortGid",
                            "lid": "L8",
                            "crd": {"x": 8660000, "y": 49340000},
                            "gidL": ["b×de:8", "A×a:b:c"],
                        }
                    ]
                },
                "jnyL": [{"stbStop": {"locX": 0}}],
            }

        monkeypatch.setattr(proxy, "_hafas_call_via_app", fake)
        out = await proxy._discover_platforms(self._Req(), "A=1@L=1@")
        assert out[0]["platform"] == ""


# === _flatten_vehicles residual branches (415, 441->439, 451-454) ===


class TestFlattenVehiclesResidualBranches:
    def test_delay_over_720_wraps_backwards(self):
        # plan just after midnight, real just before → +1439 → -1 after wrap.
        assert proxy._calc_delay({"dTimeS": "000100", "dTimeR": "235800"}) == -3

    def test_platform_parsed_and_later_stop_delay_wins(self):
        res = {
            "common": {
                "prodL": [{"name": "Bus 721", "nameS": "721"}],
                "locL": [
                    {
                        "name": "S",
                        "lid": "A=1@L=1@",
                        "crd": {"x": 8660000, "y": 49340000},
                        "extId": "1",
                        "gidL": ["A×a:b:c:d:Gleis 3"],
                    }
                ],
            },
            "jnyL": [
                {
                    "jid": "j",
                    "prodX": 0,
                    "pos": {"x": 8661000, "y": 49341000},
                    # first stop no realtime (delay None → 441->439 stays None),
                    # second stop has realtime → delay set.
                    "stopL": [
                        {"locX": 0},
                        {"locX": 0, "dTimeS": "120000", "dTimeR": "120300"},
                    ],
                }
            ],
        }
        v = proxy._flatten_vehicles(res)
        assert v[0]["stops"][0]["platform"] == "Gleis 3"
        assert v[0]["delay"] == 3

    def test_platform_gid_too_short_no_platform(self):
        # A× gid with < 5 colon-parts → platform not set (452 guard False).
        res = {
            "common": {
                "prodL": [{"name": "X"}],
                "locL": [
                    {
                        "name": "S",
                        "crd": {"x": 8660000, "y": 49340000},
                        "gidL": ["A×a:b"],
                    }
                ],
            },
            "jnyL": [
                {
                    "jid": "j",
                    "prodX": 0,
                    "pos": {"x": 8661000, "y": 49341000},
                    "stopL": [{"locX": 0}],
                }
            ],
        }
        v = proxy._flatten_vehicles(res)
        assert v[0]["stops"][0]["platform"] == ""


# === REST endpoint per-IP 429 (628-632, 691-696, 758-762) ===


class TestRestRateLimit429:
    @pytest.fixture(autouse=True)
    def _clear(self):
        sse_handler._post_rate_per_ip.clear()
        yield
        sse_handler._post_rate_per_ip.clear()

    @pytest.mark.asyncio
    async def test_journey_429_when_ip_bucket_empty(self, client, monkeypatch):
        monkeypatch.setattr(proxy, "_rate_check_request", lambda request, sub=None: False)
        resp = await client.post("/api/journey", json={"jid": "1|12345|0|80|22052026"})
        assert resp.status_code == 429
        assert resp.json() == {"error": "rate_limit", "scope": "ip"}
        assert resp.headers["retry-after"] == "1"

    @pytest.mark.asyncio
    async def test_stationboard_429_when_ip_bucket_empty(self, client, monkeypatch):
        monkeypatch.setattr(proxy, "_rate_check_request", lambda request, sub=None: False)
        resp = await client.post(
            "/api/stationboard", json={"lid": "A=1@L=6003411@", "type": "DEP", "dur": 60}
        )
        assert resp.status_code == 429
        assert resp.json()["scope"] == "ip"

    @pytest.mark.asyncio
    async def test_line_search_429_when_ip_bucket_empty(self, client, monkeypatch):
        monkeypatch.setattr(proxy, "_rate_check_request", lambda request, sub=None: False)
        resp = await client.get("/api/line_search?q=721")
        assert resp.status_code == 429
        assert resp.json()["scope"] == "ip"


# === /api/journey and /api/stationboard cache-hit (636, 700-701) ===


class TestRestCacheHit:
    @pytest.fixture(autouse=True)
    def _clear(self):
        proxy._journey_cache.clear()
        proxy._stationboard_cache.clear()
        sse_handler._post_rate_per_ip.clear()
        yield
        proxy._journey_cache.clear()
        proxy._stationboard_cache.clear()
        sse_handler._post_rate_per_ip.clear()

    @pytest.mark.asyncio
    async def test_journey_cache_hit_short_circuits(self, client, monkeypatch):
        calls = {"n": 0}

        async def fake(app, method, req):
            calls["n"] += 1
            return {"journey": {"jid": req["jid"]}}

        monkeypatch.setattr(proxy, "_hafas_call_via_app", fake)
        jid = "1|55555|0|80|22052026"
        r1 = await client.post("/api/journey", json={"jid": jid})
        r2 = await client.post("/api/journey", json={"jid": jid})
        assert r1.status_code == 200
        assert r2.status_code == 200
        assert calls["n"] == 1  # second served from cache


# === line_search cache hit (766-767) ===


class TestLineSearchCacheHit:
    @pytest.fixture(autouse=True)
    def _clear(self):
        proxy._line_search_cache.clear()
        sse_handler._post_rate_per_ip.clear()
        yield
        proxy._line_search_cache.clear()
        sse_handler._post_rate_per_ip.clear()

    @pytest.mark.asyncio
    async def test_second_query_uses_cache_and_dedups_jids(self, client, monkeypatch):
        calls = {"n": 0}

        VEH = {
            "common": {
                "prodL": [{"name": "Bus 721", "nameS": "721"}],
                "locL": [],
            },
            "jnyL": [
                {"jid": "dup", "prodX": 0, "pos": {"x": 8661000, "y": 49341000}, "stopL": []},
                {"jid": "dup", "prodX": 0, "pos": {"x": 8662000, "y": 49342000}, "stopL": []},
            ],
        }

        async def fake(app, method, req):
            calls["n"] += 1
            return VEH

        monkeypatch.setattr(proxy, "_hafas_call_via_app", fake)
        r1 = await client.get("/api/line_search?q=721")
        r2 = await client.get("/api/line_search?q=721")
        assert calls["n"] == 1  # r2 hit the cache (766-767)
        # duplicate jid collapsed (789 continue)
        assert r1.json()["count"] == 1
        assert r2.json()["count"] == 1


# === lifespan (205-293) ===


def _stub_background(monkeypatch):
    async def never(*a, **k):
        await asyncio.sleep(3600)

    monkeypatch.setattr(proxy, "tick_calibrator", never)
    monkeypatch.setattr(proxy, "sse_push_loop", never)
    monkeypatch.setattr(proxy, "schedule_daily_rebuild_wrapper", never)

    async def quick_build(app):
        app.state.stops_data = {"stops": [], "count": 0}

    monkeypatch.setattr(proxy, "_build_stops_on_startup", quick_build)


class TestLifespan:
    @pytest.mark.asyncio
    async def test_startup_with_cached_stale_triggers_bg_refresh(self, monkeypatch):
        import stops_builder

        _stub_background(monkeypatch)
        monkeypatch.setattr(stops_builder, "load_stops_cache", lambda: {"stops": [], "count": 7})
        monkeypatch.setattr(stops_builder, "is_stops_cache_stale", lambda c: True)
        monkeypatch.delenv("BUSRADAR_SKIP_STOPS_REBUILD", raising=False)
        monkeypatch.setenv("WEB_CONCURRENCY", "1")

        async with proxy.app.router.lifespan_context(proxy.app):
            assert hasattr(proxy.app.state, "client")
            assert proxy.app.state.stops_rebuilding is False
            assert proxy.app.state.stops_data["count"] == 7

    @pytest.mark.asyncio
    async def test_startup_missing_cache_builds(self, monkeypatch):
        import stops_builder

        _stub_background(monkeypatch)
        monkeypatch.setattr(stops_builder, "load_stops_cache", lambda: None)
        monkeypatch.setattr(stops_builder, "is_stops_cache_stale", lambda c: False)
        monkeypatch.delenv("BUSRADAR_SKIP_STOPS_REBUILD", raising=False)

        async with proxy.app.router.lifespan_context(proxy.app):
            assert proxy.app.state.stops_data["count"] == 0

    @pytest.mark.asyncio
    async def test_startup_skip_rebuild_env(self, monkeypatch):
        import stops_builder

        _stub_background(monkeypatch)
        monkeypatch.setattr(stops_builder, "load_stops_cache", lambda: {"stops": [], "count": 3})
        monkeypatch.setattr(stops_builder, "is_stops_cache_stale", lambda c: True)
        monkeypatch.setenv("BUSRADAR_SKIP_STOPS_REBUILD", "1")

        async with proxy.app.router.lifespan_context(proxy.app):
            # cached loaded but no bg refresh scheduled → still count 3
            assert proxy.app.state.stops_data["count"] == 3

    @pytest.mark.asyncio
    async def test_startup_missing_cache_skip_rebuild(self, monkeypatch):
        import stops_builder

        _stub_background(monkeypatch)
        monkeypatch.setattr(stops_builder, "load_stops_cache", lambda: None)
        monkeypatch.setattr(stops_builder, "is_stops_cache_stale", lambda c: False)
        monkeypatch.setenv("BUSRADAR_SKIP_STOPS_REBUILD", "1")

        async with proxy.app.router.lifespan_context(proxy.app):
            assert proxy.app.state.stops_data == {"stops": [], "count": 0}

    @pytest.mark.asyncio
    async def test_web_concurrency_gt_1_warns(self, monkeypatch):
        import stops_builder

        _stub_background(monkeypatch)
        monkeypatch.setattr(stops_builder, "load_stops_cache", lambda: None)
        monkeypatch.setattr(stops_builder, "is_stops_cache_stale", lambda c: False)
        monkeypatch.setenv("WEB_CONCURRENCY", "4")
        monkeypatch.setenv("BUSRADAR_SKIP_STOPS_REBUILD", "1")

        async with proxy.app.router.lifespan_context(proxy.app):
            pass  # the >1 warning branch (214-215) executed

    @pytest.mark.asyncio
    async def test_web_concurrency_invalid_swallowed(self, monkeypatch):
        import stops_builder

        _stub_background(monkeypatch)
        monkeypatch.setattr(stops_builder, "load_stops_cache", lambda: None)
        monkeypatch.setattr(stops_builder, "is_stops_cache_stale", lambda c: False)
        monkeypatch.setenv("WEB_CONCURRENCY", "not-an-int")
        monkeypatch.setenv("BUSRADAR_SKIP_STOPS_REBUILD", "1")

        async with proxy.app.router.lifespan_context(proxy.app):
            pass  # ValueError arm (216-217) executed

    @pytest.mark.asyncio
    async def test_fanout_not_initialized_raises(self, monkeypatch):
        import fanout

        monkeypatch.delattr(fanout, "tick_condition", raising=True)
        with pytest.raises(RuntimeError, match="fanout module not initialized"):
            async with proxy.app.router.lifespan_context(proxy.app):
                pass

    @pytest.mark.asyncio
    async def test_tick_and_push_disabled(self, monkeypatch):
        import stops_builder

        _stub_background(monkeypatch)
        monkeypatch.setattr(stops_builder, "load_stops_cache", lambda: None)
        monkeypatch.setattr(stops_builder, "is_stops_cache_stale", lambda c: False)
        monkeypatch.setenv("BUSRADAR_SKIP_STOPS_REBUILD", "1")
        monkeypatch.setattr(proxy, "_TICK_ENABLED", False)
        monkeypatch.setattr(proxy, "_SSE_PUSH_ENABLED", False)

        async with proxy.app.router.lifespan_context(proxy.app):
            pass  # 257 and 270 both False

    @pytest.mark.asyncio
    async def test_shutdown_task_timeout_logged(self, monkeypatch):
        import stops_builder

        monkeypatch.setattr(stops_builder, "load_stops_cache", lambda: None)
        monkeypatch.setattr(stops_builder, "is_stops_cache_stale", lambda c: False)
        monkeypatch.setenv("BUSRADAR_SKIP_STOPS_REBUILD", "1")
        monkeypatch.setattr(proxy, "_TICK_ENABLED", False)
        monkeypatch.setattr(proxy, "_SSE_PUSH_ENABLED", False)

        # wait_for raises TimeoutError immediately on shutdown, driving the
        # "did not cancel within 5s" arm (288-289) with no wall-clock wait.
        async def timeout_wait_for(aw, timeout=None):
            aw.cancel()  # still cancel the task so it doesn't leak
            raise TimeoutError

        monkeypatch.setattr(proxy.asyncio, "wait_for", timeout_wait_for)

        async with proxy.app.router.lifespan_context(proxy.app):
            pass  # TimeoutError arm (288-289) executed

    @pytest.mark.asyncio
    async def test_shutdown_task_exception_logged(self, monkeypatch):
        import stops_builder

        monkeypatch.setattr(stops_builder, "load_stops_cache", lambda: None)
        monkeypatch.setattr(stops_builder, "is_stops_cache_stale", lambda c: False)
        monkeypatch.setenv("BUSRADAR_SKIP_STOPS_REBUILD", "1")
        monkeypatch.setattr(proxy, "_TICK_ENABLED", False)
        monkeypatch.setattr(proxy, "_SSE_PUSH_ENABLED", False)

        async def raiser(*a, **k):
            try:
                await asyncio.sleep(3600)
            except asyncio.CancelledError:
                raise RuntimeError("shutdown bug") from None

        monkeypatch.setattr(proxy, "schedule_daily_rebuild_wrapper", raiser)

        async with proxy.app.router.lifespan_context(proxy.app):
            # Yield so the raiser task reaches its `await asyncio.sleep`; only a
            # parked task raises from inside the except-CancelledError arm on
            # shutdown, exercising the Exception arm (290-291).
            await asyncio.sleep(0.02)


# === _build_stops_on_startup (296-312) ===


class TestBuildStopsOnStartup:
    @pytest.mark.asyncio
    async def test_success_sets_data(self, monkeypatch):
        import stops_builder

        async def fake_build():
            return {"stops": [1, 2], "count": 2}

        monkeypatch.setattr(stops_builder, "build_stops_cache", fake_build)

        class _App:
            class state:
                pass

        app = _App()
        await proxy._build_stops_on_startup(app)
        assert app.state.stops_data == {"stops": [1, 2], "count": 2}
        assert app.state.stops_rebuilding is False

    @pytest.mark.asyncio
    async def test_failure_resets_flag(self, monkeypatch):
        import stops_builder

        async def boom():
            raise RuntimeError("build failed")

        monkeypatch.setattr(stops_builder, "build_stops_cache", boom)

        class _App:
            class state:
                pass

        app = _App()
        await proxy._build_stops_on_startup(app)
        assert app.state.stops_rebuilding is False


# === schedule_daily_rebuild_wrapper (315-343) ===


class TestScheduleDailyRebuild:
    async def _run_one_iteration(self, monkeypatch, build_fn, now_hour):
        """Drive exactly one loop iteration: fake sleep returns once, then
        raises CancelledError to break the while True."""
        import stops_builder

        monkeypatch.setattr(stops_builder, "build_stops_cache", build_fn)

        class FakeDateTime(_dt.datetime):
            @classmethod
            def now(cls, tz=None):  # noqa: ARG003  # match datetime.now signature
                return cls(2026, 7, 29, now_hour, 0, 0)

        monkeypatch.setattr(_dt, "datetime", FakeDateTime)

        sleeps = {"n": 0}

        async def fake_sleep(secs):
            sleeps["n"] += 1
            if sleeps["n"] >= 2:
                raise asyncio.CancelledError

        monkeypatch.setattr(proxy.asyncio, "sleep", fake_sleep)

        class _App:
            class state:
                pass

        app = _App()
        task = asyncio.create_task(proxy.schedule_daily_rebuild_wrapper(app))
        with pytest.raises(asyncio.CancelledError):
            await task
        return app

    @pytest.mark.asyncio
    async def test_before_3am_schedules_today_and_builds(self, monkeypatch):
        async def fake_build():
            return {"stops": [1], "count": 1}

        # now_hour=1 (<3) → next_run today, now < next_run → no +1 day (325 False)
        app = await self._run_one_iteration(monkeypatch, fake_build, now_hour=1)
        assert app.state.stops_data == {"stops": [1], "count": 1}
        assert app.state.stops_rebuilding is False

    @pytest.mark.asyncio
    async def test_after_3am_schedules_next_day(self, monkeypatch):
        async def fake_build():
            return {"stops": [], "count": 0}

        # now_hour=5 (>=3) → now >= next_run → +1 day (325-326 True)
        app = await self._run_one_iteration(monkeypatch, fake_build, now_hour=5)
        assert app.state.stops_rebuilding is False

    @pytest.mark.asyncio
    async def test_build_failure_resets_flag(self, monkeypatch):
        async def boom():
            raise RuntimeError("daily build failed")

        app = await self._run_one_iteration(monkeypatch, boom, now_hour=1)
        assert app.state.stops_rebuilding is False


# === /api/health with TICK disabled (743->748 arc) ===


class TestHealthTickDisabled:
    @pytest.mark.asyncio
    async def test_health_omits_tick_fields_when_disabled(self, client, monkeypatch):
        monkeypatch.setattr(proxy, "_TICK_ENABLED", False)
        resp = await client.get("/api/health")
        assert resp.status_code == 200
        data = resp.json()
        # The `if _TICK_ENABLED:` block is skipped → these keys are absent.
        assert "tick_known" not in data
        assert "calibrator_mode" not in data

    @pytest.mark.asyncio
    async def test_health_includes_tick_fields_with_no_tick_seen(self, client, monkeypatch):
        # _TICK_ENABLED True but last_tick_ts falsy → tick_age None branch.
        monkeypatch.setattr(proxy, "_TICK_ENABLED", True)
        monkeypatch.setattr(proxy.tick_tracker, "last_tick_ts", 0.0)
        resp = await client.get("/api/health")
        data = resp.json()
        assert data["tick_known"] is False
        assert data["tick_age_s"] is None


# === StationBoardRequest dur validator (678) ===


class TestStationBoardDurValidator:
    def test_non_multiple_of_60_rejected(self):
        from pydantic import ValidationError

        from proxy import StationBoardRequest

        with pytest.raises(ValidationError):
            StationBoardRequest(lid="A=1@L=6003411@", dur=90)

    def test_multiple_of_60_accepted(self):
        from proxy import StationBoardRequest

        assert StationBoardRequest(lid="A=1@L=6003411@", dur=120).dur == 120


# === module-load unknown-version warning (893) ===


class TestUnknownVersionStartupWarning:
    def test_fresh_import_with_unknown_version_warns(self, monkeypatch):
        """Re-import proxy under a forged environment where neither VERSION file
        nor `git describe` yields a version → _VERSION == 'unknown' → the
        module-level startup warning (line 893) fires."""
        import importlib.util
        import logging
        import pathlib
        import shutil

        seen: list[str] = []

        class _Capture(logging.Handler):
            def emit(self, record):
                seen.append(record.getMessage())

        handler = _Capture()
        logging.getLogger("busradar").addHandler(handler)

        monkeypatch.setattr(shutil, "which", lambda _: None)
        monkeypatch.setattr(pathlib.Path, "exists", lambda self: False)
        try:
            spec = importlib.util.spec_from_file_location("proxy_unknown_probe", proxy.__file__)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            assert mod._VERSION == "unknown"
        finally:
            logging.getLogger("busradar").removeHandler(handler)
        assert any("SW cache name will not rotate" in m for m in seen)


# === Generic exception handler (355-361) ===


class TestGenericExceptionHandler:
    @pytest.mark.asyncio
    async def test_unhandled_exception_returns_sanitized_500(self, monkeypatch):
        async def boom(app, method, req):
            raise RuntimeError("internal-secret-detail")

        monkeypatch.setattr(proxy, "_hafas_call_via_app", boom)
        proxy._journey_cache.clear()
        sse_handler._post_rate_per_ip.clear()
        # raise_app_exceptions=False so the ASGI transport lets the app's own
        # exception handler produce the response instead of re-raising.
        transport = ASGITransport(app=proxy.app, raise_app_exceptions=False)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.post("/api/journey", json={"jid": "1|12345|0|80|22052026"})
        assert resp.status_code == 500
        assert resp.json() == {"error": "internal"}
        # Sanitized: the internal detail never reaches the wire (SEC-236).
        assert "internal-secret-detail" not in resp.text
        proxy._journey_cache.clear()
        sse_handler._post_rate_per_ip.clear()


# === REST cache eviction (654-656 journey, 718-720 stationboard) ===


class TestRestCacheEviction:
    @pytest.fixture(autouse=True)
    def _clear(self):
        proxy._journey_cache.clear()
        proxy._stationboard_cache.clear()
        sse_handler._post_rate_per_ip.clear()
        yield
        proxy._journey_cache.clear()
        proxy._stationboard_cache.clear()
        sse_handler._post_rate_per_ip.clear()

    @pytest.mark.asyncio
    async def test_journey_cache_evicts_over_200(self, client, monkeypatch):
        async def fake(app, method, req):
            return {"journey": {"jid": req.get("jid")}}

        monkeypatch.setattr(proxy, "_hafas_call_via_app", fake)
        # Pre-fill above the 200 cap with stale entries (old timestamps so the
        # write below doesn't hit the cache-read short-circuit).
        for i in range(205):
            proxy._journey_cache[f"stale{i}"] = (1.0, {"x": i})
        resp = await client.post("/api/journey", json={"jid": "1|99999|0|80|22052026"})
        assert resp.status_code == 200
        # 205 pre-filled + 1 new = 206 > 200 → trims the oldest 100.
        assert len(proxy._journey_cache) <= 200

    @pytest.mark.asyncio
    async def test_stationboard_cache_evicts_over_500(self, client, monkeypatch):
        async def fake(app, method, req):
            return {"jnyL": []}

        monkeypatch.setattr(proxy, "_hafas_call_via_app", fake)
        for i in range(505):
            proxy._stationboard_cache[("stale", i, 60)] = (1.0, {"x": i})
        resp = await client.post(
            "/api/stationboard", json={"lid": "A=1@L=6003411@", "type": "DEP", "dur": 60}
        )
        assert resp.status_code == 200
        assert len(proxy._stationboard_cache) <= 500
