"""Extended proxy endpoint tests with mocked HAFAS upstream for full coverage."""

import asyncio
from unittest.mock import MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

import proxy
from proxy import (
    StationBoardRequest,
    _calc_delay,
    _expand_stationboard,
    _extid_scoped_count,
    _flatten_vehicles,
    _inflight,
    _journey_cache,
    _line_search_cache,
    _stationboard_cache,
    app,
    breaker,
    cache,
    tick_tracker,
)


@pytest.fixture(autouse=True)
def reset_state():
    # Drop any cached state that leaks between tests. The per-IP REST
    # rate-limit bucket lives in sse_handler and accumulates from any
    # earlier test that hit /api/journey, /api/stationboard or
    # /api/line_search from the shared test client — without resetting it
    # here the third line_search test in this file sees a depleted bucket
    # and the assertion against 502 trips on a 429 instead.
    import sse_handler

    breaker.failures = 0
    breaker.last_failure_time = 0.0
    cache._key = None
    cache._data = None
    cache._ts = 0
    cache._mono_ts = 0.0
    _journey_cache.clear()
    _stationboard_cache.clear()
    _line_search_cache.clear()
    _inflight.clear()
    sse_handler._post_rate_per_ip.clear()
    orig_tick = tick_tracker.last_tick_ts
    yield
    breaker.failures = 0
    breaker.last_failure_time = 0.0
    cache._key = None
    cache._data = None
    cache._ts = 0
    _journey_cache.clear()
    _stationboard_cache.clear()
    _line_search_cache.clear()
    _inflight.clear()
    sse_handler._post_rate_per_ip.clear()
    tick_tracker.last_tick_ts = orig_tick


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


MOCK_HAFAS_VEHICLES = {
    "common": {
        "prodL": [{"name": "Bus  721", "nameS": "721"}],
        "locL": [
            {
                "name": "Stop A",
                "lid": "A=1@L=1@",
                "crd": {"x": 8660000, "y": 49340000},
                "extId": "1",
                "gidL": ["b×de:1"],
            },
        ],
    },
    "jnyL": [
        {
            "jid": "2|test|0|80|010626",
            "date": "20260601",
            "prodX": 0,
            "dirTxt": "Walldorf",
            "pos": {"x": 8661000, "y": 49341000},
            "proc": 50,
            "stopL": [
                {"locX": 0, "dTimeS": "120000", "dTimeR": "120300"},
            ],
        }
    ],
}

MOCK_HAFAS_STATIONBOARD = {
    "common": {
        "prodL": [{"name": "Bus  721", "nameS": "721"}],
        "locL": [
            {
                "name": "Stop A",
                "lid": "A=1@L=6003411@",
                "crd": {"x": 8660000, "y": 49340000},
                "extId": "6003411",
                "gidL": ["b×de:1"],
            },
        ],
    },
    "jnyL": [
        {
            "jid": "j1",
            "prodX": 0,
            "dirTxt": "Dir",
            "date": "20260601",
            "stbStop": {"locX": 0, "dTimeS": "130000", "dTimeR": "130200"},
        },
    ],
}

MOCK_HAFAS_JOURNEY = {
    "journey": {
        "prodX": 0,
        "dirTxt": "Walldorf",
        "pos": {"x": 8661000, "y": 49341000},
        "stopL": [
            {"locX": 0, "dTimeS": "120000", "dTimeR": "120300"},
        ],
    },
    "common": {
        "prodL": [{"name": "Bus  721", "nameS": "721"}],
        "locL": [{"name": "Stop A", "crd": {"x": 8660000, "y": 49340000}}],
        "polyL": [],
    },
}


class TestCalcDelay:
    def test_positive_delay(self):
        stop = {"dTimeS": "120000", "dTimeR": "120300"}
        assert _calc_delay(stop) == 3

    def test_negative_delay(self):
        stop = {"aTimeS": "120300", "aTimeR": "120000"}
        assert _calc_delay(stop) == -3

    def test_no_realtime(self):
        stop = {"dTimeS": "120000"}
        assert _calc_delay(stop) is None

    def test_midnight_wraparound(self):
        stop = {"dTimeS": "235800", "dTimeR": "000100"}
        assert _calc_delay(stop) == 3

    def test_day_offset_real_crosses_midnight(self):
        # HAFAS prefixes a day offset ("1HHMMSS" = next day) once a delayed real
        # time crosses midnight. 23:59 scheduled, 00:02 next day = +3, NOT +61.
        stop = {"dTimeS": "235900", "dTimeR": "01000200"}
        assert _calc_delay(stop) == 3

    def test_day_offset_both_sides(self):
        # Both scheduled and real already carry the next-day offset prefix.
        stop = {"aTimeS": "01000200", "aTimeR": "01000500"}
        assert _calc_delay(stop) == 3

    def test_malformed_time(self):
        stop = {"dTimeS": "XX", "dTimeR": "120000"}
        assert _calc_delay(stop) is None


class TestFlattenVehicles:
    def test_basic_flatten(self):
        vehicles = _flatten_vehicles(MOCK_HAFAS_VEHICLES)
        assert len(vehicles) == 1
        v = vehicles[0]
        assert v["jid"] == "2|test|0|80|010626"
        assert v["line"] == "721"
        assert v["direction"] == "Walldorf"
        assert v["lat"] == pytest.approx(49.341, abs=0.001)
        assert v["lon"] == pytest.approx(8.661, abs=0.001)
        assert v["delay"] == 3

    def test_empty_jnyL(self):
        assert _flatten_vehicles({"common": {"prodL": [], "locL": []}, "jnyL": []}) == []

    def test_skips_zero_position(self):
        res = {
            "common": {"prodL": [{"name": "X"}], "locL": []},
            "jnyL": [{"jid": "j", "prodX": 0, "pos": {"x": 0, "y": 0}, "stopL": []}],
        }
        assert _flatten_vehicles(res) == []

    def test_skips_no_position(self):
        res = {
            "common": {"prodL": [{"name": "X"}], "locL": []},
            "jnyL": [{"jid": "j", "prodX": 0, "stopL": []}],
        }
        assert _flatten_vehicles(res) == []


class TestHafasCallMocked:
    @pytest.mark.asyncio
    async def test_journey_success(self, client):
        async def mock_hafas(request, method, req):
            return MOCK_HAFAS_JOURNEY

        with patch("proxy._hafas_call_via_app", side_effect=mock_hafas):
            resp = await client.post("/api/journey", json={"jid": "2|test|0|80|010626"})
        assert resp.status_code == 200
        data = resp.json()
        assert "journey" in data

    @pytest.mark.asyncio
    async def test_journey_upstream_error(self, client):
        async def mock_hafas(request, method, req):
            return {"error": "upstream_error", "detail": "HAFAS error"}

        with patch("proxy._hafas_call_via_app", side_effect=mock_hafas):
            resp = await client.post("/api/journey", json={"jid": "2|test|0|80|010626"})
        assert resp.status_code == 502

    @pytest.mark.asyncio
    async def test_stationboard_success(self, client):
        async def mock_hafas(request, method, req):
            return MOCK_HAFAS_STATIONBOARD

        with patch("proxy._hafas_call_via_app", side_effect=mock_hafas):
            resp = await client.post(
                "/api/stationboard", json={"lid": "A=1@L=6003411@", "type": "DEP", "dur": 60}
            )
        assert resp.status_code == 200
        data = resp.json()
        assert "jnyL" in data

    @pytest.mark.asyncio
    async def test_stationboard_upstream_error(self, client):
        async def mock_hafas(request, method, req):
            return {"error": "upstream_error", "detail": "HAFAS error"}

        with patch("proxy._hafas_call_via_app", side_effect=mock_hafas):
            resp = await client.post(
                "/api/stationboard", json={"lid": "A=1@L=6003411@", "type": "DEP", "dur": 60}
            )
        assert resp.status_code == 502

    @pytest.mark.asyncio
    async def test_stationboard_cache_hit(self, client):
        call_count = [0]

        async def mock_hafas(request, method, req):
            call_count[0] += 1
            return MOCK_HAFAS_STATIONBOARD

        with patch("proxy._hafas_call_via_app", side_effect=mock_hafas):
            await client.post(
                "/api/stationboard", json={"lid": "A=1@L=6003411@", "type": "DEP", "dur": 60}
            )
            await client.post(
                "/api/stationboard", json={"lid": "A=1@L=6003411@", "type": "DEP", "dur": 60}
            )
        assert call_count[0] == 1

    @pytest.mark.asyncio
    async def test_line_search_success(self, client):
        async def mock_hafas(request, method, req):
            return MOCK_HAFAS_VEHICLES

        with patch("proxy._hafas_call_via_app", side_effect=mock_hafas):
            resp = await client.get("/api/line_search?q=721")
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] >= 1
        assert data["vehicles"][0]["line"] == "721"

    @pytest.mark.asyncio
    async def test_line_search_no_match(self, client):
        async def mock_hafas(request, method, req):
            return MOCK_HAFAS_VEHICLES

        with patch("proxy._hafas_call_via_app", side_effect=mock_hafas):
            resp = await client.get("/api/line_search?q=999")
        assert resp.status_code == 200
        assert resp.json()["count"] == 0

    @pytest.mark.asyncio
    async def test_line_search_upstream_error(self, client):
        async def mock_hafas(request, method, req):
            return {"error": "upstream_error", "detail": "fail"}

        with patch("proxy._hafas_call_via_app", side_effect=mock_hafas):
            resp = await client.get("/api/line_search?q=721")
        assert resp.status_code == 502


class TestGetStops:
    @pytest.fixture(autouse=True)
    def inject_stops(self):
        app.state.stops_data = {
            "stops": [
                {
                    "name": "TestStop",
                    "lid": "A=1@L=1@",
                    "lat": 49.34,
                    "lon": 8.66,
                    "extId": "1",
                    "platform": "",
                },
                {
                    "name": "FarStop",
                    "lid": "A=1@L=2@",
                    "lat": 49.50,
                    "lon": 8.80,
                    "extId": "2",
                    "platform": "",
                },
            ]
        }
        yield
        app.state.stops_data = {"stops": []}

    @pytest.mark.asyncio
    async def test_returns_nearby_stops(self, client):
        resp = await client.get("/api/stops?lat=49.34&lon=8.66&radius=5000")
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] == 1
        assert data["stops"][0]["name"] == "TestStop"

    @pytest.mark.asyncio
    async def test_large_radius_returns_all(self, client):
        resp = await client.get("/api/stops?lat=49.42&lon=8.73&radius=20000")
        assert resp.status_code == 200
        assert resp.json()["count"] == 2


class TestSecurityHeaders:
    @pytest.mark.asyncio
    async def test_all_security_headers_present(self, client):
        resp = await client.get("/api/health")
        assert resp.headers["x-content-type-options"] == "nosniff"
        assert resp.headers["x-frame-options"] == "DENY"
        assert "strict-origin" in resp.headers["referrer-policy"]
        assert "geolocation=(self)" in resp.headers["permissions-policy"]
        csp = resp.headers["content-security-policy"]
        assert "default-src 'self'" in csp
        assert "frame-ancestors 'none'" in csp


def _board(jny_count, *, loc_ext=None, stb_locx=0):
    """Build a minimal StationBoard `res`. jny entries carry a stbStop.locX
    so _extid_scoped_count can resolve them against locL."""
    jny = [{"jid": f"j{i}", "stbStop": {"locX": stb_locx}} for i in range(jny_count)]
    common = {"locL": [{"extId": loc_ext}]} if loc_ext is not None else {}
    return {"jnyL": jny, "common": common}


def _fetch_mock(boards_by_dur, *, calls=None, sleep_after=None, sleep_s=0.5):
    """Return an async stand-in for _fetch_stationboard_for_subscriber.

    `boards_by_dur`: callable(dur) -> res dict (may contain "error").
    `calls`: optional list to append each requested dur to.
    `sleep_after`: if set, from that call index (0-based) onward the mock
    sleeps `sleep_s` before returning — used to trip the cascade budget.
    """
    n = [0]

    async def _mock(app, lid, board_type, dur):
        idx = n[0]
        n[0] += 1
        if calls is not None:
            calls.append(dur)
        if sleep_after is not None and idx >= sleep_after:
            await asyncio.sleep(sleep_s)
        return boards_by_dur(dur)

    return _mock


class TestExtIdScopedCount:
    def test_no_ext_id_returns_raw_len(self):
        res = {"jnyL": [{"a": 1}, {"b": 2}]}
        assert _extid_scoped_count(res, None) == 2

    def test_empty_jny_l_returns_zero(self):
        assert _extid_scoped_count({"jnyL": []}, "6003411") == 0

    def test_ext_id_not_in_loc_l_falls_back_to_raw_len(self):
        # ext_id given but no locL entry carries it → raw count (single-platform
        # stop / unknown platform).
        res = {"jnyL": [{"a": 1}, {"b": 2}], "common": {"locL": [{"extId": "999"}]}}
        assert _extid_scoped_count(res, "6003411") == 2

    def test_multi_platform_counts_only_matching(self):
        # locL[0] is the wanted platform, locL[1] another. Entries: locX=0 (match),
        # locX=1 (other platform), locX None (skipped), locX out-of-range (skipped),
        # missing stbStop (skipped). Only the locX=0 entry counts.
        res = {
            "common": {"locL": [{"extId": "6003411"}, {"extId": "6003412"}]},
            "jnyL": [
                {"stbStop": {"locX": 0}},
                {"stbStop": {"locX": 1}},
                {"stbStop": {"locX": None}},
                {"stbStop": {"locX": 9}},
                {},
            ],
        }
        assert _extid_scoped_count(res, "6003411") == 1


class TestExtIdValidator:
    def test_empty_string_coerces_to_none(self):
        assert StationBoardRequest(lid="A=1@L=6003411@", ext_id="").ext_id is None

    def test_non_numeric_coerces_to_none(self):
        assert StationBoardRequest(lid="A=1@L=6003411@", ext_id="ab12").ext_id is None

    def test_oversize_coerces_to_none(self):
        # 21 digits exceeds the ^[0-9]{1,20}$ cap → None.
        assert StationBoardRequest(lid="A=1@L=6003411@", ext_id="1" * 21).ext_id is None

    def test_numeric_ext_id_preserved(self):
        assert StationBoardRequest(lid="A=1@L=6003411@", ext_id="6003411").ext_id == "6003411"

    @pytest.mark.asyncio
    async def test_auto_expand_with_empty_ext_id_does_not_422(self, client):
        # "" must degrade to a raw count, never reject the request.
        async def mock(app, lid, board_type, dur):
            return _board(1)

        with patch("proxy._fetch_stationboard_for_subscriber", side_effect=mock):
            resp = await client.post(
                "/api/stationboard",
                json={"lid": "A=1@L=6003411@", "type": "DEP", "auto_expand": True, "ext_id": ""},
            )
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_min_results_negative_422(self, client):
        resp = await client.post(
            "/api/stationboard",
            json={"lid": "A=1@L=6003411@", "auto_expand": True, "min_results": -1},
        )
        assert resp.status_code == 422


class TestExpandStationboard:
    """Direct unit tests of the cascade helper with a mocked fetch."""

    @pytest.mark.asyncio
    async def test_settles_immediately_when_non_empty(self):
        calls = []
        mock = _fetch_mock(lambda d: _board(2), calls=calls)
        with patch("proxy._fetch_stationboard_for_subscriber", side_effect=mock):
            res, dur = await _expand_stationboard(MagicMock(), "L", "DEP", 60, 0, None)
        assert dur == 60
        assert res["jnyL"]
        assert calls == [60]

    @pytest.mark.asyncio
    async def test_expands_geometrically_until_non_empty(self):
        calls = []
        mock = _fetch_mock(lambda d: _board(0) if d < 240 else _board(3), calls=calls)
        with patch("proxy._fetch_stationboard_for_subscriber", side_effect=mock):
            res, dur = await _expand_stationboard(MagicMock(), "L", "DEP", 60, 0, None)
        assert calls == [60, 120, 240]
        assert dur == 240
        assert len(res["jnyL"]) == 3

    @pytest.mark.asyncio
    async def test_ext_id_scoped_cascade_continues_past_nonempty_raw_board(self):
        # The defining behaviour of ext_id: a multi-platform stop whose RAW board
        # is non-empty but whose OPENED platform is empty must keep widening. Here
        # dur<240 returns 2 raw entries at a DIFFERENT platform (locX=1, out of the
        # single-entry locL → scoped count 0), so a raw-count loop would wrongly
        # settle at 60. Scoped counting walks on to dur=240 where the entries sit
        # at the wanted platform (locX=0 → scoped 2 > 0). Guards against a
        # regression that swaps _extid_scoped_count for len(jnyL).
        def board(d):
            return (
                _board(2, loc_ext="6003411", stb_locx=1)
                if d < 240
                else _board(2, loc_ext="6003411", stb_locx=0)
            )

        calls = []
        mock = _fetch_mock(board, calls=calls)
        with patch("proxy._fetch_stationboard_for_subscriber", side_effect=mock):
            res, dur = await _expand_stationboard(MagicMock(), "L", "DEP", 60, 0, "6003411")
        assert calls == [60, 120, 240]  # a raw-count regression would stop at [60]
        assert dur == 240
        assert len(res["jnyL"]) == 2

    @pytest.mark.asyncio
    async def test_error_on_first_step_returns_none(self):
        mock = _fetch_mock(lambda d: {"error": "upstream"})
        with patch("proxy._fetch_stationboard_for_subscriber", side_effect=mock):
            res, dur = await _expand_stationboard(MagicMock(), "L", "DEP", 60, 0, None)
        assert res is None
        assert dur is None

    @pytest.mark.asyncio
    async def test_empty_then_error_returns_the_empty_board(self):
        calls = []
        mock = _fetch_mock(lambda d: _board(0) if d == 60 else {"error": "upstream"}, calls=calls)
        with patch("proxy._fetch_stationboard_for_subscriber", side_effect=mock):
            res, dur = await _expand_stationboard(MagicMock(), "L", "DEP", 60, 0, None)
        assert calls == [60, 120]
        assert dur == 60  # last success, not the errored step-2
        assert res["jnyL"] == []

    @pytest.mark.asyncio
    async def test_stays_empty_to_cap(self):
        calls = []
        mock = _fetch_mock(lambda d: _board(0), calls=calls)
        with patch("proxy._fetch_stationboard_for_subscriber", side_effect=mock):
            res, dur = await _expand_stationboard(MagicMock(), "L", "DEP", 60, 0, None)
        assert calls == [60, 120, 240, 480, 960, 1440]
        assert dur == 1440
        assert res["jnyL"] == []

    @pytest.mark.asyncio
    async def test_start_dur_1440_single_fetch(self):
        calls = []
        mock = _fetch_mock(lambda d: _board(0), calls=calls)
        with patch("proxy._fetch_stationboard_for_subscriber", side_effect=mock):
            res, dur = await _expand_stationboard(MagicMock(), "L", "DEP", 1440, 0, None)
        assert calls == [1440]
        assert dur == 1440

    @pytest.mark.asyncio
    async def test_min_results_load_more_semantics(self):
        # dur=60 has 1 entry (<=min_results=3 → keep going), dur>=120 has 5 (>3 → settle).
        calls = []
        mock = _fetch_mock(lambda d: _board(1) if d < 120 else _board(5), calls=calls)
        with patch("proxy._fetch_stationboard_for_subscriber", side_effect=mock):
            res, dur = await _expand_stationboard(MagicMock(), "L", "DEP", 60, 3, None)
        assert calls == [60, 120]
        assert dur == 120

    @pytest.mark.asyncio
    async def test_min_results_unreachable_runs_to_cap(self):
        calls = []
        mock = _fetch_mock(lambda d: _board(2), calls=calls)
        with patch("proxy._fetch_stationboard_for_subscriber", side_effect=mock):
            res, dur = await _expand_stationboard(MagicMock(), "L", "DEP", 60, 100, None)
        assert calls == [60, 120, 240, 480, 960, 1440]
        assert dur == 1440

    @pytest.mark.asyncio
    async def test_budget_timeout_returns_board_gathered_so_far(self, monkeypatch):
        monkeypatch.setattr(proxy, "_CASCADE_BUDGET_S", 0.02)
        calls = []
        # First fetch returns 1 entry but min_results=5 keeps the loop going;
        # the second fetch sleeps past the budget → TimeoutError → return board 1.
        mock = _fetch_mock(lambda d: _board(1), calls=calls, sleep_after=1, sleep_s=0.5)
        with patch("proxy._fetch_stationboard_for_subscriber", side_effect=mock):
            res, dur = await _expand_stationboard(MagicMock(), "L", "DEP", 60, 5, None)
        assert dur == 60
        assert len(res["jnyL"]) == 1

    @pytest.mark.asyncio
    async def test_budget_timeout_before_any_board_returns_none(self, monkeypatch):
        monkeypatch.setattr(proxy, "_CASCADE_BUDGET_S", 0.02)
        mock = _fetch_mock(lambda d: _board(1), sleep_after=0, sleep_s=0.5)
        with patch("proxy._fetch_stationboard_for_subscriber", side_effect=mock):
            res, dur = await _expand_stationboard(MagicMock(), "L", "DEP", 60, 0, None)
        assert res is None
        assert dur is None


class TestStationboardAutoExpandEndpoint:
    @pytest.mark.asyncio
    async def test_returns_settled_dur(self, client):
        mock = _fetch_mock(lambda d: _board(0) if d < 120 else _board(2))
        with patch("proxy._fetch_stationboard_for_subscriber", side_effect=mock):
            resp = await client.post(
                "/api/stationboard",
                json={"lid": "A=1@L=6003411@", "type": "DEP", "auto_expand": True},
            )
        assert resp.status_code == 200
        data = resp.json()
        assert data["settledDur"] == 120
        assert len(data["jnyL"]) == 2

    @pytest.mark.asyncio
    async def test_upstream_error_first_step_returns_502(self, client):
        mock = _fetch_mock(lambda d: {"error": "upstream"})
        with patch("proxy._fetch_stationboard_for_subscriber", side_effect=mock):
            resp = await client.post(
                "/api/stationboard",
                json={"lid": "A=1@L=6003411@", "type": "DEP", "auto_expand": True},
            )
        assert resp.status_code == 502
        assert resp.json()["error"] == "upstream"

    @pytest.mark.asyncio
    async def test_empty_to_cap_returns_200_with_empty_board(self, client):
        mock = _fetch_mock(lambda d: _board(0))
        with patch("proxy._fetch_stationboard_for_subscriber", side_effect=mock):
            resp = await client.post(
                "/api/stationboard",
                json={"lid": "A=1@L=6003411@", "type": "DEP", "auto_expand": True},
            )
        assert resp.status_code == 200
        data = resp.json()
        assert data["settledDur"] == 1440
        assert data["jnyL"] == []

    @pytest.mark.asyncio
    async def test_budget_timeout_returns_200_first_board(self, client, monkeypatch):
        monkeypatch.setattr(proxy, "_CASCADE_BUDGET_S", 0.02)
        mock = _fetch_mock(lambda d: _board(1), sleep_after=1, sleep_s=0.5)
        with patch("proxy._fetch_stationboard_for_subscriber", side_effect=mock):
            resp = await client.post(
                "/api/stationboard",
                json={
                    "lid": "A=1@L=6003411@",
                    "type": "DEP",
                    "auto_expand": True,
                    "min_results": 5,
                },
            )
        assert resp.status_code == 200
        assert resp.json()["settledDur"] == 60

    @pytest.mark.asyncio
    async def test_budget_timeout_no_board_returns_502(self, client, monkeypatch):
        monkeypatch.setattr(proxy, "_CASCADE_BUDGET_S", 0.02)
        mock = _fetch_mock(lambda d: _board(1), sleep_after=0, sleep_s=0.5)
        with patch("proxy._fetch_stationboard_for_subscriber", side_effect=mock):
            resp = await client.post(
                "/api/stationboard",
                json={"lid": "A=1@L=6003411@", "type": "DEP", "auto_expand": True},
            )
        assert resp.status_code == 502

    @pytest.mark.asyncio
    async def test_cache_hit_mid_cascade(self, client):
        # Pre-seed dur=240 as a fresh non-empty cache entry. The cascade fetches
        # 60 and 120 from HAFAS (empty), then hits the cache at 240 and settles —
        # so _hafas_call_via_app is only invoked twice.
        import time as _t

        _stationboard_cache[("A=1@L=6003411@", "DEP", 240)] = (_t.time(), _board(3))
        call_durs = []

        async def mock_hafas(app, method, req):
            call_durs.append(req["dur"])
            return _board(0)

        with patch("proxy._hafas_call_via_app", side_effect=mock_hafas):
            resp = await client.post(
                "/api/stationboard",
                json={"lid": "A=1@L=6003411@", "type": "DEP", "auto_expand": True},
            )
        assert resp.status_code == 200
        assert resp.json()["settledDur"] == 240
        assert call_durs == [60, 120]

    @pytest.mark.asyncio
    async def test_cache_hit_on_reopen(self, client):
        # Two identical auto_expand requests. The first fills the cache for every
        # window it walked; the second serves entirely from cache → no new HAFAS calls.
        call_count = [0]

        def board(d):
            return _board(0) if d < 120 else _board(2)

        async def mock_hafas(app, method, req):
            call_count[0] += 1
            return board(req["dur"])

        with patch("proxy._hafas_call_via_app", side_effect=mock_hafas):
            r1 = await client.post(
                "/api/stationboard",
                json={"lid": "A=1@L=6003411@", "type": "DEP", "auto_expand": True},
            )
            first = call_count[0]
            r2 = await client.post(
                "/api/stationboard",
                json={"lid": "A=1@L=6003411@", "type": "DEP", "auto_expand": True},
            )
        assert r1.json()["settledDur"] == 120
        assert r2.json()["settledDur"] == 120
        assert call_count[0] == first  # second request added no upstream calls

    @pytest.mark.asyncio
    async def test_settled_dur_not_leaked_into_cache(self, client):
        # The endpoint returns {**best_res, "settledDur": ...}; the shared cached
        # object must stay clean so the SSE tick / later hits never see settledDur.
        async def mock_hafas(app, method, req):
            return _board(2)

        with patch("proxy._hafas_call_via_app", side_effect=mock_hafas):
            resp = await client.post(
                "/api/stationboard",
                json={"lid": "A=1@L=6003411@", "type": "DEP", "auto_expand": True},
            )
        settled = resp.json()["settledDur"]
        cached = _stationboard_cache[("A=1@L=6003411@", "DEP", settled)][1]
        assert "settledDur" not in cached

    @pytest.mark.asyncio
    async def test_ext_id_scopes_expansion_end_to_end(self, client):
        # ext_id flows request → _expand_stationboard → _extid_scoped_count end to
        # end: the opened platform is empty at dur=60 (raw board non-empty at a
        # different platform), so the cascade advances to dur=120 where the wanted
        # platform has entries. A raw-count loop would settle at 60.
        def board(d):
            return (
                _board(2, loc_ext="6003411", stb_locx=1)
                if d < 120
                else _board(2, loc_ext="6003411", stb_locx=0)
            )

        async def mock(app, lid, board_type, dur):
            return board(dur)

        with patch("proxy._fetch_stationboard_for_subscriber", side_effect=mock):
            resp = await client.post(
                "/api/stationboard",
                json={
                    "lid": "A=1@L=6003411@",
                    "type": "DEP",
                    "auto_expand": True,
                    "ext_id": "6003411",
                },
            )
        assert resp.status_code == 200
        assert resp.json()["settledDur"] == 120

    @pytest.mark.asyncio
    async def test_auto_expand_false_uses_legacy_single_fetch(self, client):
        # auto_expand=false → the old path: min_results/ext_id ignored, one fetch,
        # no settledDur in the response.
        async def mock_hafas(app, method, req):
            return MOCK_HAFAS_STATIONBOARD

        with patch("proxy._hafas_call_via_app", side_effect=mock_hafas):
            resp = await client.post(
                "/api/stationboard",
                json={
                    "lid": "A=1@L=6003411@",
                    "type": "DEP",
                    "dur": 60,
                    "min_results": 99,
                    "ext_id": "6003411",
                },
            )
        assert resp.status_code == 200
        data = resp.json()
        assert "settledDur" not in data
        assert "jnyL" in data
