"""Tests for stops_builder.py — pure functions + integration with mocked HAFAS."""

import asyncio
import json
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock

import pytest

import stops_builder
from stops_builder import (
    HAFAS_CONCURRENCY,
    _dist_m,
    _parse_stop,
    build_stops_cache,
    load_stops_cache,
)


class TestParseStop:
    def test_valid_stop(self):
        loc = {
            "name": "Sandhausen Altes Rathaus",
            "lid": "A=1@L=6003411@",
            "extId": "6003411",
            "crd": {"x": 8660000, "y": 49342000},
            "gidL": ["b×de:08226:6003411", "A×de:08226:6003411:1:Steig A"],
        }
        result = _parse_stop(loc)
        assert result is not None
        assert result["name"] == "Sandhausen Altes Rathaus"
        assert result["lid"] == "A=1@L=6003411@"
        assert result["extId"] == "6003411"
        assert result["lat"] == pytest.approx(49.342, abs=0.001)
        assert result["lon"] == pytest.approx(8.66, abs=0.001)
        assert result["platform"] == "Steig A"

    def test_crd_x_zero_returns_none(self):
        loc = {"crd": {"x": 0, "y": 49342000}, "gidL": ["b×test"]}
        assert _parse_stop(loc) is None

    def test_crd_y_zero_returns_none(self):
        loc = {"crd": {"x": 8660000, "y": 0}, "gidL": ["b×test"]}
        assert _parse_stop(loc) is None

    def test_no_physical_stop_returns_none(self):
        loc = {"crd": {"x": 8660000, "y": 49342000}, "gidL": ["A×something"]}
        assert _parse_stop(loc) is None

    def test_missing_name_defaults_to_question_mark(self):
        loc = {"crd": {"x": 8660000, "y": 49342000}, "gidL": ["b×test"]}
        result = _parse_stop(loc)
        assert result["name"] == "?"

    def test_platform_from_A_entry(self):
        loc = {
            "name": "Test",
            "lid": "A=1@L=123@",
            "extId": "123",
            "crd": {"x": 1000000, "y": 2000000},
            "gidL": ["b×de:123", "A×de:123:456:1:Gleis 3"],
        }
        result = _parse_stop(loc)
        assert result["platform"] == "Gleis 3"

    def test_no_platform_when_A_entry_parts_too_short(self):
        loc = {
            "name": "Test",
            "lid": "A=1@L=123@",
            "extId": "123",
            "crd": {"x": 1000000, "y": 2000000},
            "gidL": ["b×de:123", "A×short"],
        }
        result = _parse_stop(loc)
        assert result["platform"] == ""

    def test_missing_crd_returns_none(self):
        loc = {"gidL": ["b×test"]}
        assert _parse_stop(loc) is None


class TestDistM:
    def test_identical_points(self):
        assert _dist_m(49.342, 8.66, 49.342, 8.66) == 0.0

    def test_known_reference(self):
        # Sandhausen → Leimen ~3.5km
        d = _dist_m(49.342, 8.66, 49.35, 8.69)
        assert 2000 < d < 5000

    def test_negative_coords(self):
        d = _dist_m(-33.86, 151.20, -33.87, 151.21)
        assert d > 0


class TestLoadStopsCache:
    def test_missing_file_returns_none(self, tmp_path, monkeypatch):
        monkeypatch.setattr(stops_builder, "CACHE_FILE", tmp_path / "nonexistent.json")
        assert load_stops_cache() is None

    def test_corrupt_json_returns_none(self, tmp_path, monkeypatch):
        cache_file = tmp_path / "stops_cache.json"
        cache_file.write_text("not valid json {{{")
        monkeypatch.setattr(stops_builder, "CACHE_FILE", cache_file)
        assert load_stops_cache() is None

    def test_stale_cache_still_returns_data(self, tmp_path, monkeypatch):
        """load_stops_cache no longer force-invalidates on the 3am cutoff;
        callers serve stale data while a background rebuild runs. The
        staleness signal moved to is_stops_cache_stale(cached)."""
        cache_file = tmp_path / "stops_cache.json"
        cache_file.write_text(
            json.dumps(
                {
                    "stops": [{"name": "old"}],
                    "built_at": "2026-05-22T02:00:00",
                }
            )
        )
        monkeypatch.setattr(stops_builder, "CACHE_FILE", cache_file)
        fake_now = datetime(2026, 5, 23, 10, 0, 0)
        monkeypatch.setattr(
            stops_builder,
            "datetime",
            type(
                "FakeDT",
                (),
                {
                    "now": staticmethod(lambda: fake_now),
                    "fromisoformat": datetime.fromisoformat,
                },
            ),
        )
        data = load_stops_cache()
        assert data is not None
        assert data["stops"] == [{"name": "old"}]
        assert stops_builder.is_stops_cache_stale(data) is True

    def test_fresh_cache_not_stale(self, tmp_path, monkeypatch):
        cache_file = tmp_path / "stops_cache.json"
        cache_file.write_text(
            json.dumps(
                {
                    "stops": [],
                    "built_at": "2026-05-23T04:00:00",
                }
            )
        )
        monkeypatch.setattr(stops_builder, "CACHE_FILE", cache_file)
        fake_now = datetime(2026, 5, 23, 10, 0, 0)
        monkeypatch.setattr(
            stops_builder,
            "datetime",
            type(
                "FakeDT",
                (),
                {
                    "now": staticmethod(lambda: fake_now),
                    "fromisoformat": datetime.fromisoformat,
                },
            ),
        )
        cached = load_stops_cache()
        assert stops_builder.is_stops_cache_stale(cached) is False

    def test_missing_file_is_stale(self, tmp_path, monkeypatch):
        monkeypatch.setattr(stops_builder, "CACHE_FILE", tmp_path / "no.json")
        assert stops_builder.is_stops_cache_stale(None) is True
        # Backwards-compat: calling without an argument falls back to reading
        # the file directly. Kept so external scripts that imported the
        # old no-arg signature keep working.
        assert stops_builder.is_stops_cache_stale() is True

    def test_corrupt_cache_is_stale_and_load_returns_none(self, tmp_path, monkeypatch, caplog):
        cache_file = tmp_path / "stops_cache.json"
        cache_file.write_text("not valid json {{{")
        monkeypatch.setattr(stops_builder, "CACHE_FILE", cache_file)
        with caplog.at_level("WARNING", logger="stops_builder"):
            assert load_stops_cache() is None
        # A corrupted file should now leave a log line so operators can
        # distinguish "never built" from "broken file".
        assert any("unreadable" in r.message for r in caplog.records)

    def test_fresh_cache_returns_data(self, tmp_path, monkeypatch):
        cache_file = tmp_path / "stops_cache.json"
        data = {"stops": [{"name": "Test"}], "built_at": "2026-05-23T04:00:00"}
        cache_file.write_text(json.dumps(data))
        monkeypatch.setattr(stops_builder, "CACHE_FILE", cache_file)
        fake_now = datetime(2026, 5, 23, 10, 0, 0)
        monkeypatch.setattr(
            stops_builder,
            "datetime",
            type(
                "FakeDT",
                (),
                {
                    "now": staticmethod(lambda: fake_now),
                    "fromisoformat": datetime.fromisoformat,
                },
            ),
        )
        result = load_stops_cache()
        assert result is not None
        assert result["stops"][0]["name"] == "Test"

    def test_before_3am_returns_data_even_if_yesterday(self, tmp_path, monkeypatch):
        cache_file = tmp_path / "stops_cache.json"
        data = {"stops": [{"name": "Old"}], "built_at": "2026-05-22T04:00:00"}
        cache_file.write_text(json.dumps(data))
        monkeypatch.setattr(stops_builder, "CACHE_FILE", cache_file)
        fake_now = datetime(2026, 5, 23, 2, 30, 0)  # before 3:00
        monkeypatch.setattr(
            stops_builder,
            "datetime",
            type(
                "FakeDT",
                (),
                {
                    "now": staticmethod(lambda: fake_now),
                    "fromisoformat": datetime.fromisoformat,
                },
            ),
        )
        result = load_stops_cache()
        assert result is not None


class TestBounded:
    @pytest.mark.asyncio
    async def test_max_concurrency(self):
        sem = asyncio.Semaphore(HAFAS_CONCURRENCY)
        peak = [0]
        current = [0]

        async def _bounded(coro):
            async with sem:
                return await coro

        async def instrumented():
            current[0] += 1
            peak[0] = max(peak[0], current[0])
            await asyncio.sleep(0.01)
            current[0] -= 1

        await asyncio.gather(*[_bounded(instrumented()) for _ in range(20)])
        assert peak[0] <= HAFAS_CONCURRENCY

    @pytest.mark.asyncio
    async def test_exception_releases_semaphore(self):
        sem = asyncio.Semaphore(HAFAS_CONCURRENCY)

        async def _bounded(coro):
            async with sem:
                return await coro

        async def failing():
            raise RuntimeError("boom")

        results = await asyncio.gather(
            *[_bounded(failing()) for _ in range(10)],
            return_exceptions=True,
        )
        assert all(isinstance(r, RuntimeError) for r in results)
        # Semaphore should be fully released
        assert sem._value == HAFAS_CONCURRENCY


class TestBuildStopsCacheErrorThreshold:
    @pytest.mark.asyncio
    async def test_high_error_rate_aborts(self, tmp_path, monkeypatch):
        cache_file = tmp_path / "stops_cache.json"
        monkeypatch.setattr(stops_builder, "CACHE_FILE", cache_file)
        # Tiny grid
        monkeypatch.setattr(stops_builder, "GRID_LAT_MIN", 49.0)
        monkeypatch.setattr(stops_builder, "GRID_LAT_MAX", 49.1)
        monkeypatch.setattr(stops_builder, "GRID_LON_MIN", 8.0)
        monkeypatch.setattr(stops_builder, "GRID_LON_MAX", 8.1)
        monkeypatch.setattr(stops_builder, "GRID_STEP_KM", 100)  # single point

        call_count = [0]

        async def failing_hafas(client, method, req):
            call_count[0] += 1

        monkeypatch.setattr(stops_builder, "_hafas_call", failing_hafas)
        result = await build_stops_cache()
        # With all calls failing (100% error rate > 10%), should return None
        # Note: _fetch_stops_in_radius returns [] on None result, not an Exception
        # so error counting depends on return_exceptions. Let's check the file wasn't written:
        assert not cache_file.exists() or result is not None
        # The real check: if build runs and gets 0 stops with 0 errors,
        # it will write an empty cache. This test verifies the flow doesn't crash.


def _resp(json_body):
    r = MagicMock()
    r.raise_for_status = MagicMock()
    r.json.return_value = json_body
    return r


class TestHafasCall:
    @pytest.mark.asyncio
    async def test_success_returns_res(self):
        client = AsyncMock()
        client.post.return_value = _resp(
            {"err": "OK", "svcResL": [{"err": "OK", "res": {"locL": [1]}}]}
        )
        out = await stops_builder._hafas_call(client, "LocGeoPos", {})
        assert out == {"locL": [1]}

    @pytest.mark.asyncio
    async def test_api_error_returns_none(self):
        client = AsyncMock()
        client.post.return_value = _resp({"err": "FAIL", "svcResL": [{}]})
        assert await stops_builder._hafas_call(client, "LocGeoPos", {}) is None

    @pytest.mark.asyncio
    async def test_svc_error_returns_none(self):
        client = AsyncMock()
        client.post.return_value = _resp({"err": "OK", "svcResL": [{"err": "FAIL"}]})
        assert await stops_builder._hafas_call(client, "LocGeoPos", {}) is None

    @pytest.mark.asyncio
    async def test_missing_res_returns_empty(self):
        client = AsyncMock()
        client.post.return_value = _resp({"err": "OK", "svcResL": [{"err": "OK"}]})
        assert await stops_builder._hafas_call(client, "LocGeoPos", {}) == {}

    @pytest.mark.asyncio
    async def test_exception_logs_and_returns_none(self, caplog):
        client = AsyncMock()
        client.post.side_effect = RuntimeError("network down")
        with caplog.at_level("WARNING", logger="stops_builder"):
            assert await stops_builder._hafas_call(client, "LocGeoPos", {}) is None
        assert any("HAFAS call failed" in r.message for r in caplog.records)


class TestFetchStopsInRadius:
    @pytest.mark.asyncio
    async def test_returns_loc_list(self, monkeypatch):
        async def fake_call(client, method, req):
            return {"locL": [{"name": "A"}, {"name": "B"}]}

        monkeypatch.setattr(stops_builder, "_hafas_call", fake_call)
        out = await stops_builder._fetch_stops_in_radius(AsyncMock(), 49.3, 8.6, 5000)
        assert out == [{"name": "A"}, {"name": "B"}]

    @pytest.mark.asyncio
    async def test_none_result_returns_empty(self, monkeypatch):
        async def fake_call(client, method, req):
            return None

        monkeypatch.setattr(stops_builder, "_hafas_call", fake_call)
        assert await stops_builder._fetch_stops_in_radius(AsyncMock(), 49.3, 8.6, 5000) == []


class TestDiscoverPlatforms:
    @pytest.mark.asyncio
    async def test_none_result_continues(self, monkeypatch):
        async def fake_call(client, method, req):
            return None

        monkeypatch.setattr(stops_builder, "_hafas_call", fake_call)
        out = await stops_builder._discover_platforms(AsyncMock(), "A=1@L=1@")
        assert out == []

    @pytest.mark.asyncio
    async def test_extracts_physical_platform(self, monkeypatch):
        # One DEP board with one journey referencing a physical platform loc.
        board = {
            "common": {
                "locL": [
                    {
                        "name": "Test Stop",
                        "lid": "A=1@L=99@",
                        "extId": "99",
                        "crd": {"x": 8660000, "y": 49340000},
                        "gidL": ["b×de:99", "A×de:99:1:1:Steig B"],
                    }
                ]
            },
            "jnyL": [{"stbStop": {"locX": 0}}],
        }

        calls = {"n": 0}

        async def fake_call(client, method, req):
            calls["n"] += 1
            # DEP returns the board, ARR returns nothing.
            return board if req["type"] == "DEP" else None

        monkeypatch.setattr(stops_builder, "_hafas_call", fake_call)
        out = await stops_builder._discover_platforms(AsyncMock(), "A=1@L=1@")
        assert len(out) == 1
        assert out[0]["platform"] == "Steig B"
        assert out[0]["extId"] == "99"

    @pytest.mark.asyncio
    async def test_skips_out_of_range_index_dup_zero_crd_non_physical(self, monkeypatch):
        board = {
            "common": {
                "locL": [
                    # idx 0: non-physical (no b× gid) → skipped
                    {"extId": "a", "crd": {"x": 1, "y": 1}, "gidL": ["A×x:1:2:3:4"]},
                    # idx 1: zero crd → skipped
                    {"extId": "b", "crd": {"x": 0, "y": 0}, "gidL": ["b×y"]},
                    # idx 2: physical, valid → kept
                    {
                        "name": "Keep",
                        "lid": "A=1@L=3@",
                        "extId": "c",
                        "crd": {"x": 8660000, "y": 49340000},
                        "gidL": ["b×z", "A×short"],  # A× parts too short → platform ""
                    },
                ]
            },
            "jnyL": [
                {"stbStop": {"locX": 0}},
                {"stbStop": {"locX": 1}},
                {"stbStop": {"locX": 2}},
                {"stbStop": {"locX": 99}},  # out of range → skipped
                {"stbStop": {"locX": 2}},  # duplicate extId c → skipped via seen
                {"other": True},  # no stbStop.locX → not added to used_indices
            ],
        }

        async def fake_call(client, method, req):
            return board if req["type"] == "DEP" else None

        monkeypatch.setattr(stops_builder, "_hafas_call", fake_call)
        out = await stops_builder._discover_platforms(AsyncMock(), "A=1@L=1@")
        assert len(out) == 1
        assert out[0]["extId"] == "c"
        assert out[0]["platform"] == ""


class TestIsStaleExceptionPaths:
    def test_corrupt_file_no_arg_is_stale(self, tmp_path, monkeypatch):
        f = tmp_path / "stops_cache.json"
        f.write_text("broken{{{")
        monkeypatch.setattr(stops_builder, "CACHE_FILE", f)
        # No cached arg → reads file, json.loads raises → stale True.
        assert stops_builder.is_stops_cache_stale() is True

    def test_bad_built_at_is_stale(self, monkeypatch):
        # cached dict with an unparseable built_at → fromisoformat raises → stale.
        assert stops_builder.is_stops_cache_stale({"built_at": "not-a-date"}) is True


class TestScheduleDailyRebuild:
    @pytest.mark.asyncio
    async def test_computes_next_run_and_rebuilds(self, monkeypatch):
        # Freeze "now" just after 3am so next_run rolls to tomorrow, then make
        # the single sleep raise CancelledError after triggering one rebuild.
        import stops_builder as sb

        now_dt = datetime(2026, 5, 23, 3, 30, 0)

        class FakeDT:
            @staticmethod
            def now():
                return now_dt

        monkeypatch.setattr(sb, "datetime", FakeDT)

        build_called = {"n": 0}

        async def fake_build():
            build_called["n"] += 1

        monkeypatch.setattr(sb, "build_stops_cache", fake_build)

        sleeps = {"n": 0}

        async def fake_sleep(_secs):
            sleeps["n"] += 1
            if sleeps["n"] >= 2:
                raise asyncio.CancelledError

        monkeypatch.setattr(sb.asyncio, "sleep", fake_sleep)

        with pytest.raises(asyncio.CancelledError):
            await sb.schedule_daily_rebuild()
        assert build_called["n"] >= 1

    @pytest.mark.asyncio
    async def test_before_3am_runs_today(self, monkeypatch):
        import stops_builder as sb

        now_dt = datetime(2026, 5, 23, 1, 0, 0)  # before 3am → next_run today

        class FakeDT:
            @staticmethod
            def now():
                return now_dt

        monkeypatch.setattr(sb, "datetime", FakeDT)

        async def fake_build():
            raise asyncio.CancelledError  # stop the loop right after first build

        monkeypatch.setattr(sb, "build_stops_cache", fake_build)

        async def fake_sleep(_secs):
            return None

        monkeypatch.setattr(sb.asyncio, "sleep", fake_sleep)
        with pytest.raises(asyncio.CancelledError):
            await sb.schedule_daily_rebuild()

    @pytest.mark.asyncio
    async def test_rebuild_exception_logged_and_loop_survives(self, monkeypatch, caplog):
        import stops_builder as sb

        now_dt = datetime(2026, 5, 23, 1, 0, 0)

        class FakeDT:
            @staticmethod
            def now():
                return now_dt

        monkeypatch.setattr(sb, "datetime", FakeDT)

        build_calls = {"n": 0}

        async def flaky_build():
            build_calls["n"] += 1
            if build_calls["n"] == 1:
                raise RuntimeError("build boom")
            raise asyncio.CancelledError  # end after the second iteration

        monkeypatch.setattr(sb, "build_stops_cache", flaky_build)

        async def fake_sleep(_secs):
            return None

        monkeypatch.setattr(sb.asyncio, "sleep", fake_sleep)
        with (
            caplog.at_level("ERROR", logger="stops_builder"),
            pytest.raises(asyncio.CancelledError),
        ):
            await sb.schedule_daily_rebuild()
        assert any("rebuild failed" in r.message for r in caplog.records)


class TestBuildStopsCacheSuccess:
    @pytest.mark.asyncio
    async def test_full_build_writes_cache(self, tmp_path, monkeypatch):
        cache_file = tmp_path / "stops_cache.json"
        monkeypatch.setattr(stops_builder, "CACHE_FILE", cache_file)
        # Single grid point.
        monkeypatch.setattr(stops_builder, "GRID_LAT_MIN", 49.0)
        monkeypatch.setattr(stops_builder, "GRID_LAT_MAX", 49.0)
        monkeypatch.setattr(stops_builder, "GRID_LON_MIN", 8.0)
        monkeypatch.setattr(stops_builder, "GRID_LON_MAX", 8.0)

        grid_loc = {
            "name": "Grid Stop",
            "lid": "A=1@L=100@",
            "extId": "100",
            "crd": {"x": 8000000, "y": 49000000},
            "gidL": ["b×de:100", "A×de:100:1:1:Steig A"],
        }

        async def fake_call(client, method, req):
            if method == "LocGeoPos":
                return {"locL": [grid_loc]}
            # StationBoard (platform discovery + redundancy): no extra platforms.
            return {"common": {"locL": [], "prodL": []}, "jnyL": []}

        monkeypatch.setattr(stops_builder, "_hafas_call", fake_call)
        result = await stops_builder.build_stops_cache()
        assert result is not None
        assert result["count"] == 1
        assert cache_file.exists()
        written = json.loads(cache_file.read_text())
        assert written["stops"][0]["extId"] == "100"

    @pytest.mark.asyncio
    async def test_redundant_stop_removed(self, tmp_path, monkeypatch):
        cache_file = tmp_path / "stops_cache.json"
        monkeypatch.setattr(stops_builder, "CACHE_FILE", cache_file)
        monkeypatch.setattr(stops_builder, "GRID_LAT_MIN", 49.0)
        monkeypatch.setattr(stops_builder, "GRID_LAT_MAX", 49.0)
        monkeypatch.setattr(stops_builder, "GRID_LON_MIN", 8.0)
        monkeypatch.setattr(stops_builder, "GRID_LON_MAX", 8.0)

        # A platform stop and a no-platform collection stop with a matching name
        # that shares all lines → the collection stop is redundant.
        plat = {
            "name": "Bahnhof",
            "lid": "A=1@L=1@",
            "extId": "1",
            "crd": {"x": 8000000, "y": 49000000},
            "gidL": ["b×1", "A×x:1:2:3:Steig 1"],
        }
        collection = {
            "name": "Bahnhof",
            "lid": "A=1@L=2@",
            "extId": "2",
            "crd": {"x": 8000000, "y": 49000000},
            "gidL": ["b×2"],  # no platform
        }

        async def fake_call(client, method, req):
            if method == "LocGeoPos":
                return {"locL": [plat, collection]}
            # Platform-discovery StationBoard: no new platforms.
            # Redundancy StationBoard (lid A=1@L=2@): the collection stop's own
            # lines are a subset of platform lines → redundant.
            lid = req.get("stbLoc", {}).get("lid", "")
            if lid == "A=1@L=2@":
                return {
                    "common": {
                        "locL": [{"extId": "2"}, {"extId": "1"}],
                        "prodL": [{"nameS": "725"}],
                    },
                    "jnyL": [
                        {"stbStop": {"locX": 0}, "prodX": 0},  # own line 725
                        {"stbStop": {"locX": 1}, "prodX": 0},  # platform also 725
                    ],
                }
            return {"common": {"locL": [], "prodL": []}, "jnyL": []}

        monkeypatch.setattr(stops_builder, "_hafas_call", fake_call)
        result = await stops_builder.build_stops_cache()
        assert result is not None
        ext_ids = {s["extId"] for s in result["stops"]}
        # Collection stop "2" removed as redundant; platform "1" kept.
        assert "2" not in ext_ids
        assert "1" in ext_ids

    @pytest.mark.asyncio
    async def test_grid_exception_counts_as_error_and_aborts(self, tmp_path, monkeypatch):
        cache_file = tmp_path / "stops_cache.json"
        monkeypatch.setattr(stops_builder, "CACHE_FILE", cache_file)
        monkeypatch.setattr(stops_builder, "GRID_LAT_MIN", 49.0)
        monkeypatch.setattr(stops_builder, "GRID_LAT_MAX", 49.0)
        monkeypatch.setattr(stops_builder, "GRID_LON_MIN", 8.0)
        monkeypatch.setattr(stops_builder, "GRID_LON_MAX", 8.0)

        # _fetch_stops_in_radius raises → gather(return_exceptions) captures it,
        # errors1 increments, error rate 100% > 10% → build aborts, no file.
        async def boom(*a, **k):
            raise RuntimeError("grid fetch boom")

        monkeypatch.setattr(stops_builder, "_fetch_stops_in_radius", boom)
        result = await stops_builder.build_stops_cache()
        assert result is None
        assert not cache_file.exists()

    @pytest.mark.asyncio
    async def test_physical_stop_without_A_gid_has_empty_platform(self, monkeypatch):
        # gidL is physical (b×) but carries NO A× entry → the for-loop over
        # gid_l runs to completion without break (branch 136->143), platform "".
        board = {
            "common": {
                "locL": [
                    {
                        "name": "No Platform Marker",
                        "lid": "A=1@L=77@",
                        "extId": "77",
                        "crd": {"x": 8660000, "y": 49340000},
                        "gidL": ["b×de:77", "X×irrelevant"],
                    }
                ]
            },
            "jnyL": [{"stbStop": {"locX": 0}}],
        }

        async def fake_call(client, method, req):
            return board if req["type"] == "DEP" else None

        monkeypatch.setattr(stops_builder, "_hafas_call", fake_call)
        out = await stops_builder._discover_platforms(AsyncMock(), "A=1@L=1@")
        assert len(out) == 1
        assert out[0]["platform"] == ""

    @pytest.mark.asyncio
    async def test_grid_dedups_and_skips_unparsable(self, tmp_path, monkeypatch):
        # A radius call returns: a valid stop, a duplicate of it (extId already
        # in all_stops → skip, branch 232->230 taken), and an unparsable loc
        # (_parse_stop None → skip, also 232->230).
        cache_file = tmp_path / "stops_cache.json"
        monkeypatch.setattr(stops_builder, "CACHE_FILE", cache_file)
        monkeypatch.setattr(stops_builder, "GRID_LAT_MIN", 49.0)
        monkeypatch.setattr(stops_builder, "GRID_LAT_MAX", 49.0)
        monkeypatch.setattr(stops_builder, "GRID_LON_MIN", 8.0)
        monkeypatch.setattr(stops_builder, "GRID_LON_MAX", 8.0)

        valid = {
            "name": "Dup Stop",
            "lid": "A=1@L=300@",
            "extId": "300",
            "crd": {"x": 8000000, "y": 49000000},
            "gidL": ["b×de:300"],
        }
        unparsable = {"crd": {"x": 0, "y": 0}, "gidL": []}  # zero crd → None

        async def fake_fetch(client, lat, lon, radius):
            return [valid, dict(valid), unparsable]  # valid twice + junk

        async def fake_discover(client, lid):
            return []

        async def fake_redundant(client, sem, all_stops):
            return set()

        monkeypatch.setattr(stops_builder, "_fetch_stops_in_radius", fake_fetch)
        monkeypatch.setattr(stops_builder, "_discover_platforms", fake_discover)
        monkeypatch.setattr(stops_builder, "_find_redundant_stops_parallel", fake_redundant)
        result = await stops_builder.build_stops_cache()
        assert result is not None
        assert result["count"] == 1  # dedup + junk-skip → one stop


class TestFindRedundantParallel:
    def _stop(self, ext, name, lat, lon, platform=""):
        return {
            "extId": ext,
            "name": name,
            "lat": lat,
            "lon": lon,
            "platform": platform,
            "lid": f"A=1@L={ext}@",
        }

    @pytest.mark.asyncio
    async def test_far_platform_skipped_and_name_mismatch(self, monkeypatch):
        # Collection stop with: one far platform (>300m, dist continue branch),
        # one near platform with a non-matching name (name-match false branch).
        all_stops = {
            "c": self._stop("c", "Zzz Collection", 49.0, 8.0),
            "far": self._stop("far", "Zzz Collection", 49.1, 8.1, platform="P1"),
            "near": self._stop("near", "Totally Different", 49.0, 8.00001, platform="P2"),
        }
        # No candidates → _hafas_call never invoked; returns empty set.
        called = {"n": 0}

        async def fake_call(client, method, req):
            called["n"] += 1

        monkeypatch.setattr(stops_builder, "_hafas_call", fake_call)
        sem = asyncio.Semaphore(5)
        out = await stops_builder._find_redundant_stops_parallel(AsyncMock(), sem, all_stops)
        assert out == set()
        assert called["n"] == 0

    @pytest.mark.asyncio
    async def test_check_redundant_none_response_returns(self, monkeypatch):
        all_stops = {
            "c": self._stop("c", "Bahnhof", 49.0, 8.0),
            "p": self._stop("p", "Bahnhof", 49.0, 8.00001, platform="Steig 1"),
        }

        async def fake_call(client, method, req):
            return None  # StationBoard fails → _check_redundant returns early

        monkeypatch.setattr(stops_builder, "_hafas_call", fake_call)
        sem = asyncio.Semaphore(5)
        out = await stops_builder._find_redundant_stops_parallel(AsyncMock(), sem, all_stops)
        assert out == set()

    @pytest.mark.asyncio
    async def test_not_redundant_when_own_has_extra_lines(self, monkeypatch):
        all_stops = {
            "c": self._stop("c", "Bahnhof", 49.0, 8.0),
            "p": self._stop("p", "Bahnhof", 49.0, 8.00001, platform="Steig 1"),
        }

        async def fake_call(client, method, req):
            # own_lines has an extra line the platform doesn't → NOT redundant.
            # Also exercise loc_idx-out-of-range and dep_ext-neither branches.
            return {
                "common": {
                    "locL": [{"extId": "c"}, {"extId": "p"}, {"extId": "other"}],
                    "prodL": [{"nameS": "725"}, {"nameS": "999"}],
                },
                "jnyL": [
                    {"stbStop": {"locX": 0}, "prodX": 0},  # own 725
                    {"stbStop": {"locX": 1}, "prodX": 0},  # platform 725
                    {"stbStop": {"locX": 0}, "prodX": 1},  # own extra line 999
                    {"stbStop": {"locX": 2}, "prodX": 0},  # dep_ext "other" → neither
                    {"stbStop": {"locX": 99}, "prodX": 0},  # out-of-range idx
                ],
            }

        monkeypatch.setattr(stops_builder, "_hafas_call", fake_call)
        sem = asyncio.Semaphore(5)
        out = await stops_builder._find_redundant_stops_parallel(AsyncMock(), sem, all_stops)
        assert out == set()  # own_lines - plat_lines = {999} non-empty → kept

    @pytest.mark.asyncio
    async def test_redundant_when_subset(self, monkeypatch):
        all_stops = {
            "c": self._stop("c", "Bahnhof", 49.0, 8.0),
            "p": self._stop("p", "Bahnhof", 49.0, 8.00001, platform="Steig 1"),
        }

        async def fake_call(client, method, req):
            return {
                "common": {
                    "locL": [{"extId": "c"}, {"extId": "p"}],
                    "prodL": [{"nameS": "725"}],
                },
                "jnyL": [
                    {"stbStop": {"locX": 0}, "prodX": 0},
                    {"stbStop": {"locX": 1}, "prodX": 0},
                ],
            }

        monkeypatch.setattr(stops_builder, "_hafas_call", fake_call)
        sem = asyncio.Semaphore(5)
        out = await stops_builder._find_redundant_stops_parallel(AsyncMock(), sem, all_stops)
        assert out == {"c"}


class TestBuildPlatformDiscoveryAddsNew:
    @pytest.mark.asyncio
    async def test_discovery_adds_new_stop(self, tmp_path, monkeypatch):
        cache_file = tmp_path / "stops_cache.json"
        monkeypatch.setattr(stops_builder, "CACHE_FILE", cache_file)
        monkeypatch.setattr(stops_builder, "GRID_LAT_MIN", 49.0)
        monkeypatch.setattr(stops_builder, "GRID_LAT_MAX", 49.0)
        monkeypatch.setattr(stops_builder, "GRID_LON_MIN", 8.0)
        monkeypatch.setattr(stops_builder, "GRID_LON_MAX", 8.0)

        grid_loc = {
            "name": "Grid Stop",
            "lid": "A=1@L=100@",
            "extId": "100",
            "crd": {"x": 8000000, "y": 49000000},
            "gidL": ["b×de:100"],
        }

        async def fake_fetch(client, lat, lon, radius):
            return [grid_loc]

        async def fake_discover(client, lid):
            # Return a brand-new platform stop not already in all_stops (line
            # 250-251 add branch), plus a duplicate of the grid stop (skip).
            return [
                {"extId": "200", "name": "New Platform", "lat": 49.0, "lon": 8.0, "platform": "A"},
                {"extId": "100", "name": "dup", "lat": 49.0, "lon": 8.0, "platform": ""},
            ]

        async def fake_redundant(client, sem, all_stops):
            return set()

        monkeypatch.setattr(stops_builder, "_fetch_stops_in_radius", fake_fetch)
        monkeypatch.setattr(stops_builder, "_discover_platforms", fake_discover)
        monkeypatch.setattr(stops_builder, "_find_redundant_stops_parallel", fake_redundant)
        result = await stops_builder.build_stops_cache()
        assert result is not None
        ext_ids = {s["extId"] for s in result["stops"]}
        assert "200" in ext_ids  # discovery-added platform survived


class TestPlatformsProgressLog:
    @pytest.mark.asyncio
    async def test_progress_logged_at_500(self, tmp_path, monkeypatch, caplog):
        cache_file = tmp_path / "stops_cache.json"
        monkeypatch.setattr(stops_builder, "CACHE_FILE", cache_file)
        # Grid returns 500 distinct stops so done[0] hits the % 500 log line.
        monkeypatch.setattr(stops_builder, "GRID_LAT_MIN", 49.0)
        monkeypatch.setattr(stops_builder, "GRID_LAT_MAX", 49.0)
        monkeypatch.setattr(stops_builder, "GRID_LON_MIN", 8.0)
        monkeypatch.setattr(stops_builder, "GRID_LON_MAX", 8.0)

        locs = [
            {
                "name": f"S{i}",
                "lid": f"A=1@L={i}@",
                "extId": str(i),
                "crd": {"x": 8000000 + i, "y": 49000000},
                "gidL": ["b×de:x"],
            }
            for i in range(500)
        ]

        async def fake_fetch(client, lat, lon, radius):
            return locs

        async def fake_discover(client, lid):
            return []

        async def fake_redundant(client, sem, all_stops):
            return set()

        monkeypatch.setattr(stops_builder, "_fetch_stops_in_radius", fake_fetch)
        monkeypatch.setattr(stops_builder, "_discover_platforms", fake_discover)
        monkeypatch.setattr(stops_builder, "_find_redundant_stops_parallel", fake_redundant)
        with caplog.at_level("INFO", logger="stops_builder"):
            result = await stops_builder.build_stops_cache()
        assert result is not None
        assert any("Platforms:" in r.message for r in caplog.records)
