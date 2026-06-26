"""Extended proxy endpoint tests with mocked HAFAS upstream for full coverage."""

from unittest.mock import patch

import pytest
from httpx import ASGITransport, AsyncClient

from proxy import (app, breaker, cache, tick_tracker, _flatten_vehicles,
                   _calc_delay, _inflight,
                   _journey_cache, _stationboard_cache, _line_search_cache)


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
            {"name": "Stop A", "lid": "A=1@L=1@", "crd": {"x": 8660000, "y": 49340000},
             "extId": "1", "gidL": ["b×de:1"]},
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
            {"name": "Stop A", "lid": "A=1@L=6003411@", "crd": {"x": 8660000, "y": 49340000},
             "extId": "6003411", "gidL": ["b×de:1"]},
        ],
    },
    "jnyL": [
        {"jid": "j1", "prodX": 0, "dirTxt": "Dir", "date": "20260601",
         "stbStop": {"locX": 0, "dTimeS": "130000", "dTimeR": "130200"}},
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
            resp = await client.post("/api/stationboard",
                                     json={"lid": "A=1@L=6003411@", "type": "DEP", "dur": 60})
        assert resp.status_code == 200
        data = resp.json()
        assert "jnyL" in data

    @pytest.mark.asyncio
    async def test_stationboard_upstream_error(self, client):
        async def mock_hafas(request, method, req):
            return {"error": "upstream_error", "detail": "HAFAS error"}

        with patch("proxy._hafas_call_via_app", side_effect=mock_hafas):
            resp = await client.post("/api/stationboard",
                                     json={"lid": "A=1@L=6003411@", "type": "DEP", "dur": 60})
        assert resp.status_code == 502

    @pytest.mark.asyncio
    async def test_stationboard_cache_hit(self, client):
        call_count = [0]

        async def mock_hafas(request, method, req):
            call_count[0] += 1
            return MOCK_HAFAS_STATIONBOARD

        with patch("proxy._hafas_call_via_app", side_effect=mock_hafas):
            await client.post("/api/stationboard", json={"lid": "A=1@L=6003411@", "type": "DEP", "dur": 60})
            await client.post("/api/stationboard", json={"lid": "A=1@L=6003411@", "type": "DEP", "dur": 60})
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
        app.state.stops_data = {"stops": [
            {"name": "TestStop", "lid": "A=1@L=1@", "lat": 49.34, "lon": 8.66, "extId": "1", "platform": ""},
            {"name": "FarStop", "lid": "A=1@L=2@", "lat": 49.50, "lon": 8.80, "extId": "2", "platform": ""},
        ]}
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
