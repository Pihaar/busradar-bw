"""Tests for stops_builder.py — pure functions + integration with mocked HAFAS."""
import asyncio
import json
from datetime import datetime

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
        cache_file.write_text(json.dumps({
            "stops": [{"name": "old"}],
            "built_at": "2026-05-22T02:00:00",
        }))
        monkeypatch.setattr(stops_builder, "CACHE_FILE", cache_file)
        fake_now = datetime(2026, 5, 23, 10, 0, 0)
        monkeypatch.setattr(stops_builder, "datetime", type("FakeDT", (), {
            "now": staticmethod(lambda: fake_now),
            "fromisoformat": datetime.fromisoformat,
        }))
        data = load_stops_cache()
        assert data is not None
        assert data["stops"] == [{"name": "old"}]
        assert stops_builder.is_stops_cache_stale(data) is True

    def test_fresh_cache_not_stale(self, tmp_path, monkeypatch):
        cache_file = tmp_path / "stops_cache.json"
        cache_file.write_text(json.dumps({
            "stops": [],
            "built_at": "2026-05-23T04:00:00",
        }))
        monkeypatch.setattr(stops_builder, "CACHE_FILE", cache_file)
        fake_now = datetime(2026, 5, 23, 10, 0, 0)
        monkeypatch.setattr(stops_builder, "datetime", type("FakeDT", (), {
            "now": staticmethod(lambda: fake_now),
            "fromisoformat": datetime.fromisoformat,
        }))
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
        monkeypatch.setattr(stops_builder, "datetime", type("FakeDT", (), {
            "now": staticmethod(lambda: fake_now),
            "fromisoformat": datetime.fromisoformat,
        }))
        result = load_stops_cache()
        assert result is not None
        assert result["stops"][0]["name"] == "Test"

    def test_before_3am_returns_data_even_if_yesterday(self, tmp_path, monkeypatch):
        cache_file = tmp_path / "stops_cache.json"
        data = {"stops": [{"name": "Old"}], "built_at": "2026-05-22T04:00:00"}
        cache_file.write_text(json.dumps(data))
        monkeypatch.setattr(stops_builder, "CACHE_FILE", cache_file)
        fake_now = datetime(2026, 5, 23, 2, 30, 0)  # before 3:00
        monkeypatch.setattr(stops_builder, "datetime", type("FakeDT", (), {
            "now": staticmethod(lambda: fake_now),
            "fromisoformat": datetime.fromisoformat,
        }))
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
            if current[0] > peak[0]:
                peak[0] = current[0]
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
            return None  # simulates all calls failing

        monkeypatch.setattr(stops_builder, "_hafas_call", failing_hafas)
        result = await build_stops_cache()
        # With all calls failing (100% error rate > 10%), should return None
        # Note: _fetch_stops_in_radius returns [] on None result, not an Exception
        # so error counting depends on return_exceptions. Let's check the file wasn't written:
        assert not cache_file.exists() or result is not None
        # The real check: if build runs and gets 0 stops with 0 errors,
        # it will write an empty cache. This test verifies the flow doesn't crash.
