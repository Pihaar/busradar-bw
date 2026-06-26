"""Extended proxy endpoint tests with mocked HAFAS upstream for full coverage."""

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from proxy import (app, breaker, cache, tick_tracker, client_activity, _flatten_vehicles,
                   _calc_delay, _inflight,
                   _journey_cache, _stationboard_cache, _line_search_cache)


@pytest.fixture(autouse=True)
def reset_state():
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
    @pytest.mark.skip(reason="polling endpoint is 410 Gone; these tests will be removed once the handler itself is deleted")
    @pytest.mark.asyncio
    async def test_vehicles_success_with_mock(self, client):
        async def mock_hafas(request, method, req):
            return MOCK_HAFAS_VEHICLES

        with patch("proxy._hafas_call", side_effect=mock_hafas):
            resp = await client.get("/api/vehicles?swLat=49.3&swLon=8.6&neLat=49.4&neLon=8.7")
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] == 1
        assert data["vehicles"][0]["line"] == "721"
        assert "nextFreshDataIn" in data
        assert "dataAge" in data
        assert "serverTime" in data

    @pytest.mark.skip(reason="polling endpoint is 410 Gone; these tests will be removed once the handler itself is deleted")
    @pytest.mark.asyncio
    async def test_vehicles_upstream_error(self, client):
        async def mock_hafas(request, method, req):
            return {"error": "upstream_error", "detail": "HAFAS error"}

        with patch("proxy._hafas_call", side_effect=mock_hafas):
            resp = await client.get("/api/vehicles?swLat=49.3&swLon=8.6&neLat=49.4&neLon=8.7")
        assert resp.status_code == 502

    @pytest.mark.skip(reason="polling endpoint is 410 Gone; these tests will be removed once the handler itself is deleted")
    @pytest.mark.asyncio
    async def test_vehicles_stale_fallback_on_error(self, client):
        # First: populate cache
        async def mock_success(request, method, req):
            return MOCK_HAFAS_VEHICLES

        with patch("proxy._hafas_call", side_effect=mock_success):
            resp = await client.get("/api/vehicles?swLat=49.3&swLon=8.6&neLat=49.4&neLon=8.7")
        assert resp.status_code == 200

        # Expire cache
        cache._ts = 0
        cache._mono_ts = 0.0

        # Second: error → stale fallback
        async def mock_error(request, method, req):
            return {"error": "upstream_timeout", "detail": "timeout"}

        with patch("proxy._hafas_call", side_effect=mock_error):
            resp = await client.get("/api/vehicles?swLat=49.3&swLon=8.6&neLat=49.4&neLon=8.7")
        assert resp.status_code == 200
        assert resp.json()["count"] == 1

    @pytest.mark.asyncio
    async def test_journey_success(self, client):
        async def mock_hafas(request, method, req):
            return MOCK_HAFAS_JOURNEY

        with patch("proxy._hafas_call", side_effect=mock_hafas):
            resp = await client.post("/api/journey", json={"jid": "2|test|0|80|010626"})
        assert resp.status_code == 200
        data = resp.json()
        assert "journey" in data

    @pytest.mark.asyncio
    async def test_journey_upstream_error(self, client):
        async def mock_hafas(request, method, req):
            return {"error": "upstream_error", "detail": "HAFAS error"}

        with patch("proxy._hafas_call", side_effect=mock_hafas):
            resp = await client.post("/api/journey", json={"jid": "2|test|0|80|010626"})
        assert resp.status_code == 502

    @pytest.mark.asyncio
    async def test_stationboard_success(self, client):
        async def mock_hafas(request, method, req):
            return MOCK_HAFAS_STATIONBOARD

        with patch("proxy._hafas_call", side_effect=mock_hafas):
            resp = await client.post("/api/stationboard",
                                     json={"lid": "A=1@L=6003411@", "type": "DEP", "dur": 60})
        assert resp.status_code == 200
        data = resp.json()
        assert "jnyL" in data

    @pytest.mark.asyncio
    async def test_stationboard_upstream_error(self, client):
        async def mock_hafas(request, method, req):
            return {"error": "upstream_error", "detail": "HAFAS error"}

        with patch("proxy._hafas_call", side_effect=mock_hafas):
            resp = await client.post("/api/stationboard",
                                     json={"lid": "A=1@L=6003411@", "type": "DEP", "dur": 60})
        assert resp.status_code == 502

    @pytest.mark.asyncio
    async def test_stationboard_cache_hit(self, client):
        call_count = [0]

        async def mock_hafas(request, method, req):
            call_count[0] += 1
            return MOCK_HAFAS_STATIONBOARD

        with patch("proxy._hafas_call", side_effect=mock_hafas):
            await client.post("/api/stationboard", json={"lid": "A=1@L=6003411@", "type": "DEP", "dur": 60})
            await client.post("/api/stationboard", json={"lid": "A=1@L=6003411@", "type": "DEP", "dur": 60})
        assert call_count[0] == 1

    @pytest.mark.asyncio
    async def test_line_search_success(self, client):
        async def mock_hafas(request, method, req):
            return MOCK_HAFAS_VEHICLES

        with patch("proxy._hafas_call", side_effect=mock_hafas):
            resp = await client.get("/api/line_search?q=721")
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] >= 1
        assert data["vehicles"][0]["line"] == "721"

    @pytest.mark.asyncio
    async def test_line_search_no_match(self, client):
        async def mock_hafas(request, method, req):
            return MOCK_HAFAS_VEHICLES

        with patch("proxy._hafas_call", side_effect=mock_hafas):
            resp = await client.get("/api/line_search?q=999")
        assert resp.status_code == 200
        assert resp.json()["count"] == 0

    @pytest.mark.asyncio
    async def test_line_search_upstream_error(self, client):
        async def mock_hafas(request, method, req):
            return {"error": "upstream_error", "detail": "fail"}

        with patch("proxy._hafas_call", side_effect=mock_hafas):
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


class TestCircuitBreaker:
    @pytest.mark.skip(reason="polling endpoint is 410 Gone; these tests will be removed once the handler itself is deleted")
    @pytest.mark.asyncio
    async def test_breaker_open_returns_502_or_stale(self, client):
        breaker.failures = 5
        breaker.last_failure_time = time.time()

        async def mock_hafas(request, method, req):
            return {"error": "upstream_unavailable", "detail": "Service temporarily unavailable"}

        with patch("proxy._hafas_call", side_effect=mock_hafas):
            resp = await client.get("/api/vehicles?swLat=49.3&swLon=8.6&neLat=49.4&neLon=8.7")
        assert resp.status_code == 502

    @pytest.mark.skip(reason="polling endpoint is 410 Gone; these tests will be removed once the handler itself is deleted")
    @pytest.mark.asyncio
    async def test_breaker_records_failure(self, client):
        async def mock_hafas(request, method, req):
            breaker.record_failure()
            return {"error": "upstream_error", "detail": "HAFAS error"}

        with patch("proxy._hafas_call", side_effect=mock_hafas):
            await client.get("/api/vehicles?swLat=49.3&swLon=8.6&neLat=49.4&neLon=8.7")
        assert breaker.failures >= 1


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




# ============================================================================
# /api/vehicles connected-clients header behavior
# ============================================================================

@pytest.fixture
def fresh_connected_clients(monkeypatch):
    """Stub fixture. ConnectedClients has been removed; the tests using this
    fixture are all @pytest.mark.skip and will be deleted once the SSE
    migration is complete. The fixture returns a placeholder so collection
    succeeds without importing removed symbols."""
    class _Stub:
        def count(self): return 0
        def touch(self, *a, **kw): pass
    return _Stub()


@pytest.mark.skip(reason="polling endpoint is 410 Gone; these tests will be removed once the handler itself is deleted")
@pytest.mark.asyncio
async def test_vehicles_with_valid_client_id_increments(fresh_connected_clients):
    """Gültiger X-Client-Id Header → connectedClients im Response."""
    import proxy

    async def mock_hafas(request, method, req):
        return {"common": {"prodL": [], "locL": []}, "jnyL": []}

    with patch.object(proxy, '_hafas_call', side_effect=mock_hafas):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get(
                "/api/vehicles?swLat=49.3&swLon=8.6&neLat=49.4&neLon=8.7",
                headers={"X-Client-Id": "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"},
            )
    assert resp.status_code == 200
    data = resp.json()
    assert data.get("connectedClients") == "1"
    assert fresh_connected_clients.count() == 1


@pytest.mark.skip(reason="polling endpoint is 410 Gone; these tests will be removed once the handler itself is deleted")
@pytest.mark.asyncio
async def test_vehicles_without_client_id_no_increment(fresh_connected_clients):
    """Kein Header → kein Increment (curl-Fall)."""
    import proxy

    async def mock_hafas(request, method, req):
        return {"common": {"prodL": [], "locL": []}, "jnyL": []}

    with patch.object(proxy, '_hafas_call', side_effect=mock_hafas):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/vehicles?swLat=49.3&swLon=8.6&neLat=49.4&neLon=8.7")
    assert resp.status_code == 200
    assert fresh_connected_clients.count() == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid_cid", [
    "--------",
    "ZZZZZZZZ-ZZZZ-4ZZZ-ZZZZ-ZZZZZZZZZZZZ",   # uppercase + non-hex
    "AAAAAAAA-AAAA-4AAA-AAAA-AAAAAAAAAAAA",   # uppercase
    "a" * 1000,                                # length-overflow
    "aaaaaaaa-aaaa-3aaa-aaaa-aaaaaaaaaaaa",   # falsche v3
    "aaaaaaaa-aaaa-4aaa-0aaa-aaaaaaaaaaaa",   # falsche variant
    "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa",    # zu kurz
    "",                                        # leer
])
@pytest.mark.skip(reason="polling endpoint is 410 Gone; these tests will be removed once the handler itself is deleted")
async def test_vehicles_with_invalid_client_id_no_increment(fresh_connected_clients, invalid_cid):
    """Ungültige X-Client-Id wird ignoriert."""
    import proxy

    async def mock_hafas(request, method, req):
        return {"common": {"prodL": [], "locL": []}, "jnyL": []}

    with patch.object(proxy, '_hafas_call', side_effect=mock_hafas):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get(
                "/api/vehicles?swLat=49.3&swLon=8.6&neLat=49.4&neLon=8.7",
                headers={"X-Client-Id": invalid_cid},
            )
    assert resp.status_code == 200
    assert fresh_connected_clients.count() == 0


@pytest.mark.skip(reason="polling endpoint is 410 Gone; these tests will be removed once the handler itself is deleted")
@pytest.mark.asyncio
async def test_vehicles_force_refresh_still_sends_header(fresh_connected_clients):
    """Cache-Buster `_t` umgeht Cache, der Header-Pfad muss trotzdem zählen."""
    import proxy

    async def mock_hafas(request, method, req):
        return {"common": {"prodL": [], "locL": []}, "jnyL": []}

    with patch.object(proxy, '_hafas_call', side_effect=mock_hafas):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get(
                "/api/vehicles?swLat=49.3&swLon=8.6&neLat=49.4&neLon=8.7&_t=12345",
                headers={"X-Client-Id": "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"},
            )
    assert resp.status_code == 200
    assert resp.json().get("connectedClients") == "1"


@pytest.mark.skip(reason="polling endpoint is 410 Gone; these tests will be removed once the handler itself is deleted")
@pytest.mark.asyncio
async def test_vehicles_cache_hit_returns_fresh_bucket(fresh_connected_clients):
    """Cache-Hit-Antwort enthält den AKTUELLEN Bucket, nicht den ge-cachten Wert."""
    import proxy

    async def mock_hafas(request, method, req):
        return {"common": {"prodL": [], "locL": []}, "jnyL": []}

    with patch.object(proxy, '_hafas_call', side_effect=mock_hafas):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            # Erster Call → fillt Cache, 1 Client
            resp1 = await client.get(
                "/api/vehicles?swLat=49.3&swLon=8.6&neLat=49.4&neLon=8.7",
                headers={"X-Client-Id": "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"},
            )
            assert resp1.json().get("connectedClients") == "1"

            # Zweiter Call → cache-hit, anderer Client → bucket sollte "2-5" sein
            resp2 = await client.get(
                "/api/vehicles?swLat=49.3&swLon=8.6&neLat=49.4&neLon=8.7",
                headers={"X-Client-Id": "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb"},
            )
            assert resp2.status_code == 200
            assert resp2.json().get("connectedClients") == "2"  # frischer Counter!


@pytest.mark.skip(reason="polling endpoint is 410 Gone; these tests will be removed once the handler itself is deleted")
@pytest.mark.asyncio
async def test_vehicles_stale_on_error_no_count(fresh_connected_clients):
    """Stale-on-Error-Pfad darf connectedClients NICHT mitsenden."""
    import proxy

    # Erst echten Cache fillen
    async def mock_hafas_ok(request, method, req):
        return {"common": {"prodL": [], "locL": []}, "jnyL": [{"jid": "x"}]}

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch.object(proxy, '_hafas_call', side_effect=mock_hafas_ok):
            await client.get(
                "/api/vehicles?swLat=49.3&swLon=8.6&neLat=49.4&neLon=8.7",
                headers={"X-Client-Id": "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"},
            )

        # Dann Cache invalidieren und Error simulieren
        cache._mono_ts = 0.0  # forciert cache miss
        cache._ts = 0
        cache._key = None
        # stale_data ist gesetzt (vom ersten Call)

        async def mock_hafas_err(request, method, req):
            return {"error": "upstream"}

        # Force fresh fetch via _t param
        with patch.object(proxy, '_hafas_call', side_effect=mock_hafas_err):
            resp = await client.get(
                "/api/vehicles?swLat=49.3&swLon=8.6&neLat=49.4&neLon=8.7&_t=999",
                headers={"X-Client-Id": "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"},
            )
        # Stale-Pfad: keine connectedClients
        if resp.status_code == 200:
            data = resp.json()
            assert "connectedClients" not in data, "Stale-Pfad darf kein bucket leaken"


@pytest.mark.skip(reason="polling endpoint is 410 Gone; these tests will be removed once the handler itself is deleted")
@pytest.mark.asyncio
async def test_vehicles_per_ip_cap_logs_warning(fresh_connected_clients, caplog):
    """101 verschiedene UUIDs von einer IP → der 101. wird abgelehnt (Cap=100)."""
    import proxy
    import logging as _log

    async def mock_hafas(request, method, req):
        return {"common": {"prodL": [], "locL": []}, "jnyL": []}

    with patch.object(proxy, '_hafas_call', side_effect=mock_hafas):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            with caplog.at_level(_log.WARNING, logger="busradar"):
                # 100 OK, dann 101 reject
                for i in range(101):
                    h = f"{i:032x}"
                    cid = f"{h[0:8]}-{h[8:12]}-4{h[13:16]}-8{h[17:20]}-{h[20:32]}"
                    await client.get(
                        "/api/vehicles?swLat=49.3&swLon=8.6&neLat=49.4&neLon=8.7",
                        headers={"X-Client-Id": cid},
                    )
    assert fresh_connected_clients.count() == 100
    # Mindestens ein cap-reject log
    rejects = [r for r in caplog.records if "cap-reject" in r.getMessage()]
    assert len(rejects) >= 1
