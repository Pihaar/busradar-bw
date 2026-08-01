"""Tests for hafas.py — envelope builder, circuit breaker, _hafas_call_via_app."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

import hafas
from hafas import (
    CIRCUIT_BREAKER_COOLDOWN,
    JID_PATTERN,
    LID_PATTERN,
    MAX_CONSECUTIVE_FAILURES,
    _build_hafas_envelope,
    _CircuitBreaker,
    _hafas_call_via_app,
)


class TestBuildEnvelope:
    def test_envelope_shape(self):
        env = _build_hafas_envelope("JourneyGeoPos", {"ring": {}})
        assert env["auth"]["aid"] == hafas.AUTH_AID
        assert env["client"]["id"] == hafas.CLIENT_ID
        assert env["ver"] == hafas.VER
        assert env["svcReqL"] == [{"meth": "JourneyGeoPos", "req": {"ring": {}}}]


class TestPatterns:
    def test_jid_accepts_hash_structured(self):
        assert JID_PATTERN.match("2|#VN#1#ST#1782426904#PI#0#ZB#Bus  721#")

    def test_jid_rejects_unicode_digit(self):
        # Arabic-Indic digit must not match [0-9].
        assert JID_PATTERN.match("٠123") is None

    def test_jid_rejects_trailing_newline(self):
        assert JID_PATTERN.match("A=1@L=6003411@\n") is None

    def test_lid_accepts_qualified(self):
        assert LID_PATTERN.match(
            "A=1@O=Wiesloch-Walldorf Bahnhof@X=8664801@Y=49291306@U=80@L=44278341@"
        )

    def test_lid_rejects_leading_junk(self):
        assert LID_PATTERN.match("XA=1@L=1@") is None


class TestCircuitBreaker:
    def test_starts_closed(self):
        b = _CircuitBreaker()
        assert b.is_open is False

    def test_opens_at_threshold(self, caplog):
        b = _CircuitBreaker()
        with caplog.at_level("WARNING", logger="busradar"):
            for _ in range(MAX_CONSECUTIVE_FAILURES):
                b.record_failure()
        assert b.is_open is True
        assert any("OPEN" in r.message for r in caplog.records)

    def test_below_threshold_stays_closed(self):
        b = _CircuitBreaker()
        for _ in range(MAX_CONSECUTIVE_FAILURES - 1):
            b.record_failure()
        assert b.is_open is False

    def test_reopens_only_within_cooldown(self, monkeypatch):
        b = _CircuitBreaker()
        for _ in range(MAX_CONSECUTIVE_FAILURES):
            b.record_failure()
        # Cooldown elapsed → is_open flips back to False even with failures set.
        b.last_failure_time = 0.0
        monkeypatch.setattr(hafas.time, "time", lambda: CIRCUIT_BREAKER_COOLDOWN + 1)
        assert b.is_open is False

    def test_record_success_below_threshold_no_log(self, caplog):
        b = _CircuitBreaker()
        b.failures = 1
        with caplog.at_level("INFO", logger="busradar"):
            b.record_success()
        assert b.failures == 0
        assert not any("CLOSED" in r.message for r in caplog.records)

    def test_record_success_after_open_logs_closed(self, caplog):
        b = _CircuitBreaker()
        b.failures = MAX_CONSECUTIVE_FAILURES
        with caplog.at_level("INFO", logger="busradar"):
            b.record_success()
        assert b.failures == 0
        assert any("CLOSED" in r.message for r in caplog.records)


def _mock_app(resp=None, exc=None):
    app = MagicMock()
    client = AsyncMock()
    if exc is not None:
        client.post.side_effect = exc
    else:
        client.post.return_value = resp
    app.state.client = client
    return app


def _resp(json_body):
    r = MagicMock()
    r.raise_for_status = MagicMock()
    r.json.return_value = json_body
    return r


class TestHafasCallViaApp:
    def setup_method(self):
        # Reset the module-level breaker before each case.
        hafas.breaker.failures = 0
        hafas.breaker.last_failure_time = 0.0

    def teardown_method(self):
        hafas.breaker.failures = 0
        hafas.breaker.last_failure_time = 0.0

    @pytest.mark.asyncio
    async def test_breaker_open_short_circuits(self, monkeypatch):
        hafas.breaker.failures = MAX_CONSECUTIVE_FAILURES
        monkeypatch.setattr(hafas.time, "time", lambda: 0.0)
        hafas.breaker.last_failure_time = 0.0
        app = _mock_app()
        out = await _hafas_call_via_app(app, "JourneyGeoPos", {})
        assert out["error"] == "upstream_unavailable"
        app.state.client.post.assert_not_called()

    @pytest.mark.asyncio
    async def test_success_returns_res(self):
        body = {"err": "OK", "svcResL": [{"err": "OK", "res": {"jnyL": [1, 2]}}]}
        app = _mock_app(_resp(body))
        out = await _hafas_call_via_app(app, "JourneyGeoPos", {})
        assert out == {"jnyL": [1, 2]}
        assert hafas.breaker.failures == 0

    @pytest.mark.asyncio
    async def test_success_missing_res_returns_empty_dict(self):
        body = {"err": "OK", "svcResL": [{"err": "OK"}]}
        app = _mock_app(_resp(body))
        out = await _hafas_call_via_app(app, "JourneyGeoPos", {})
        assert out == {}

    @pytest.mark.asyncio
    async def test_api_error_does_not_trip_breaker(self, caplog):
        body = {"err": "FAIL"}
        app = _mock_app(_resp(body))
        hafas.breaker.failures = 2
        with caplog.at_level("WARNING", logger="busradar"):
            out = await _hafas_call_via_app(app, "JourneyGeoPos", {})
        assert out["error"] == "upstream_error"
        # record_success() resets the failure streak.
        assert hafas.breaker.failures == 0
        assert any("api_error" in r.message for r in caplog.records)

    @pytest.mark.asyncio
    async def test_svc_error_does_not_trip_breaker(self, caplog):
        body = {"err": "OK", "svcResL": [{"err": "FAIL"}]}
        app = _mock_app(_resp(body))
        hafas.breaker.failures = 1
        with caplog.at_level("WARNING", logger="busradar"):
            out = await _hafas_call_via_app(app, "JourneyGeoPos", {})
        assert out["error"] == "upstream_error"
        assert hafas.breaker.failures == 0
        assert any("svc_error" in r.message for r in caplog.records)

    @pytest.mark.asyncio
    async def test_timeout_trips_breaker(self, caplog):
        app = _mock_app(exc=httpx.TimeoutException("slow"))
        with caplog.at_level("WARNING", logger="busradar"):
            out = await _hafas_call_via_app(app, "JourneyGeoPos", {})
        assert out["error"] == "upstream_timeout"
        assert hafas.breaker.failures == 1
        assert any("timeout" in r.message for r in caplog.records)

    @pytest.mark.asyncio
    async def test_http_error_trips_breaker(self, caplog):
        app = _mock_app(exc=httpx.HTTPError("boom"))
        with caplog.at_level("ERROR", logger="busradar"):
            out = await _hafas_call_via_app(app, "JourneyGeoPos", {})
        assert out["error"] == "upstream_error"
        assert hafas.breaker.failures == 1
        assert any("http_error" in r.message for r in caplog.records)

    @pytest.mark.asyncio
    async def test_raise_for_status_httpstatuserror_trips_breaker(self):
        # raise_for_status raising an HTTPStatusError (subclass of HTTPError)
        # is caught by the httpx.HTTPError branch.
        r = MagicMock()
        r.raise_for_status.side_effect = httpx.HTTPStatusError(
            "500", request=MagicMock(), response=MagicMock()
        )
        app = _mock_app(r)
        out = await _hafas_call_via_app(app, "JourneyGeoPos", {})
        assert out["error"] == "upstream_error"
        assert hafas.breaker.failures == 1

    @pytest.mark.asyncio
    async def test_pool_timeout_does_not_trip_breaker(self, caplog):
        # PoolTimeout is a LOCAL capacity signal (all pooled connections busy),
        # a subclass of TimeoutException. Its handler must precede the generic
        # timeout branch and return pool_exhausted WITHOUT touching the breaker,
        # so transient local contention can't cause a global outage.
        app = _mock_app(exc=httpx.PoolTimeout("pool"))
        with caplog.at_level("WARNING", logger="busradar"):
            out = await _hafas_call_via_app(app, "JourneyGeoPos", {})
        assert out["error"] == "pool_exhausted"
        assert hafas.breaker.failures == 0
        assert any("pool_exhausted" in r.message for r in caplog.records)

    @pytest.mark.asyncio
    async def test_unexpected_exception_does_not_trip_breaker(self, caplog):
        # A non-httpx exception (e.g. JSON decode / internal bug) → internal_error,
        # breaker untouched.
        r = MagicMock()
        r.raise_for_status = MagicMock()
        r.json.side_effect = ValueError("bad json")
        app = _mock_app(r)
        with caplog.at_level("ERROR", logger="busradar"):
            out = await _hafas_call_via_app(app, "JourneyGeoPos", {})
        assert out["error"] == "internal_error"
        assert hafas.breaker.failures == 0
        assert any("unexpected_error" in r.message for r in caplog.records)
