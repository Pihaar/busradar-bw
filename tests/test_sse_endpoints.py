"""Integration tests for the SSE endpoints in proxy.py.

Covers the contracts of /api/stream/, /api/stream/viewport, /api/stream/select.
Pure unit-level (no real HAFAS), uses FastAPI TestClient via httpx.AsyncClient
+ an asgi-transport."""
from __future__ import annotations

import json
import pytest
from httpx import ASGITransport, AsyncClient

from proxy import app, _VERSION
import fanout


class _NullCM:
    async def __aenter__(self): return self
    async def __aexit__(self, *a): return None


@pytest.fixture
def fresh_registry(monkeypatch):
    """Replace the module-level SubscriberRegistry with a fresh one per test so
    tests don't bleed cookies/subscribers into each other.

    Also rebuild `fanout.tick_condition` and reset `tick_seq` so the
    Condition is bound to the current event loop (asyncio.Condition() picks
    up the loop on first await; if it was constructed under a different
    loop at import time, wait_for raises 'attached to a different loop')."""
    import asyncio as _a
    new = fanout.SubscriberRegistry()
    monkeypatch.setattr(fanout, "registry", new)
    monkeypatch.setattr(fanout, "tick_condition", _a.Condition())
    monkeypatch.setattr(fanout, "tick_seq", 0)
    yield new


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://localhost:8000") as c:
        yield c


# === GET /api/stream/ ===

class TestSSEStream:
    @pytest.mark.skip(reason="SSE stream test hangs under httpx-asgi; verified via curl smoke")
    @pytest.mark.asyncio
    async def test_first_event_is_subscribe_with_version(self, client, fresh_registry):
        # Headers + first SSE frames are smoke-tested live with curl.
        # httpx ASGITransport doesn't cleanly close streaming responses against
        # an async generator that never returns (keepalive loop), so this is
        # parked. Live coverage:
        #   curl -sN -D /tmp/h.txt http://127.0.0.1:.../api/stream/
        pass

    @pytest.mark.asyncio
    async def test_cap_hit_returns_429_with_scope(self, client, fresh_registry, monkeypatch):
        """When subscribe() raises CapExceeded, the route returns 429 with
        the scope and a Retry-After header in the 30-90s range."""
        async def raise_cap(ip):
            raise fanout.CapExceeded("ip", 20)
        monkeypatch.setattr(fresh_registry, "subscribe", raise_cap)
        resp = await client.get("/api/stream/")
        assert resp.status_code == 429
        body = resp.json()
        assert body["error"] == "rate_limit"
        assert body["scope"] == "ip"
        assert body["limit"] == 20
        assert 30 <= body["retryAfter"] <= 90
        assert "retry-after" in {k.lower() for k in resp.headers.keys()}


# === POST /api/stream/viewport ===

class TestStreamViewport:
    @pytest.mark.asyncio
    async def test_missing_origin_returns_403(self, client, fresh_registry):
        resp = await client.post(
            "/api/stream/viewport",
            content='{"swLat":49,"swLon":8,"neLat":50,"neLon":9}',
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 403
        assert resp.json()["error"] == "origin_mismatch"

    @pytest.mark.asyncio
    async def test_wrong_origin_returns_403(self, client, fresh_registry):
        resp = await client.post(
            "/api/stream/viewport",
            content='{"swLat":49,"swLon":8,"neLat":50,"neLon":9}',
            headers={"Origin": "https://evil.example", "Content-Type": "application/json"},
        )
        assert resp.status_code == 403

    @pytest.mark.asyncio
    async def test_missing_cookie_returns_401(self, client, fresh_registry):
        resp = await client.post(
            "/api/stream/viewport",
            content='{"swLat":49,"swLon":8,"neLat":50,"neLon":9}',
            headers={"Origin": "http://localhost:8000", "Content-Type": "application/json"},
        )
        assert resp.status_code == 401
        assert resp.json()["error"] == "missing_cookie"

    @pytest.mark.asyncio
    async def test_unknown_cookie_returns_409(self, client, fresh_registry):
        resp = await client.post(
            "/api/stream/viewport",
            content='{"swLat":49,"swLon":8,"neLat":50,"neLon":9}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": "busradar_sse=does-not-exist",
            },
        )
        assert resp.status_code == 409
        assert resp.json()["error"] == "unknown_connection"

    @pytest.mark.asyncio
    async def test_body_too_large_returns_413_via_content_length(self, client, fresh_registry):
        # Inject a subscriber via the registry directly so we get past origin+cookie
        # then claim a 5 KB body via Content-Length; server must reject pre-read.
        sub = await fresh_registry.subscribe("127.0.0.1")
        big = '{"a":"' + ("x" * 5000) + '"}'
        resp = await client.post(
            "/api/stream/viewport",
            content=big,
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 413
        assert resp.json()["error"] == "body_too_large"

    @pytest.mark.asyncio
    async def test_happy_path_updates_viewport(self, client, fresh_registry):
        sub = await fresh_registry.subscribe("127.0.0.1")
        resp = await client.post(
            "/api/stream/viewport",
            content='{"swLat":49.0,"swLon":8.0,"neLat":49.6,"neLon":9.0,"posMode":"REPORT_ONLY"}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 200
        assert resp.json() == {"ok": True}
        assert sub.viewport == (49.0, 8.0, 49.6, 9.0)
        assert sub.pos_mode == "REPORT_ONLY"

    @pytest.mark.asyncio
    async def test_invalid_payload_returns_422(self, client, fresh_registry):
        sub = await fresh_registry.subscribe("127.0.0.1")
        # neLat <= swLat fails the cross-field validator
        resp = await client.post(
            "/api/stream/viewport",
            content='{"swLat":50,"swLon":8,"neLat":49,"neLon":9}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_rate_limit_per_subscriber(self, client, fresh_registry):
        """5 rapid POSTs: first 3 pass (burst), 4th gets 429."""
        sub = await fresh_registry.subscribe("127.0.0.1")
        headers = {
            "Origin": "http://localhost:8000",
            "Content-Type": "application/json",
            "Cookie": f"busradar_sse={sub.connection_id}",
        }
        body = '{"swLat":49,"swLon":8,"neLat":50,"neLon":9}'
        accepted = 0
        rate_limited = 0
        for _ in range(5):
            r = await client.post("/api/stream/viewport", content=body, headers=headers)
            if r.status_code == 200:
                accepted += 1
            elif r.status_code == 429:
                rate_limited += 1
                assert r.json()["scope"] == "subscriber"
        assert accepted == 3  # burst
        assert rate_limited == 2


# === POST /api/stream/select ===

class TestStreamSelect:
    @pytest.mark.asyncio
    async def test_select_journey_happy_path(self, client, fresh_registry):
        """Valid journey selection stores it on the subscriber and
        wakes the loop (fire_tick)."""
        sub = await fresh_registry.subscribe("127.0.0.1")
        resp = await client.post(
            "/api/stream/select",
            content='{"type":"journey","id":"1|12345|0|80|22052026"}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 200
        assert isinstance(sub.selection, fanout.JourneySelection)
        assert sub.selection.jid == "1|12345|0|80|22052026"

    @pytest.mark.asyncio
    async def test_select_stationboard_happy_path(self, client, fresh_registry):
        sub = await fresh_registry.subscribe("127.0.0.1")
        resp = await client.post(
            "/api/stream/select",
            content='{"type":"stationboard","id":"A=1@L=6003411@"}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 200
        assert isinstance(sub.selection, fanout.StationSelection)
        assert sub.selection.lid == "A=1@L=6003411@"

    @pytest.mark.asyncio
    async def test_select_none_clears(self, client, fresh_registry):
        sub = await fresh_registry.subscribe("127.0.0.1")
        sub.selection = fanout.JourneySelection(jid="prev")
        resp = await client.post(
            "/api/stream/select",
            content='{"type":"none","id":""}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 200
        assert sub.selection is None

    @pytest.mark.asyncio
    async def test_select_invalid_jid_rejected(self, client, fresh_registry):
        sub = await fresh_registry.subscribe("127.0.0.1")
        resp = await client.post(
            "/api/stream/select",
            content='{"type":"journey","id":"<script>alert(1)</script>"}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_select_invalid_lid_rejected(self, client, fresh_registry):
        sub = await fresh_registry.subscribe("127.0.0.1")
        resp = await client.post(
            "/api/stream/select",
            content='{"type":"stationboard","id":"not-a-lid"}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_select_rapid_switch_bumps_selection_seq(self, client, fresh_registry):
        """Rapid journey→stationboard→journey switches must monotonically
        increment selection_seq so the SSE loop discards stale results."""
        sub = await fresh_registry.subscribe("127.0.0.1")
        seq_initial = getattr(sub, "selection_seq", 0)
        for body in [
            '{"type":"journey","id":"1|11"}',
            '{"type":"stationboard","id":"A=1@L=6003411@"}',
            '{"type":"journey","id":"1|22"}',
        ]:
            await client.post(
                "/api/stream/select",
                content=body,
                headers={
                    "Origin": "http://localhost:8000",
                    "Content-Type": "application/json",
                    "Cookie": f"busradar_sse={sub.connection_id}",
                },
            )
        assert sub.selection_seq == seq_initial + 3

    @pytest.mark.asyncio
    async def test_select_enforces_origin_first(self, client, fresh_registry):
        resp = await client.post(
            "/api/stream/select",
            content='{}',
            headers={"Origin": "https://evil.example"},
        )
        assert resp.status_code == 403

    @pytest.mark.asyncio
    async def test_select_rejects_body_too_large_via_content_length(self, client, fresh_registry):
        sub = await fresh_registry.subscribe("127.0.0.1")
        big = '{"x":"' + ("y" * 5000) + '"}'
        resp = await client.post(
            "/api/stream/select",
            content=big,
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 413


# === Regression coverage for the connected-clients refactor ===
# (Counter-source switch, fire_tick wake-up, client_activity-via-SSE)

class TestCounterSourceMigration:
    """Asserts that the SSE `connected` count is sourced from
    len(SubscriberRegistry) and tracks subscribe/unsubscribe atomically."""

    @pytest.mark.asyncio
    async def test_count_reflects_registry_length(self, fresh_registry):
        assert len(fresh_registry) == 0
        await fresh_registry.subscribe("10.0.0.1")
        assert len(fresh_registry) == 1
        sub2 = await fresh_registry.subscribe("10.0.0.2")
        assert len(fresh_registry) == 2
        await fresh_registry.unsubscribe(sub2.connection_id)
        assert len(fresh_registry) == 1

    @pytest.mark.asyncio
    async def test_viewport_post_triggers_fire_tick(self, client, fresh_registry, monkeypatch):
        """POST /api/stream/viewport must wake the subscriber loop
        immediately (Plan: 'sofortiger Pull bei Viewport-Change'). Without
        this the user waits up to 5 min for the next calibrator tick."""
        sub = await fresh_registry.subscribe("127.0.0.1")
        fired = {"count": 0}
        original = fanout.fire_tick

        async def spy():
            fired["count"] += 1
            return await original()

        monkeypatch.setattr(fanout, "fire_tick", spy)
        resp = await client.post(
            "/api/stream/viewport",
            content='{"swLat":49.0,"swLon":8.0,"neLat":49.6,"neLon":9.0}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 200
        assert fired["count"] == 1


class TestClientActivityFromSSE:
    """When the polling endpoint (the old activity source) became 410, the
    calibrator-active gate started depending on SSE handlers touching
    client_activity. Regression-guard that link so the calibrator can't
    silently fall back into IDLE_CALIB_INTERVAL=30min mode."""

    @pytest.mark.skip(
        reason="httpx ASGITransport hangs on the SSE keepalive loop; same "
               "root cause as TestSSEStream::test_first_event_is_subscribe_"
               "with_version. Touch is verified end-to-end via curl smoke "
               "test (/api/health.calibrator_mode flips to 'active' after one "
               "SSE subscribe)."
    )
    @pytest.mark.asyncio
    async def test_subscribe_touches_client_activity(self):
        pass
