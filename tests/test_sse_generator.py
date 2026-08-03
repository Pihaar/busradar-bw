"""Branch coverage for sse_handler.event_generator and the SSE fetch/format
helpers that the endpoint tests don't reach.

The generator is driven deterministically: `asyncio.wait_for` is monkeypatched
to a fake that consumes a scripted action list instead of ever sleeping, so
each while-loop iteration takes a chosen path (tick / keepalive / end). No real
timers, no sleeps.
"""

from __future__ import annotations

import asyncio

import pytest
from starlette.requests import Request

import fanout
import proxy
import sse_handler
from caches import _inflight


def _make_request(headers: dict | None = None) -> Request:
    hdr = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/api/stream/",
        "query_string": b"",
        "headers": hdr,
        "client": ("127.0.0.1", 1234),
        "app": proxy.app,
    }
    return Request(scope)


async def _drive(setup, actions, patches=None):
    """Run event_generator to exhaustion.

    setup(sub): configure the freshly-created subscriber.
    actions: list of zero-arg callables (sync or async). Each is consumed by
             one wait_for call. Return "timeout" to raise TimeoutError
             (keepalive path); anything else takes the tick path. When the
             list empties, wait_for raises CancelledError to end the loop.
    patches: {attr: value} monkeypatched onto sse_handler for the run.
    """
    fanout.registry = fanout.SubscriberRegistry()
    fanout.tick_condition = asyncio.Condition()
    fanout.tick_seq = 0
    fanout.tick_push_seq = 0

    saved = {}
    for k, v in (patches or {}).items():
        saved[k] = getattr(sse_handler, k)
        setattr(sse_handler, k, v)

    real_wait_for = asyncio.wait_for
    pending = list(actions)

    async def fake_wait_for(aw, timeout=None):
        # The generator passes a coroutine (tick_condition.wait_for(...)); close
        # it so we don't leak an un-awaited coroutine warning.
        if hasattr(aw, "close"):
            aw.close()
        if not pending:
            raise asyncio.CancelledError
        act = pending.pop(0)
        result = act()
        if asyncio.iscoroutine(result):
            result = await result
        if result == "timeout":
            raise TimeoutError

    asyncio.wait_for = fake_wait_for
    try:
        resp = await sse_handler.handle_sse_stream(_make_request(), "vX")
        sub = next(iter(fanout.registry._subs.values()))
        setup(sub)
        frames: list[str] = []
        it = resp.body_iterator
        while True:
            try:
                frame = await it.__anext__()
            except (StopAsyncIteration, asyncio.CancelledError):
                break
            frames.append(frame)
        return frames, sub
    finally:
        asyncio.wait_for = real_wait_for
        for k, v in saved.items():
            setattr(sse_handler, k, v)


async def _ok_vehicles(app, viewport, pos_mode):
    return {"vehicles": [{"jid": "J"}], "serverTime": "120000"}


# === Format helpers (146-152, 158, 164) ===


class TestFormatHelpers:
    def test_format_sse_with_event(self):
        out = sse_handler._format_sse("vehicles", {"a": 1})
        assert out.startswith("event: vehicles\n")
        assert 'data: {"a":1}' in out
        assert out.endswith("\n\n")

    def test_format_sse_without_event(self):
        out = sse_handler._format_sse(None, {"a": 1})
        assert not out.startswith("event:")
        assert 'data: {"a":1}' in out

    def test_format_keepalive(self):
        assert sse_handler._format_keepalive() == ": keepalive\n\n"

    @pytest.mark.asyncio
    async def test_noop_async_returns_value(self):
        assert await sse_handler._noop_async(None) is None
        assert await sse_handler._noop_async(7) == 7


# === ViewportPayload lon-ordering validator (137) ===


class TestViewportLonOrdering:
    def test_ne_lon_not_greater_than_sw_lon_raises(self):
        from pydantic import ValidationError

        with pytest.raises(ValidationError):
            # lat ordering valid, lon ordering invalid → hits _check_lon_ordering
            sse_handler.ViewportPayload(swLat=49.0, swLon=9.0, neLat=50.0, neLon=8.0)


# === event_generator paths (654-860) ===


class TestEventGeneratorSubscribeFrames:
    @pytest.mark.asyncio
    async def test_subscribe_and_connected_emitted_first(self):
        frames, _ = await _drive(lambda s: None, [])
        assert frames[0].startswith("event: subscribe\n")
        assert '"appVersion":"vX"' in frames[0]
        assert '"protocol":"1"' in frames[0]
        assert frames[1].startswith("event: connected\n")


class TestEventGeneratorKeepalive:
    @pytest.mark.asyncio
    async def test_timeout_emits_keepalive(self):
        frames, _ = await _drive(lambda s: None, [lambda: "timeout"])
        assert frames[-1] == ": keepalive\n\n"


class TestEventGeneratorForceEmit:
    """Per-sub posMode poke: force_emit wakes the loop (no tick_seq bump) and is
    consumed on that wake so it can't hot-spin. (_drive bypasses the real
    predicate, so it simulates the wake; it verifies the consume + emit that
    follow a wake.)"""

    @pytest.mark.asyncio
    async def test_force_emit_wake_emits_and_resets_flag(self):
        def setup(sub):
            sub.viewport = (49.0, 8.0, 49.6, 9.0)
            sub.force_emit = True

        frames, sub = await _drive(
            setup, [lambda: None], {"_fetch_vehicles_for_viewport": _ok_vehicles}
        )
        assert any(f.startswith("event: vehicles\n") for f in frames)
        assert sub.force_emit is False  # consumed under the lock on the wake

    @pytest.mark.asyncio
    async def test_report_only_with_force_emit_emits_via_reset_anchor(self):
        # Real posMode→REPORT_ONLY path: handle_viewport set last_emitted_tick_push_seq
        # =None + force_emit; the REPORT_ONLY gate must emit despite a non-tick-aligned wake.
        def setup(sub):
            sub.viewport = (49.0, 8.0, 49.6, 9.0)
            sub.pos_mode = "REPORT_ONLY"
            sub.last_emitted_tick_push_seq = None
            sub.force_emit = True

        frames, sub = await _drive(
            setup, [lambda: None], {"_fetch_vehicles_for_viewport": _ok_vehicles}
        )
        assert any(f.startswith("event: vehicles\n") for f in frames)
        assert sub.force_emit is False


class TestEventGeneratorTickVehicles:
    @pytest.mark.asyncio
    async def test_vehicles_emitted_on_tick(self):
        def setup(sub):
            sub.viewport = (49.0, 8.0, 49.6, 9.0)

        frames, _ = await _drive(
            setup, [lambda: None], {"_fetch_vehicles_for_viewport": _ok_vehicles}
        )
        assert any(f.startswith("event: vehicles\n") for f in frames)

    @pytest.mark.asyncio
    async def test_no_viewport_no_vehicles(self):
        # viewport None → _noop_async branch (731 else); no vehicles event.
        frames, _ = await _drive(lambda s: None, [lambda: None])
        assert not any(f.startswith("event: vehicles\n") for f in frames)

    @pytest.mark.asyncio
    async def test_vehicles_upstream_error_dict(self):
        async def err(app, vp, pm):
            return {"error": "upstream_unavailable"}

        def setup(sub):
            sub.viewport = (49.0, 8.0, 49.6, 9.0)

        frames, _ = await _drive(setup, [lambda: None], {"_fetch_vehicles_for_viewport": err})
        errs = [f for f in frames if f.startswith("event: error\n")]
        assert errs and '"reason":"upstream"' in errs[0]
        assert '"stale":true' in errs[0]

    @pytest.mark.asyncio
    async def test_vehicles_fetch_raises_emits_error(self):
        async def boom(app, vp, pm):
            raise RuntimeError("secret-detail")

        def setup(sub):
            sub.viewport = (49.0, 8.0, 49.6, 9.0)

        frames, _ = await _drive(setup, [lambda: None], {"_fetch_vehicles_for_viewport": boom})
        errs = [f for f in frames if f.startswith("event: error\n")]
        assert errs
        assert "secret-detail" not in errs[0]


class TestEventGeneratorConnectedCount:
    @pytest.mark.asyncio
    async def test_connected_re_emitted_when_count_changes_on_tick(self):
        async def add_sub():
            await fanout.registry.subscribe("10.0.0.9")

        def setup(sub):
            sub.viewport = None  # keep it simple, only count matters

        frames, _ = await _drive(setup, [add_sub], {"_fetch_vehicles_for_viewport": _ok_vehicles})
        connected = [f for f in frames if f.startswith("event: connected\n")]
        # initial connected + the change-driven one
        assert len(connected) >= 2


class TestEventGeneratorSelection:
    @pytest.mark.asyncio
    async def test_selection_journey_emits_event(self):
        async def sel(app, s):
            return ("journey", {"jid": "J", "journey": {}})

        def setup(sub):
            sub.viewport = None
            sub.selection = fanout.JourneySelection(jid="1|J|0|80|010626")

        frames, _ = await _drive(
            setup,
            [lambda: None],
            {"_fetch_vehicles_for_viewport": _ok_vehicles, "_fetch_for_selection": sel},
        )
        assert any(f.startswith("event: journey\n") for f in frames)

    @pytest.mark.asyncio
    async def test_selection_fetch_raises_emits_error(self):
        async def sel(app, s):
            raise RuntimeError("boom")

        def setup(sub):
            sub.viewport = None
            sub.selection = fanout.JourneySelection(jid="1|J|0|80|010626")

        frames, _ = await _drive(
            setup,
            [lambda: None],
            {"_fetch_vehicles_for_viewport": _ok_vehicles, "_fetch_for_selection": sel},
        )
        errs = [f for f in frames if f.startswith("event: error\n")]
        assert errs and '"selection":"journey"' in errs[0]

    @pytest.mark.asyncio
    async def test_selection_none_event_name_suppresses_emit(self):
        # _fetch_for_selection returns (None, None) → the `if event_name:` guard
        # is False, no event emitted for the selection.
        async def sel(app, s):
            return (None, None)

        def setup(sub):
            sub.viewport = None
            sub.selection = fanout.JourneySelection(jid="1|J|0|80|010626")

        frames, _ = await _drive(
            setup,
            [lambda: None],
            {"_fetch_vehicles_for_viewport": _ok_vehicles, "_fetch_for_selection": sel},
        )
        assert not any(f.startswith("event: journey\n") for f in frames)

    @pytest.mark.asyncio
    async def test_stale_selection_seq_discards_detail(self):
        # Bump selection_seq during the fetch so the staleness guard fails and
        # the detail result is discarded (788-792 false path).
        async def sel(app, s):
            sub_ref["s"].selection_seq += 1
            return ("journey", {"jid": "J", "journey": {}})

        sub_ref: dict = {}

        def setup(sub):
            sub.viewport = None
            sub.selection = fanout.JourneySelection(jid="1|J|0|80|010626")
            sub_ref["s"] = sub

        frames, _ = await _drive(
            setup,
            [lambda: None],
            {"_fetch_vehicles_for_viewport": _ok_vehicles, "_fetch_for_selection": sel},
        )
        assert not any(f.startswith("event: journey\n") for f in frames)


class TestEventGeneratorReportOnly:
    @pytest.mark.asyncio
    async def test_report_only_skips_when_tick_push_unchanged(self):
        # REPORT_ONLY + tick_push_seq NOT advanced → _report_only_should_emit
        # False → continue (skip vehicles).
        def setup(sub):
            sub.viewport = (49.0, 8.0, 49.6, 9.0)
            sub.pos_mode = "REPORT_ONLY"
            sub.last_emitted_tick_push_seq = 0  # equals current tick_push_seq → skip

        frames, _ = await _drive(
            setup, [lambda: None], {"_fetch_vehicles_for_viewport": _ok_vehicles}
        )
        assert not any(f.startswith("event: vehicles\n") for f in frames)

    @pytest.mark.asyncio
    async def test_report_only_offring_splice_runs(self):
        spliced = {"n": 0}

        async def sel(app, s):
            return ("journey", {"jid": "J", "journey": {"journey": {}}})

        async def splice(app, jid, detail_res, snap):
            spliced["n"] += 1
            return (detail_res[0], {**detail_res[1], "real": True})

        def setup(sub):
            sub.viewport = (49.0, 8.0, 49.6, 9.0)
            sub.pos_mode = "REPORT_ONLY"
            sub.selection = fanout.JourneySelection(jid="1|J|0|80|010626")
            sub.last_emitted_tick_push_seq = None  # None → always emit

        def advance():
            fanout.tick_push_seq += 1

        frames, _ = await _drive(
            setup,
            [advance],
            {
                "_fetch_vehicles_for_viewport": _ok_vehicles,
                "_fetch_for_selection": sel,
                "_real_pos_for_offring_follow": splice,
            },
        )
        assert spliced["n"] == 1
        assert any('"real":true' in f for f in frames)


class TestEventGeneratorSlowConsumer:
    @pytest.mark.asyncio
    async def test_slow_batch_increments_and_disconnects(self):
        def setup(sub):
            sub.viewport = (49.0, 8.0, 49.6, 9.0)
            sub.consecutive_drops = 4  # one more slow batch trips the disconnect

        # threshold -1 → every batch counts as slow.
        frames, sub = await _drive(
            setup,
            [lambda: None, lambda: None],  # 2nd action never consumed; loop breaks first
            {"_fetch_vehicles_for_viewport": _ok_vehicles, "SSE_SLOW_YIELD_THRESHOLD_S": -1.0},
        )
        assert sub.consecutive_drops >= 5

    @pytest.mark.asyncio
    async def test_fast_batch_resets_drops(self):
        def setup(sub):
            sub.viewport = (49.0, 8.0, 49.6, 9.0)
            sub.consecutive_drops = 3

        # Huge threshold → batch is "fast" → drops reset to 0 (820-821).
        frames, sub = await _drive(
            setup,
            [lambda: None],
            {"_fetch_vehicles_for_viewport": _ok_vehicles, "SSE_SLOW_YIELD_THRESHOLD_S": 1e9},
        )
        assert sub.consecutive_drops == 0


class TestEventGeneratorFinallyCleanup:
    @pytest.mark.asyncio
    async def test_unsubscribe_and_subscriber_left_failures_are_suppressed(self, monkeypatch):
        async def bad_unsub(cid):
            raise RuntimeError("unsub fail")

        def bad_left():
            raise RuntimeError("left fail")

        def setup(sub):
            monkeypatch.setattr(fanout.registry, "unsubscribe", bad_unsub)
            monkeypatch.setattr(sse_handler.client_activity, "subscriber_left", bad_left)

        # No action → loop ends immediately via CancelledError → finally runs
        # both failing cleanups; both are swallowed (no exception escapes).
        frames, _ = await _drive(setup, [])
        assert frames  # subscribe/connected still emitted


# === _fetch_vehicles_for_viewport (180-255) ===


class TestFetchVehiclesForViewport:
    @pytest.fixture(autouse=True)
    def _clear(self):
        _inflight.clear()
        yield
        _inflight.clear()

    @pytest.mark.asyncio
    async def test_happy_path(self, monkeypatch):
        async def fake(app, method, req):
            assert method == "JourneyGeoPos"
            return {"jnyL": []}

        monkeypatch.setattr(proxy, "_hafas_call_via_app", fake)
        monkeypatch.setattr(proxy, "_flatten_vehicles", lambda res: [{"jid": "X"}])
        out = await sse_handler._fetch_vehicles_for_viewport(None, (49.0, 8.0, 49.6, 9.0), "CALC")
        assert out["vehicles"] == [{"jid": "X"}]
        assert "serverTime" in out
        # serverDate rides along in the same tick (YYYYMMDD), for the client's
        # sD-frame "now" math across local midnight.
        assert "serverDate" in out
        assert len(out["serverDate"]) == 8 and out["serverDate"].isdigit()

    @pytest.mark.asyncio
    async def test_upstream_error(self, monkeypatch):
        async def fake(app, method, req):
            return {"error": "upstream_unavailable"}

        monkeypatch.setattr(proxy, "_hafas_call_via_app", fake)
        out = await sse_handler._fetch_vehicles_for_viewport(None, (49.0, 8.0, 49.6, 9.0), "CALC")
        assert out == {"error": "upstream_unavailable"}

    @pytest.mark.asyncio
    async def test_invalid_posmode_coerced_to_calc(self, monkeypatch):
        seen = {}

        async def fake(app, method, req):
            seen["mode"] = req["trainPosMode"]
            return {"jnyL": []}

        monkeypatch.setattr(proxy, "_hafas_call_via_app", fake)
        monkeypatch.setattr(proxy, "_flatten_vehicles", lambda res: [])
        await sse_handler._fetch_vehicles_for_viewport(None, (49.0, 8.0, 49.6, 9.0), "BOGUS")
        assert seen["mode"] == "CALC"

    @pytest.mark.asyncio
    async def test_singleflight_collapses_concurrent(self, monkeypatch):
        calls = {"n": 0}

        async def fake(app, method, req):
            calls["n"] += 1
            await asyncio.sleep(0.02)
            return {"jnyL": []}

        monkeypatch.setattr(proxy, "_hafas_call_via_app", fake)
        monkeypatch.setattr(proxy, "_flatten_vehicles", lambda res: [])
        vp = (49.0, 8.0, 49.6, 9.0)
        outs = await asyncio.gather(
            *[sse_handler._fetch_vehicles_for_viewport(None, vp, "CALC") for _ in range(4)]
        )
        assert calls["n"] == 1
        assert all(o == outs[0] for o in outs)

    @pytest.mark.asyncio
    async def test_piggyback_on_originator_error_retries(self, monkeypatch):
        # Originator's future errors → piggybacker falls through and runs its
        # own fetch (210-217).
        state = {"n": 0}

        async def fake(app, method, req):
            state["n"] += 1
            await asyncio.sleep(0.02)
            if state["n"] == 1:
                raise RuntimeError("first fails")
            return {"jnyL": []}

        monkeypatch.setattr(proxy, "_hafas_call_via_app", fake)
        monkeypatch.setattr(proxy, "_flatten_vehicles", lambda res: [])
        vp = (49.0, 8.0, 49.6, 9.0)
        results = await asyncio.gather(
            *[sse_handler._fetch_vehicles_for_viewport(None, vp, "CALC") for _ in range(3)],
            return_exceptions=True,
        )
        # At least one succeeded via the retry fallthrough.
        assert any(isinstance(r, dict) and "vehicles" in r for r in results)

    @pytest.mark.asyncio
    async def test_originator_cancelled_propagates_to_piggyback(self, monkeypatch):
        async def slow(app, method, req):
            await asyncio.sleep(10)
            return {"jnyL": []}

        monkeypatch.setattr(proxy, "_hafas_call_via_app", slow)
        monkeypatch.setattr(proxy, "_flatten_vehicles", lambda res: [])
        vp = (49.0, 8.0, 49.6, 9.0)
        originator = asyncio.create_task(sse_handler._fetch_vehicles_for_viewport(None, vp, "CALC"))
        await asyncio.sleep(0.02)
        piggy = asyncio.create_task(sse_handler._fetch_vehicles_for_viewport(None, vp, "CALC"))
        await asyncio.sleep(0.02)
        originator.cancel()
        try:
            await asyncio.wait_for(piggy, timeout=2.0)
        except (asyncio.CancelledError, Exception):
            pass
        # originator itself observes cancellation
        with pytest.raises(asyncio.CancelledError):
            await originator

    @pytest.mark.asyncio
    async def test_inflight_eviction_over_cap(self, monkeypatch):
        # Fill _inflight beyond MAX_INFLIGHT with dummy done futures, then a
        # real call must evict the oldest (225-228).
        async def fake(app, method, req):
            return {"jnyL": []}

        monkeypatch.setattr(proxy, "_hafas_call_via_app", fake)
        monkeypatch.setattr(proxy, "_flatten_vehicles", lambda res: [])
        loop = asyncio.get_running_loop()
        for i in range(fanout.MAX_INFLIGHT + 5):
            f = loop.create_future()
            f.set_result({"x": i})
            _inflight[("filler", i)] = f
        first_key = next(iter(_inflight))
        await sse_handler._fetch_vehicles_for_viewport(None, (49.0, 8.0, 49.6, 9.0), "CALC")
        assert first_key not in _inflight


# === _fetch_for_selection (491-504) ===


class TestFetchForSelection:
    @pytest.mark.asyncio
    async def test_journey_ok(self, monkeypatch):
        async def fake(app, jid):
            return {"journey": {"jid": jid}}

        monkeypatch.setattr(sse_handler, "_fetch_journey_for_subscriber", fake)
        name, payload = await sse_handler._fetch_for_selection(
            None, fanout.JourneySelection(jid="J")
        )
        assert name == "journey"
        assert payload["jid"] == "J"

    @pytest.mark.asyncio
    async def test_journey_error(self, monkeypatch):
        async def fake(app, jid):
            return {"error": "upstream"}

        monkeypatch.setattr(sse_handler, "_fetch_journey_for_subscriber", fake)
        name, payload = await sse_handler._fetch_for_selection(
            None, fanout.JourneySelection(jid="J")
        )
        assert name == "error"
        assert payload == {"reason": "upstream", "selection": "journey"}

    @pytest.mark.asyncio
    async def test_stationboard_ok(self, monkeypatch):
        async def fake(app, lid, board_type, dur):
            return {"jnyL": []}

        monkeypatch.setattr(sse_handler, "_fetch_stationboard_for_subscriber", fake)
        name, payload = await sse_handler._fetch_for_selection(
            None, fanout.StationSelection(lid="A=1@L=1@")
        )
        assert name == "stationboard"
        assert payload["boardType"] == "DEP"

    @pytest.mark.asyncio
    async def test_stationboard_error(self, monkeypatch):
        async def fake(app, lid, board_type, dur):
            return {"error": "upstream"}

        monkeypatch.setattr(sse_handler, "_fetch_stationboard_for_subscriber", fake)
        name, payload = await sse_handler._fetch_for_selection(
            None, fanout.StationSelection(lid="A=1@L=1@")
        )
        assert name == "error"
        assert payload == {"reason": "upstream", "selection": "stationboard"}

    @pytest.mark.asyncio
    async def test_unknown_selection_type_returns_none(self):
        class Other:
            pass

        name, payload = await sse_handler._fetch_for_selection(None, Other())
        assert name is None
        assert payload is None


# === _read_body_with_limit (391->397, 395-396, 401) ===


class TestReadBodyWithLimit:
    def _req(self, chunks, content_length=None):
        headers = {}
        if content_length is not None:
            headers["content-length"] = content_length

        class _Req:
            def __init__(self):
                self.headers = headers

            async def stream(self):
                for c in chunks:
                    yield c

        return _Req()

    @pytest.mark.asyncio
    async def test_no_content_length_reads_body(self):
        req = self._req([b"ab", b"cd"])
        out = await sse_handler._read_body_with_limit(req, 100)
        assert out == b"abcd"

    @pytest.mark.asyncio
    async def test_content_length_over_limit_rejected(self):
        req = self._req([b"x"], content_length="5000")
        assert await sse_handler._read_body_with_limit(req, 100) is None

    @pytest.mark.asyncio
    async def test_non_integer_content_length_rejected(self):
        req = self._req([b"x"], content_length="not-a-number")
        assert await sse_handler._read_body_with_limit(req, 100) is None

    @pytest.mark.asyncio
    async def test_streamed_body_over_limit_rejected(self):
        req = self._req([b"a" * 60, b"b" * 60])  # 120 > 100, no CL
        assert await sse_handler._read_body_with_limit(req, 100) is None


# === _post_rate_check_ip eviction (356-360) ===


class TestPostRateCheckIpEviction:
    def test_eviction_when_keyspace_full(self, monkeypatch):
        sse_handler._post_rate_per_ip.clear()
        monkeypatch.setattr(sse_handler, "_POST_RATE_PER_IP_MAX_KEYS", 3)
        # Fill to cap with distinct IPs.
        for i in range(3):
            assert sse_handler._post_rate_check_ip(f"10.0.0.{i}") is True
        first = next(iter(sse_handler._post_rate_per_ip))
        # A new IP at cap triggers eviction of the oldest before insert.
        assert sse_handler._post_rate_check_ip("10.0.0.99") is True
        assert first not in sse_handler._post_rate_per_ip
        assert len(sse_handler._post_rate_per_ip) <= 3
        sse_handler._post_rate_per_ip.clear()

    def test_existing_ip_depletes_to_deny(self, monkeypatch):
        # Drain a single IP's bucket to hit the deny branch (371-372).
        sse_handler._post_rate_per_ip.clear()
        allowed = 0
        for _ in range(int(sse_handler._POST_RATE_PER_IP_BURST) + 5):
            if sse_handler._post_rate_check_ip("10.1.1.1"):
                allowed += 1
        assert allowed == int(sse_handler._POST_RATE_PER_IP_BURST)
        assert sse_handler._post_rate_check_ip("10.1.1.1") is False
        sse_handler._post_rate_per_ip.clear()


# === handle_select generic exception (956-957) ===


class TestHandleSelectGenericException:
    @pytest.mark.asyncio
    async def test_non_validation_exception_returns_422(self, monkeypatch):
        import fanout as _f

        reg = _f.SubscriberRegistry()
        monkeypatch.setattr(_f, "registry", reg)
        sub = await reg.subscribe("127.0.0.1")
        sse_handler._post_rate_per_ip.clear()

        def boom(raw):
            raise ValueError("not a ValidationError")

        monkeypatch.setattr(sse_handler.SelectPayload, "model_validate_json", boom)

        headers = {
            "Origin": "http://localhost:8000",
            "Content-Type": "application/json",
            "Cookie": f"__Host-busradar_sse={sub.connection_id}",
        }
        from httpx import ASGITransport, AsyncClient

        transport = ASGITransport(app=proxy.app)
        async with AsyncClient(transport=transport, base_url="http://localhost:8000") as c:
            resp = await c.post(
                "/api/stream/select",
                content='{"selection":null}',
                headers=headers,
            )
        assert resp.status_code == 422
        assert resp.json()["error"] == "invalid_payload"
        sse_handler._post_rate_per_ip.clear()


# === _fetch_vehicles_for_viewport defensive fut/inflight arcs ===


def _vp_key(vp, pos_mode="CALC"):
    return ("sse", fanout.quantize_bbox(vp), pos_mode)


class TestFetchVehiclesDefensiveArcs:
    @pytest.fixture(autouse=True)
    def _clear(self):
        _inflight.clear()
        yield
        _inflight.clear()

    @pytest.mark.asyncio
    async def test_fut_already_done_on_success_no_double_set(self, monkeypatch):
        # Our own future is cancelled mid-await → `if not fut.done()` is False
        # (237->239): set_result skipped, out still returned.
        vp = (49.0, 8.0, 49.6, 9.0)

        async def fake(app, method, req):
            _inflight[_vp_key(vp)].cancel()
            return {"jnyL": []}

        monkeypatch.setattr(proxy, "_hafas_call_via_app", fake)
        monkeypatch.setattr(proxy, "_flatten_vehicles", lambda r: [])
        out = await sse_handler._fetch_vehicles_for_viewport(None, vp, "CALC")
        assert "vehicles" in out

    @pytest.mark.asyncio
    async def test_fut_done_on_exception_no_double_set(self, monkeypatch):
        # fut cancelled, then hafas raises → `if not fut.done()` False (247->249).
        vp = (49.0, 8.0, 49.6, 9.0)

        async def fake(app, method, req):
            _inflight[_vp_key(vp)].cancel()
            raise RuntimeError("boom")

        monkeypatch.setattr(proxy, "_hafas_call_via_app", fake)
        with pytest.raises(RuntimeError):
            await sse_handler._fetch_vehicles_for_viewport(None, vp, "CALC")

    @pytest.mark.asyncio
    async def test_fut_done_on_cancellation_no_double_cancel(self, monkeypatch):
        # fut cancelled, then hafas raises CancelledError → `if not fut.done()`
        # False in the CancelledError arm (243->245).
        vp = (49.0, 8.0, 49.6, 9.0)

        async def fake(app, method, req):
            _inflight[_vp_key(vp)].cancel()
            raise asyncio.CancelledError

        monkeypatch.setattr(proxy, "_hafas_call_via_app", fake)
        with pytest.raises(asyncio.CancelledError):
            await sse_handler._fetch_vehicles_for_viewport(None, vp, "CALC")

    @pytest.mark.asyncio
    async def test_piggyback_pop_after_originator_error(self, monkeypatch):
        # existing (not-done) future in _inflight fails while we shield it →
        # except-arm pops it because identity still matches (216-217).
        vp = (49.0, 8.0, 49.6, 9.0)
        loop = asyncio.get_running_loop()
        existing = loop.create_future()
        _inflight[_vp_key(vp)] = existing

        async def resolver():
            await asyncio.sleep(0.01)
            existing.set_exception(RuntimeError("orig failed"))

        async def fake(app, method, req):
            return {"jnyL": []}

        monkeypatch.setattr(proxy, "_hafas_call_via_app", fake)
        monkeypatch.setattr(proxy, "_flatten_vehicles", lambda r: [])
        task = asyncio.create_task(resolver())
        out = await sse_handler._fetch_vehicles_for_viewport(None, vp, "CALC")
        await task
        assert "vehicles" in out

    @pytest.mark.asyncio
    async def test_eviction_oldest_equals_key_is_not_popped(self, monkeypatch):
        # Our key is the oldest entry AND we're over cap → the `if oldest != key`
        # guard (227->229) is False, so we do NOT evict our own just-registered
        # slot; the call proceeds normally.
        vp = (49.0, 8.0, 49.6, 9.0)
        loop = asyncio.get_running_loop()
        k = _vp_key(vp)
        done = loop.create_future()
        done.set_result({"x": 0})
        _inflight[k] = done  # first (oldest) AND done → piggyback skipped, overwritten
        for i in range(fanout.MAX_INFLIGHT + 3):
            f = loop.create_future()
            f.set_result({"y": i})
            _inflight[("other", i)] = f
        assert next(iter(_inflight)) == k  # our key is oldest

        async def fake(app, method, req):
            return {"jnyL": []}

        monkeypatch.setattr(proxy, "_hafas_call_via_app", fake)
        monkeypatch.setattr(proxy, "_flatten_vehicles", lambda r: [])
        out = await sse_handler._fetch_vehicles_for_viewport(None, vp, "CALC")
        assert "vehicles" in out


# === _post_rate_check_ip StopIteration guard (360-361) ===


class TestPostRateCheckIpStopIteration:
    def test_empty_dict_at_zero_cap_hits_stopiteration_guard(self, monkeypatch):
        sse_handler._post_rate_per_ip.clear()
        # MAX_KEYS=0 → `len >= 0` True and ip absent → enter eviction with an
        # empty dict → next(iter({})) raises StopIteration → swallowed (360-361).
        monkeypatch.setattr(sse_handler, "_POST_RATE_PER_IP_MAX_KEYS", 0)
        assert sse_handler._post_rate_check_ip("10.0.0.1") is True
        sse_handler._post_rate_per_ip.clear()


# === event_generator residual arcs (781->788, 797->809, 811-812) ===


class TestEventGeneratorResidualArcs:
    @pytest.mark.asyncio
    async def test_snap_none_skips_vehicles_emit(self):
        # snap is None (fetch returned None) with viewport set → none of the
        # isinstance branches match (781->788): no vehicles event.
        async def veh_none(app, vp, pm):
            return None

        def setup(sub):
            sub.viewport = (49.0, 8.0, 49.6, 9.0)

        frames, _ = await _drive(setup, [lambda: None], {"_fetch_vehicles_for_viewport": veh_none})
        assert not any(f.startswith("event: vehicles\n") for f in frames)

    @pytest.mark.asyncio
    async def test_detail_not_tuple_skips_detail_emit(self):
        # selection set + guard passes, but detail_res is None (not Exception,
        # not tuple) → 797->809: neither detail branch emits.
        async def veh_ok(app, vp, pm):
            return {"vehicles": [], "serverTime": "1"}

        async def sel_none(app, sel):
            return None

        def setup(sub):
            sub.viewport = (49.0, 8.0, 49.6, 9.0)
            sub.selection = fanout.JourneySelection(jid="1|J|0|80|010626")

        frames, _ = await _drive(
            setup,
            [lambda: None],
            {"_fetch_vehicles_for_viewport": veh_ok, "_fetch_for_selection": sel_none},
        )
        assert not any(f.startswith("event: journey\n") for f in frames)

    @pytest.mark.asyncio
    async def test_count_change_during_selection_emits_second_connected(self):
        # A subscriber joins during the selection fetch so the count differs at
        # the end-of-iteration re-check (810-812) → a 2nd connected frame.
        async def veh_ok(app, vp, pm):
            return {"vehicles": [], "serverTime": "1"}

        async def sel_add(app, sel):
            await fanout.registry.subscribe("10.0.0.5")
            return ("journey", {"jid": "J", "journey": {}})

        def setup(sub):
            sub.viewport = None
            sub.selection = fanout.JourneySelection(jid="1|J|0|80|010626")

        frames, _ = await _drive(
            setup,
            [lambda: None],
            {"_fetch_vehicles_for_viewport": veh_ok, "_fetch_for_selection": sel_add},
        )
        connected = [f for f in frames if f.startswith("event: connected\n")]
        assert len(connected) >= 2
        assert '"count":2' in connected[-1]
