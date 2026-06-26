"""Integration tests for the SSE endpoints in proxy.py.

Covers the contracts of /api/stream/, /api/stream/viewport, /api/stream/select.
Pure unit-level (no real HAFAS), uses FastAPI TestClient via httpx.AsyncClient
+ an asgi-transport."""
from __future__ import annotations

import asyncio
import pytest
from httpx import ASGITransport, AsyncClient

from proxy import app, SSE_COOKIE_NAME
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
    loop at import time, wait_for raises 'attached to a different loop').

    Resets the per-IP rate-limit bucket too, otherwise tests sharing the
    same client IP (127.0.0.1) bleed token state across the suite."""
    import asyncio as _a
    import proxy as _proxy
    new = fanout.SubscriberRegistry()
    monkeypatch.setattr(fanout, "registry", new)
    monkeypatch.setattr(fanout, "tick_condition", _a.Condition())
    monkeypatch.setattr(fanout, "tick_seq", 0)
    _proxy._post_rate_per_ip.clear()
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
                "Cookie": f"{SSE_COOKIE_NAME}=does-not-exist",
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
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
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
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
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
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
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
            "Cookie": f"__Host-busradar_sse={sub.connection_id}",
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
            content='{"selection":{"kind":"journey","jid":"1|12345|0|80|22052026"}}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
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
            content='{"selection":{"kind":"stationboard","lid":"A=1@L=6003411@"}}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
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
            content='{"selection":null}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 200
        assert sub.selection is None

    @pytest.mark.asyncio
    async def test_select_invalid_jid_rejected(self, client, fresh_registry):
        sub = await fresh_registry.subscribe("127.0.0.1")
        resp = await client.post(
            "/api/stream/select",
            content='{"selection":{"kind":"journey","jid":"<script>alert(1)</script>"}}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_select_invalid_lid_rejected(self, client, fresh_registry):
        sub = await fresh_registry.subscribe("127.0.0.1")
        resp = await client.post(
            "/api/stream/select",
            content='{"selection":{"kind":"stationboard","lid":"not-a-lid"}}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_select_rapid_switch_bumps_selection_seq(self, client, fresh_registry):
        """Rapid journey→stationboard→journey switches must monotonically
        increment selection_seq so the SSE loop discards stale results."""
        sub = await fresh_registry.subscribe("127.0.0.1")
        seq_initial = sub.selection_seq
        for body in [
            '{"selection":{"kind":"journey","jid":"1|11111|0|80|22052026"}}',
            '{"selection":{"kind":"stationboard","lid":"A=1@L=6003411@"}}',
            '{"selection":{"kind":"journey","jid":"1|22222|0|80|22052026"}}',
        ]:
            await client.post(
                "/api/stream/select",
                content=body,
                headers={
                    "Origin": "http://localhost:8000",
                    "Content-Type": "application/json",
                    "Cookie": f"__Host-busradar_sse={sub.connection_id}",
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
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
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
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
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


# === Regression guards for the post-deploy fix wave ===


class TestSelectRateLimit:
    """`/api/stream/select` MUST share the per-subscriber token bucket with
    /viewport. Without it, a single attacker EventSource can spam selects and
    burn the registry's loop budget."""

    @pytest.mark.asyncio
    async def test_rate_limit_kicks_in_after_burst(self, client, fresh_registry):
        sub = await fresh_registry.subscribe("127.0.0.1")
        headers = {
            "Origin": "http://localhost:8000",
            "Content-Type": "application/json",
            "Cookie": f"__Host-busradar_sse={sub.connection_id}",
        }
        bodies = [
            '{"selection":{"kind":"journey","jid":"1|11111|0|80|22052026"}}',
            '{"selection":{"kind":"journey","jid":"1|22222|0|80|22052026"}}',
            '{"selection":{"kind":"journey","jid":"1|33333|0|80|22052026"}}',
            '{"selection":{"kind":"journey","jid":"1|44444|0|80|22052026"}}',
            '{"selection":{"kind":"journey","jid":"1|55555|0|80|22052026"}}',
        ]
        accepted = 0
        rate_limited = 0
        for b in bodies:
            r = await client.post("/api/stream/select", content=b, headers=headers)
            if r.status_code == 200:
                accepted += 1
            elif r.status_code == 429:
                rate_limited += 1
                assert r.json()["scope"] == "subscriber"
        assert accepted == 3  # burst capacity
        assert rate_limited == 2

    @pytest.mark.asyncio
    async def test_per_ip_rate_limit_closes_cookie_rotation_bypass(self, client, fresh_registry):
        """Same IP spawns N subscribers, each with a fresh burst-3 bucket.
        Without a per-IP cap an attacker could fire 60 POSTs (3 × 20 subs).
        The per-IP bucket caps the cross-subscriber total."""
        subs = [await fresh_registry.subscribe("127.0.0.1") for _ in range(15)]
        body = '{"selection":null}'
        accepted = 0
        for sub in subs:
            headers = {
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            }
            for _ in range(3):  # try to drain each subscriber's burst
                r = await client.post("/api/stream/select", content=body, headers=headers)
                if r.status_code == 200:
                    accepted += 1
        # With per-IP burst 30, total accepted is capped near 30. Without
        # the per-IP cap an attacker would land 45 (15 × 3); the cap closes
        # that bypass. Small margin for refill mid-test.
        assert accepted <= 35, f"per-IP cap should limit total POSTs, got {accepted}"
        assert accepted < 45, "without per-IP cap all 45 would have landed"


class TestSelectNoFireTickAmplification:
    """`/api/stream/select` MUST NOT call fanout.fire_tick() — that's the
    global broadcast that wakes every subscriber for one user's panel toggle.
    The next natural HAFAS tick ships the selection."""

    @pytest.mark.asyncio
    async def test_select_does_not_invoke_fire_tick(self, client, fresh_registry, monkeypatch):
        sub = await fresh_registry.subscribe("127.0.0.1")
        fired = {"count": 0}
        original = fanout.fire_tick

        async def spy():
            fired["count"] += 1
            return await original()

        monkeypatch.setattr(fanout, "fire_tick", spy)
        resp = await client.post(
            "/api/stream/select",
            content='{"selection":{"kind":"journey","jid":"1|99999|0|80|22052026"}}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 200
        assert fired["count"] == 0


class TestViewportSkipsFireTickWhenBboxUnchanged:
    """`/api/stream/viewport` is allowed to wake the loop, but only when the
    quantized bbox actually changed. Repeat-POST with same payload is a no-op."""

    @pytest.mark.asyncio
    async def test_repeat_viewport_post_does_not_fire_tick(self, client, fresh_registry, monkeypatch):
        sub = await fresh_registry.subscribe("127.0.0.1")
        fired = {"count": 0}
        original = fanout.fire_tick

        async def spy():
            fired["count"] += 1
            return await original()

        monkeypatch.setattr(fanout, "fire_tick", spy)
        body = '{"swLat":49.0,"swLon":8.0,"neLat":49.6,"neLon":9.0}'
        headers = {
            "Origin": "http://localhost:8000",
            "Content-Type": "application/json",
            "Cookie": f"__Host-busradar_sse={sub.connection_id}",
        }
        # First POST: bbox is new → fire_tick fires.
        await client.post("/api/stream/viewport", content=body, headers=headers)
        # Second POST: same bbox → must skip.
        await client.post("/api/stream/viewport", content=body, headers=headers)
        assert fired["count"] == 1


class TestSelectIdempotentReclick:
    """Re-clicking the same selection (same jid) is a no-op: selection_seq
    does NOT bump, the SSE loop's staleness guard stays valid for the
    in-flight fetch from the previous click."""

    @pytest.mark.asyncio
    async def test_repeat_selection_does_not_bump_seq(self, client, fresh_registry):
        sub = await fresh_registry.subscribe("127.0.0.1")
        headers = {
            "Origin": "http://localhost:8000",
            "Content-Type": "application/json",
            "Cookie": f"__Host-busradar_sse={sub.connection_id}",
        }
        body = '{"selection":{"kind":"journey","jid":"1|77777|0|80|22052026"}}'
        await client.post("/api/stream/select", content=body, headers=headers)
        seq_after_first = sub.selection_seq
        await client.post("/api/stream/select", content=body, headers=headers)
        assert sub.selection_seq == seq_after_first


class TestStreamCrossOriginRejection:
    """GET /api/stream/ MUST refuse cross-site Sec-Fetch-Site to prevent
    cross-origin EventSource from burning the victim IP's slot cap."""

    @pytest.mark.asyncio
    async def test_cross_site_sec_fetch_site_rejected(self, client, fresh_registry):
        resp = await client.get(
            "/api/stream/",
            headers={"Sec-Fetch-Site": "cross-site"},
        )
        assert resp.status_code == 403
        assert resp.json()["error"] == "cross_origin"

    @pytest.mark.asyncio
    async def test_same_origin_sec_fetch_site_does_not_403(self, client, fresh_registry, monkeypatch):
        # Force a CapExceeded so the route returns 429 *before* the SSE
        # streaming response opens; that lets us verify the Sec-Fetch-Site
        # branch without entering the keepalive loop (which hangs ASGI).
        async def raise_cap(ip):
            raise fanout.CapExceeded("ip", 20)
        monkeypatch.setattr(fresh_registry, "subscribe", raise_cap)
        resp = await client.get(
            "/api/stream/",
            headers={"Sec-Fetch-Site": "same-origin"},
        )
        assert resp.status_code == 429

    @pytest.mark.asyncio
    async def test_missing_sec_fetch_site_accepted(self, client, fresh_registry, monkeypatch):
        # Older browsers / curl don't send Sec-Fetch-Site at all — must accept.
        async def raise_cap(ip):
            raise fanout.CapExceeded("ip", 20)
        monkeypatch.setattr(fresh_registry, "subscribe", raise_cap)
        resp = await client.get("/api/stream/")
        assert resp.status_code == 429  # not 403

    @pytest.mark.asyncio
    async def test_wrong_origin_rejected_on_get(self, client, fresh_registry, monkeypatch):
        """Defense-in-depth: GET /api/stream/ rejects Origin not in ALLOWED.
        Closes the gap when Sec-Fetch-Site is stripped by intermediaries."""
        async def raise_cap(ip):
            raise fanout.CapExceeded("ip", 20)
        monkeypatch.setattr(fresh_registry, "subscribe", raise_cap)
        resp = await client.get(
            "/api/stream/",
            headers={"Origin": "https://evil.example"},
        )
        assert resp.status_code == 403
        assert resp.json()["error"] == "origin_mismatch"


class TestJidPatternStrictness:
    """JID_PATTERN must accept real HAFAS jids while rejecting cache-key
    fabrication via Unicode-category Nd digits or control chars."""

    @pytest.mark.asyncio
    async def test_real_hafas_jid_accepted(self, client, fresh_registry):
        """Real wire-format jid is `<digit>|#-separated-fields-with-spaces#`,
        not the simplified `1|12345|0|80|date` form documented as example."""
        sub = await fresh_registry.subscribe("127.0.0.1")
        real_jid = "2|#VN#1#ST#1782426904#PI#0#ZI#35566#TA#7#DA#260626#1S#44278343#1T#1605#CA#Bus#ZE#721#ZB#Bus  721#PC#5#"
        body = '{"selection":{"kind":"journey","jid":"' + real_jid + '"}}'
        resp = await client.post(
            "/api/stream/select",
            content=body,
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 200, f"real HAFAS jid must be accepted, got {resp.text}"

    @pytest.mark.asyncio
    async def test_control_char_in_jid_rejected(self, client, fresh_registry):
        sub = await fresh_registry.subscribe("127.0.0.1")
        # NUL byte inside the value — must be rejected by the JID_PATTERN
        # character class, otherwise it would split on logging or DB writes.
        resp = await client.post(
            "/api/stream/select",
            content='{"selection":{"kind":"journey","jid":"1|abc\\u0000def|0|80|22052026"}}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 422


class TestLidPatternEndAnchored:
    """LID_PATTERN must end-anchor — trailing control characters slip
    through a prefix-only pattern and create distinct cache keys."""

    @pytest.mark.asyncio
    async def test_real_hafas_lid_with_german_stop_name_accepted(self, client, fresh_registry):
        """Real LIDs include the German stop name (`O=...@`), often with
        spaces and umlauts. The regex must accept these."""
        sub = await fresh_registry.subscribe("127.0.0.1")
        body = '{"selection":{"kind":"stationboard","lid":"A=1@O=Müllheim Bf@L=6003411@"}}'
        resp = await client.post(
            "/api/stream/select",
            content=body,
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 200, f"umlaut LID must be accepted, got {resp.text}"

    @pytest.mark.asyncio
    async def test_real_hafas_full_qualified_lid_accepted(self, client, fresh_registry):
        """Real-world fully-qualified LID from a production click — must
        accept the comma in the provider metadata and the long form with
        X/Y/U/i fields. An earlier tightening dropped the comma and broke
        every Wiesloch-Walldorf stop click in production (422 on the
        legacy POST too)."""
        sub = await fresh_registry.subscribe("127.0.0.1")
        full = "A=1@O=Wiesloch-Walldorf Bahnhof@X=8664801@Y=49291306@U=80@L=44278341@i=A×de:08226:4252:1:A,b×BRN_304521@"
        # Wire JSON: pass the raw string; httpx will escape it properly.
        import json
        body = json.dumps({"selection": {"kind": "stationboard", "lid": full}})
        resp = await client.post(
            "/api/stream/select",
            content=body,
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 200, f"full-form LID must be accepted, got {resp.text}"

    @pytest.mark.asyncio
    async def test_lid_trailing_newline_rejected(self, client, fresh_registry):
        # In Python, `$` matches before a trailing `\n` even without
        # MULTILINE. Use \\Z to anchor at true end of string or this LID
        # slips through and reaches HAFAS with an injected newline.
        sub = await fresh_registry.subscribe("127.0.0.1")
        resp = await client.post(
            "/api/stream/select",
            content='{"selection":{"kind":"stationboard","lid":"A=1@L=6003411@\\n"}}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_lid_trailing_cr_rejected(self, client, fresh_registry):
        sub = await fresh_registry.subscribe("127.0.0.1")
        resp = await client.post(
            "/api/stream/select",
            content='{"selection":{"kind":"stationboard","lid":"A=1@L=6003411@\\r"}}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_lid_trailing_crlf_rejected(self, client, fresh_registry):
        sub = await fresh_registry.subscribe("127.0.0.1")
        resp = await client.post(
            "/api/stream/select",
            content='{"selection":{"kind":"stationboard","lid":"A=1@L=6003411@\\r\\n"}}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_jid_trailing_newline_rejected(self, client, fresh_registry):
        # JID_PATTERN uses \\A...\\Z for the same reason as LID — `$` lets
        # a trailing newline through in default mode.
        sub = await fresh_registry.subscribe("127.0.0.1")
        resp = await client.post(
            "/api/stream/select",
            content='{"selection":{"kind":"journey","jid":"1|abc|0|80|22052026\\n"}}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_lid_with_parentheses_accepted(self, client, fresh_registry):
        # Station names with parens like `Köln(Hbf)` or `Frankfurt(Main)Hbf`
        # exist in HAFAS. The hotfix widened LID_PATTERN; lock that in.
        sub = await fresh_registry.subscribe("127.0.0.1")
        import json
        body = json.dumps({"selection": {"kind": "stationboard", "lid": "A=1@O=Köln(Hbf)@L=8000207@"}})
        resp = await client.post(
            "/api/stream/select",
            content=body,
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_lid_trailing_garbage_rejected(self, client, fresh_registry):
        sub = await fresh_registry.subscribe("127.0.0.1")
        # NUL byte after a valid prefix — must be rejected (NUL isn't in
        # the alphabet, and the pattern is end-anchored).
        resp = await client.post(
            "/api/stream/select",
            content='{"selection":{"kind":"stationboard","lid":"A=1@\\u0000bad"}}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 422


class TestSelectEdgeCases:
    """Corner cases that the prior test surface did not cover."""

    @pytest.mark.asyncio
    async def test_empty_body_rejected(self, client, fresh_registry):
        sub = await fresh_registry.subscribe("127.0.0.1")
        resp = await client.post(
            "/api/stream/select",
            content=b"",
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_malformed_json_rejected(self, client, fresh_registry):
        sub = await fresh_registry.subscribe("127.0.0.1")
        resp = await client.post(
            "/api/stream/select",
            content='{"type":"journey","id":',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_mixed_case_type_rejected(self, client, fresh_registry):
        sub = await fresh_registry.subscribe("127.0.0.1")
        resp = await client.post(
            "/api/stream/select",
            content='{"selection":{"kind":"Journey","jid":"1|12345|0|80|22052026"}}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_none_type_with_nonempty_id_clears_selection(self, client, fresh_registry):
        sub = await fresh_registry.subscribe("127.0.0.1")
        sub.selection = fanout.JourneySelection(jid="prev")
        resp = await client.post(
            "/api/stream/select",
            content='{"selection":null}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 200
        assert sub.selection is None

    @pytest.mark.asyncio
    async def test_unknown_discriminator_kind_rejected(self, client, fresh_registry):
        sub = await fresh_registry.subscribe("127.0.0.1")
        resp = await client.post(
            "/api/stream/select",
            content='{"selection":{"kind":"unknown","id":"X"}}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 422
        assert resp.json()["error"] == "invalid_payload"

    @pytest.mark.asyncio
    async def test_empty_selection_object_rejected(self, client, fresh_registry):
        sub = await fresh_registry.subscribe("127.0.0.1")
        resp = await client.post(
            "/api/stream/select",
            content='{"selection":{}}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_inner_selection_rejects_extra_fields(self, client, fresh_registry):
        sub = await fresh_registry.subscribe("127.0.0.1")
        resp = await client.post(
            "/api/stream/select",
            content='{"selection":{"kind":"journey","jid":"1|12345|0|80|22052026","evil":"x"}}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_stationboard_default_board_type_dep(self, client, fresh_registry):
        sub = await fresh_registry.subscribe("127.0.0.1")
        resp = await client.post(
            "/api/stream/select",
            content='{"selection":{"kind":"stationboard","lid":"A=1@L=6003411@"}}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 200
        assert isinstance(sub.selection, fanout.StationSelection)
        assert sub.selection.board_type == "DEP"

    @pytest.mark.asyncio
    async def test_stationboard_board_type_arr(self, client, fresh_registry):
        sub = await fresh_registry.subscribe("127.0.0.1")
        resp = await client.post(
            "/api/stream/select",
            content='{"selection":{"kind":"stationboard","lid":"A=1@L=6003411@","board_type":"ARR"}}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 200
        assert sub.selection.board_type == "ARR"

    @pytest.mark.asyncio
    async def test_stationboard_invalid_board_type_rejected(self, client, fresh_registry):
        sub = await fresh_registry.subscribe("127.0.0.1")
        resp = await client.post(
            "/api/stream/select",
            content='{"selection":{"kind":"stationboard","lid":"A=1@L=6003411@","board_type":"BOTH"}}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_stationboard_dur_zero_rejected(self, client, fresh_registry):
        sub = await fresh_registry.subscribe("127.0.0.1")
        resp = await client.post(
            "/api/stream/select",
            content='{"selection":{"kind":"stationboard","lid":"A=1@L=6003411@","dur":0}}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_stationboard_dur_negative_rejected(self, client, fresh_registry):
        sub = await fresh_registry.subscribe("127.0.0.1")
        resp = await client.post(
            "/api/stream/select",
            content='{"selection":{"kind":"stationboard","lid":"A=1@L=6003411@","dur":-60}}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_stationboard_dur_1440_accepted_upper_bound(self, client, fresh_registry):
        sub = await fresh_registry.subscribe("127.0.0.1")
        resp = await client.post(
            "/api/stream/select",
            content='{"selection":{"kind":"stationboard","lid":"A=1@L=6003411@","dur":1440}}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 200
        assert sub.selection.dur == 1440

    @pytest.mark.asyncio
    async def test_stationboard_dur_string_rejected(self, client, fresh_registry):
        sub = await fresh_registry.subscribe("127.0.0.1")
        resp = await client.post(
            "/api/stream/select",
            content='{"selection":{"kind":"stationboard","lid":"A=1@L=6003411@","dur":"60"}}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            },
        )
        # Pydantic v2 with no strict mode actually coerces "60" → 60. The
        # value is then in range and a multiple of 60, so 200 is fine.
        # Locking the current behaviour so a future model_config change
        # to strict=True surfaces visibly.
        assert resp.status_code == 200
        assert sub.selection.dur == 60

    @pytest.mark.asyncio
    async def test_stationboard_default_dur_60(self, client, fresh_registry):
        sub = await fresh_registry.subscribe("127.0.0.1")
        resp = await client.post(
            "/api/stream/select",
            content='{"selection":{"kind":"stationboard","lid":"A=1@L=6003411@"}}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 200
        assert sub.selection.dur == 60

    @pytest.mark.asyncio
    async def test_stationboard_dur_300_accepted(self, client, fresh_registry):
        sub = await fresh_registry.subscribe("127.0.0.1")
        resp = await client.post(
            "/api/stream/select",
            content='{"selection":{"kind":"stationboard","lid":"A=1@L=6003411@","dur":300}}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 200
        assert sub.selection.dur == 300

    @pytest.mark.asyncio
    async def test_stationboard_dur_below_60_rejected(self, client, fresh_registry):
        sub = await fresh_registry.subscribe("127.0.0.1")
        resp = await client.post(
            "/api/stream/select",
            content='{"selection":{"kind":"stationboard","lid":"A=1@L=6003411@","dur":30}}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_stationboard_dur_above_1440_rejected(self, client, fresh_registry):
        sub = await fresh_registry.subscribe("127.0.0.1")
        resp = await client.post(
            "/api/stream/select",
            content='{"selection":{"kind":"stationboard","lid":"A=1@L=6003411@","dur":2000}}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_stationboard_dur_non_multiple_rejected(self, client, fresh_registry):
        # Non-multiples of 60 are 422'd — silent normalisation would have
        # let a confused client inherit a narrower window than it rendered
        # for and trip the midnight-wrap regression that motivated the
        # dur field in the first place.
        sub = await fresh_registry.subscribe("127.0.0.1")
        resp = await client.post(
            "/api/stream/select",
            content='{"selection":{"kind":"stationboard","lid":"A=1@L=6003411@","dur":75}}',
            headers={
                "Origin": "http://localhost:8000",
                "Content-Type": "application/json",
                "Cookie": f"__Host-busradar_sse={sub.connection_id}",
            },
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_stationboard_cache_key_includes_dur(self):
        # Two selections at the same lid but different dur produce distinct
        # cache keys — otherwise a dur=300 subscriber would get served the
        # dur=60 cache hit and lose the midnight-wrap entries it expanded
        # to see.
        sel_60 = fanout.StationSelection(lid="A=1@L=6003411@", dur=60)
        sel_300 = fanout.StationSelection(lid="A=1@L=6003411@", dur=300)
        assert sel_60.cache_key() != sel_300.cache_key()
        assert sel_60.cache_key()[2] == 60
        assert sel_300.cache_key()[2] == 300


class TestUnicodeDigitRejection:
    """JID/LID regex uses [0-9], not \\d — `\\d` in Unicode mode matches
    Arabic-Indic / Devanagari / etc., enabling cache-key fabrication."""

    def test_jid_pattern_does_not_match_unicode_digits(self):
        from proxy import JID_PATTERN
        assert not JID_PATTERN.match("1|abc|0|80|٢٢٠٥٢٠٢٦")
        assert JID_PATTERN.match("1|abc|0|80|22052026")

    def test_lid_pattern_does_not_match_unicode_digits(self):
        from proxy import LID_PATTERN
        assert not LID_PATTERN.match("A=٢٢@L=6003411@")
        assert LID_PATTERN.match("A=1@L=6003411@")


class TestCircuitBreakerDoesNotTripOnInputErrors:
    """HAFAS 200-OK with err != OK is caller-error, not upstream-unhealthy.
    Don't count toward circuit breaker — would let 3 nonsense LIDs trip
    global outage."""

    @pytest.mark.asyncio
    async def test_input_errors_do_not_open_breaker(self):
        import hafas

        class _MockResp:
            def raise_for_status(self): pass
            def json(self): return {"err": "BADREQ", "errTxt": "no such journey"}

        class _MockClient:
            async def post(self, url, json=None): return _MockResp()
        hafas.breaker.failures = 0
        hafas.breaker.last_failure_time = 0.0

        class _MockApp:
            class state:
                client = _MockClient()
        app = _MockApp()

        for _ in range(5):
            res = await hafas._hafas_call_via_app(app, "JourneyDetails", {"jid": "X"})
            assert res.get("error") == "upstream_error"
        assert hafas.breaker.failures == 0
        assert not hafas.breaker.is_open

    @pytest.mark.asyncio
    async def test_network_errors_do_open_breaker(self):
        import hafas
        import httpx as _httpx

        class _MockClient:
            async def post(self, url, json=None):
                raise _httpx.ConnectError("network down")
        hafas.breaker.failures = 0
        hafas.breaker.last_failure_time = 0.0

        class _MockApp:
            class state:
                client = _MockClient()
        app = _MockApp()

        for _ in range(3):
            await hafas._hafas_call_via_app(app, "JourneyDetails", {"jid": "X"})
        assert hafas.breaker.failures == 3
        hafas.breaker.failures = 0
        hafas.breaker.last_failure_time = 0.0


class TestRESTErrorOpacity:
    """Legacy REST endpoints map upstream errors to opaque
    `{"error": "upstream"}` — same shape as SSE — so HAFAS taxonomy
    doesn't leak via differential responses (SEC-236)."""

    @pytest.mark.asyncio
    async def test_journey_upstream_error_opaque(self, client, fresh_registry, monkeypatch):
        import proxy

        async def fake_hafas(_app, _method, _req):
            return {"error": "upstream_unavailable", "detail": "secret-internal-detail"}
        monkeypatch.setattr(proxy, "_hafas_call_via_app", fake_hafas)
        r = await client.post("/api/journey", json={"jid": "1|12345|0|80|22052026"})
        assert r.status_code == 502
        assert r.json() == {"error": "upstream"}


class TestSSEProtocolVersionConstantMatch:
    """Server `SSE_PROTOCOL_VERSION` and the client-side constant must
    stay in lock-step. Drift = silent reload-loops or stale tabs."""

    def test_client_and_server_versions_match(self):
        from proxy import SSE_PROTOCOL_VERSION
        from pathlib import Path
        import re
        refresh_js = Path(__file__).resolve().parent.parent / "static" / "refresh.js"
        text = refresh_js.read_text()
        m = re.search(r"SSE_PROTOCOL_VERSION\s*=\s*['\"]([^'\"]+)['\"]", text)
        assert m, "static/refresh.js must declare SSE_PROTOCOL_VERSION"
        assert m.group(1) == SSE_PROTOCOL_VERSION


class TestDetailFetchSingleflight:
    """Concurrent fetches for the same jid/lid must collapse onto one upstream
    HAFAS call. Without this, N subscribers watching journey J = N round-trips."""

    @pytest.mark.asyncio
    async def test_journey_singleflight_collapses_concurrent_calls(self, monkeypatch):
        from proxy import _fetch_journey_for_subscriber
        import proxy
        call_count = {"n": 0}

        async def fake_hafas(_app, _method, _req):
            call_count["n"] += 1
            await asyncio.sleep(0.05)  # let other callers join the singleflight
            return {"journey": {"jid": _req["jid"]}}

        monkeypatch.setattr(proxy, "_hafas_call_via_app", fake_hafas)
        # Clear caches so we measure miss path
        proxy._journey_cache.clear()
        proxy._inflight_journey.clear()

        results = await asyncio.gather(*[
            _fetch_journey_for_subscriber(None, "1|99999|0|80|22052026")
            for _ in range(5)
        ])
        # All five callers got the same payload
        assert all(r == results[0] for r in results)
        # But only one upstream call happened
        assert call_count["n"] == 1

    @pytest.mark.asyncio
    async def test_stationboard_singleflight_collapses_concurrent_calls(self, monkeypatch):
        from proxy import _fetch_stationboard_for_subscriber
        import proxy
        call_count = {"n": 0}

        async def fake_hafas(_app, _method, _req):
            call_count["n"] += 1
            await asyncio.sleep(0.05)
            return {"jnyL": []}

        monkeypatch.setattr(proxy, "_hafas_call_via_app", fake_hafas)
        proxy._stationboard_cache.clear()
        proxy._inflight_stationboard.clear()

        results = await asyncio.gather(*[
            _fetch_stationboard_for_subscriber(None, "A=1@L=6003411@")
            for _ in range(5)
        ])
        assert all(r == results[0] for r in results)
        assert call_count["n"] == 1

    @pytest.mark.asyncio
    async def test_piggyback_on_originator_exception_does_not_leak_detail(self, monkeypatch):
        """If the originator's fetch raises, piggybackers retry their own
        fetches (matching viewport-singleflight semantics). Any opaque-error
        response dict must not carry the originator's exception detail —
        that's the security guarantee at the SSE wire boundary."""
        from proxy import _fetch_journey_for_subscriber
        import proxy

        async def fake_hafas(_app, _method, _req):
            await asyncio.sleep(0.05)
            raise RuntimeError("internal-secret-detail")

        monkeypatch.setattr(proxy, "_hafas_call_via_app", fake_hafas)
        proxy._journey_cache.clear()
        proxy._inflight_journey.clear()

        # Launch originator + 3 piggybackers concurrently. With retry-on-error
        # alignment, each piggybacker falls through and starts its own fetch
        # after the originator raises — most or all then raise too.
        results = await asyncio.gather(
            *[_fetch_journey_for_subscriber(None, "1|11111|0|80|22052026")
              for _ in range(4)],
            return_exceptions=True,
        )
        # Exceptions naturally carry their message — that's OK; the SSE loop's
        # `gather(return_exceptions=True)` then emits {"reason":"upstream"} to
        # the wire, never the str(exception). Only the opaque-dict path is
        # what reaches clients, and that must NOT leak the secret.
        opaque = [r for r in results if isinstance(r, dict) and r.get("error") == "upstream"]
        for r in opaque:
            assert "internal-secret-detail" not in str(r)

    @pytest.mark.asyncio
    async def test_piggyback_does_not_hang_on_originator_cancellation(self, monkeypatch):
        """If the originator's task is cancelled mid-fetch, piggybackers must
        not hang on a never-resolved future. They should observe the cancel."""
        from proxy import _fetch_journey_for_subscriber
        import proxy

        async def slow_hafas(_app, _method, _req):
            await asyncio.sleep(10)  # never returns within test timeout
            return {"journey": {}}

        monkeypatch.setattr(proxy, "_hafas_call_via_app", slow_hafas)
        proxy._journey_cache.clear()
        proxy._inflight_journey.clear()

        jid = "1|11111|0|80|22052026"
        originator = asyncio.create_task(_fetch_journey_for_subscriber(None, jid))
        await asyncio.sleep(0.02)  # let originator install the inflight entry
        piggy = asyncio.create_task(_fetch_journey_for_subscriber(None, jid))
        await asyncio.sleep(0.02)
        originator.cancel()
        # Piggyback should not hang indefinitely. Either it sees cancellation
        # propagated via shield, or it observes the cancel as an exception and
        # falls back to opaque error. Either way: completes within 2 seconds.
        try:
            result = await asyncio.wait_for(piggy, timeout=2.0)
            # If it returned a dict, it should be the opaque error
            assert isinstance(result, dict) and result.get("error") == "upstream"
        except asyncio.CancelledError:
            # Propagated cancellation is acceptable
            pass
        except asyncio.TimeoutError:
            piggy.cancel()
            pytest.fail("piggybacker hung on cancelled originator's future")


class TestDetailCacheEviction:
    """The 200/500-entry cache caps must hold under flood, otherwise an
    attacker (combined with /select rate-limit bypass) could exhaust memory."""

    @pytest.mark.asyncio
    async def test_journey_cache_caps_at_200(self, monkeypatch):
        from proxy import _fetch_journey_for_subscriber
        import proxy

        async def fake_hafas(_app, _method, _req):
            return {"journey": {"jid": _req["jid"]}}

        monkeypatch.setattr(proxy, "_hafas_call_via_app", fake_hafas)
        proxy._journey_cache.clear()
        proxy._inflight_journey.clear()

        for i in range(250):
            await _fetch_journey_for_subscriber(None, f"1|{i:05d}|0|80|22052026")
        assert len(proxy._journey_cache) <= 200

    @pytest.mark.asyncio
    async def test_stationboard_cache_caps_at_500(self, monkeypatch):
        from proxy import _fetch_stationboard_for_subscriber
        import proxy

        async def fake_hafas(_app, _method, _req):
            return {"jnyL": []}

        monkeypatch.setattr(proxy, "_hafas_call_via_app", fake_hafas)
        proxy._stationboard_cache.clear()
        proxy._inflight_stationboard.clear()

        for i in range(600):
            await _fetch_stationboard_for_subscriber(None, f"A={i}@L={i}@")
        assert len(proxy._stationboard_cache) <= 500

    @pytest.mark.asyncio
    async def test_legacy_journey_and_sse_share_locked_eviction(self, monkeypatch):
        """Regression: legacy `/api/journey` and SSE `_fetch_journey_for_subscriber`
        write to the same `_journey_cache`. Concurrent eviction via `sorted(dict)`
        WITHOUT the lock used to risk `RuntimeError: dictionary changed size
        during iteration`. Both paths must now acquire `_journey_cache_lock`."""
        from proxy import _fetch_journey_for_subscriber
        import proxy

        async def fake_hafas(_app, _method, _req):
            return {"journey": {"jid": _req["jid"]}}

        monkeypatch.setattr(proxy, "_hafas_call_via_app", fake_hafas)
        proxy._journey_cache.clear()
        proxy._inflight_journey.clear()

        # Pre-fill close to cap so both paths' eviction logic runs.
        for i in range(195):
            await _fetch_journey_for_subscriber(None, f"1|{i:05d}|0|80|22052026")

        # Spawn many concurrent writers from both code paths; if eviction
        # races without the lock, a `sorted(dict)` call mid-mutation raises
        # `RuntimeError: dictionary changed size during iteration`.
        async def writer(idx):
            await _fetch_journey_for_subscriber(None, f"1|w{idx:04d}|0|80|22052026")

        # 50 concurrent writers (>200 cap-100 trim threshold ≥ 5 evictions)
        await asyncio.gather(*[writer(i) for i in range(50)])
        # No exception raised, cap holds
        assert len(proxy._journey_cache) <= 200
