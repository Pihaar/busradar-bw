"""Tests for GPS tick tracking: TickTracker, ClientActivity, calibrator, response hints."""

import asyncio
import json
import time
from unittest.mock import AsyncMock, patch, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from tick import (
    TickTracker,
    ClientActivity,
    inject_tick_hints,
    _run_calibration,
    _mono,
    TICK_PERIOD,
    TICK_BUFFER,
    TICK_MAX_AGE,
    TICK_MIN_CHANGED_BUSES,
    TICK_NARROW_MIN_CHANGED,
    TICK_POSITIONS_CAP,
    ACTIVE_CLIENT_WINDOW,
    CALIB_MAX_FAILURES,
    _TICK_ENABLED,
)
from proxy import (
    tick_tracker,
    client_activity,
    breaker,
    app,
    _inject_tick_hints,
    HAFAS_ENDPOINT,
    _build_hafas_envelope,
)


class TestTickTrackerFeed:
    def setup_method(self):
        self.tracker = TickTracker()

    def test_first_call_seeds_snapshot_returns_false(self):
        positions = {"j1": (8660000, 49340000), "j2": (8670000, 49350000)}
        assert self.tracker.feed(positions, _mono()) is False
        assert self.tracker._last_positions == positions

    def test_no_change_returns_false(self):
        pos = {"j1": (8660000, 49340000), "j2": (8670000, 49350000), "j3": (8680000, 49360000)}
        self.tracker.feed(pos, _mono())
        assert self.tracker.feed(pos, _mono() + 1) is False

    def test_below_threshold_returns_false(self):
        pos1 = {"j1": (8660000, 49340000), "j2": (8670000, 49350000), "j3": (8680000, 49360000)}
        self.tracker.feed(pos1, _mono())
        pos2 = {"j1": (8660001, 49340001), "j2": (8670001, 49350001), "j3": (8680000, 49360000)}
        assert self.tracker.feed(pos2, _mono() + 1, min_changed=3) is False

    def test_at_threshold_returns_true(self):
        pos1 = {"j1": (8660000, 49340000), "j2": (8670000, 49350000), "j3": (8680000, 49360000)}
        self.tracker.feed(pos1, _mono())
        pos2 = {"j1": (8661000, 49341000), "j2": (8671000, 49351000), "j3": (8681000, 49361000)}
        ts = _mono() + 30
        assert self.tracker.feed(pos2, ts, min_changed=3) is True
        assert self.tracker.last_tick_ts == ts

    def test_small_shared_set_returns_false(self):
        pos1 = {"j1": (8660000, 49340000), "j2": (8670000, 49350000), "j3": (8680000, 49360000)}
        self.tracker.feed(pos1, _mono())
        pos2 = {"j4": (8661000, 49341000), "j5": (8671000, 49351000)}
        assert self.tracker.feed(pos2, _mono() + 30, min_changed=3) is False

    def test_empty_positions_seeds_then_returns_false(self):
        self.tracker.feed({}, _mono())
        assert self.tracker._last_positions == {}
        assert self.tracker.feed({}, _mono() + 1) is False

    def test_positions_capped_at_limit(self):
        big = {f"j{i}": (i, i) for i in range(1500)}
        self.tracker.feed(big, _mono())
        assert len(self.tracker._last_positions) <= TICK_POSITIONS_CAP

    def test_min_changed_1_single_bus_triggers(self):
        pos1 = {"j1": (8660000, 49340000), "j2": (8670000, 49350000)}
        self.tracker.feed(pos1, _mono())
        pos2 = {"j1": (8661000, 49341000), "j2": (8670000, 49350000)}
        assert self.tracker.feed(pos2, _mono() + 30, min_changed=1) is True

    def test_min_changed_2_needs_two_buses(self):
        pos1 = {"j1": (8660000, 49340000), "j2": (8670000, 49350000), "j3": (8680000, 49360000)}
        self.tracker.feed(pos1, _mono())
        pos2 = {"j1": (8661000, 49341000), "j2": (8670000, 49350000), "j3": (8680000, 49360000)}
        assert self.tracker.feed(pos2, _mono() + 30, min_changed=2) is False
        pos3 = {"j1": (8662000, 49342000), "j2": (8672000, 49352000), "j3": (8680000, 49360000)}
        assert self.tracker.feed(pos3, _mono() + 60, min_changed=2) is True


class TestTickTrackerPrediction:
    def setup_method(self):
        self.tracker = TickTracker()

    def test_no_tick_returns_none(self):
        assert self.tracker.next_tick_prediction() is None
        assert self.tracker.seconds_until_next_tick() is None

    def test_fresh_tick_predicts_next(self):
        self.tracker.last_tick_ts = _mono() - 0.5
        pred = self.tracker.next_tick_prediction()
        assert pred is not None
        assert pred > _mono()
        secs = self.tracker.seconds_until_next_tick()
        assert 29.0 < secs < 30.0

    def test_tick_exactly_one_period_ago(self):
        self.tracker.last_tick_ts = _mono() - TICK_PERIOD
        pred = self.tracker.next_tick_prediction()
        assert pred is not None
        diff = pred - _mono()
        assert -1 < diff < TICK_PERIOD + 1

    def test_stale_tick_returns_none(self):
        self.tracker.last_tick_ts = _mono() - TICK_MAX_AGE - 1
        assert self.tracker.next_tick_prediction() is None

    def test_tick_at_boundary_3h(self):
        self.tracker.last_tick_ts = _mono() - TICK_MAX_AGE + 10
        assert self.tracker.next_tick_prediction() is not None

    def test_elapsed_zero_predicts_one_period_ahead(self):
        self.tracker.last_tick_ts = _mono()
        pred = self.tracker.next_tick_prediction()
        expected = self.tracker.last_tick_ts + TICK_PERIOD
        assert abs(pred - expected) < 0.1


class TestTickTrackerCacheExpiry:
    def setup_method(self):
        self.tracker = TickTracker()

    def test_no_tick_uses_fallback(self):
        remaining = self.tracker.cache_expiry_seconds(age=2.0, fallback_ttl=9.5)
        assert abs(remaining - 7.5) < 0.1

    def test_known_tick_returns_positive(self):
        self.tracker.last_tick_ts = _mono() - 5
        remaining = self.tracker.cache_expiry_seconds(age=3.0)
        assert remaining > 0

    def test_stale_tick_uses_fallback(self):
        self.tracker.last_tick_ts = _mono() - TICK_MAX_AGE - 100
        remaining = self.tracker.cache_expiry_seconds(age=2.0, fallback_ttl=9.5)
        assert abs(remaining - 7.5) < 0.1

    def test_fresh_cache_not_expired_yet(self):
        self.tracker.last_tick_ts = _mono() - 1
        remaining = self.tracker.cache_expiry_seconds(age=0.5)
        assert remaining > 25

    def test_age_exceeds_fallback(self):
        remaining = self.tracker.cache_expiry_seconds(age=20.0, fallback_ttl=9.5)
        assert remaining == 0.0


class TestClientActivity:
    def test_initial_inactive(self):
        ca = ClientActivity()
        assert ca.is_active() is False

    def test_touch_makes_active(self):
        ca = ClientActivity()
        ca.touch()
        assert ca.is_active() is True

    def test_inactive_after_window(self):
        ca = ClientActivity()
        ca.last_ts = _mono() - ACTIVE_CLIENT_WINDOW - 1
        assert ca.is_active() is False

    def test_boundary_exact_window(self):
        ca = ClientActivity()
        ca.last_ts = _mono() - ACTIVE_CLIENT_WINDOW
        assert ca.is_active() is False


class TestInjectTickHints:
    def setup_method(self):
        self._orig_ts = tick_tracker.last_tick_ts

    def teardown_method(self):
        tick_tracker.last_tick_ts = self._orig_ts

    def test_unknown_tick_returns_null_fields(self):
        tick_tracker.last_tick_ts = None
        result = {"vehicles": [], "count": 0}
        out = _inject_tick_hints(result)
        assert out["nextFreshDataIn"] is None
        assert out["dataAge"] is None
        assert out is not result

    def test_known_tick_returns_numbers(self):
        tick_tracker.last_tick_ts = _mono() - 10
        result = {"vehicles": [], "count": 0}
        out = _inject_tick_hints(result)
        assert isinstance(out["nextFreshDataIn"], float)
        assert isinstance(out["dataAge"], float)
        assert out["nextFreshDataIn"] > 0
        assert 9 < out["dataAge"] < 12

    def test_does_not_mutate_original(self):
        tick_tracker.last_tick_ts = _mono() - 5
        result = {"vehicles": [1, 2, 3], "count": 3}
        out = _inject_tick_hints(result)
        assert "nextFreshDataIn" not in result
        assert "nextFreshDataIn" in out

    def test_data_age_capped_at_tick_period(self):
        tick_tracker.last_tick_ts = _mono() - 50
        result = {"vehicles": [], "count": 0}
        out = _inject_tick_hints(result)
        assert out["dataAge"] <= TICK_PERIOD

    def test_data_age_not_negative(self):
        tick_tracker.last_tick_ts = _mono() + 1
        result = {"vehicles": [], "count": 0}
        out = _inject_tick_hints(result)
        assert out["dataAge"] >= 0

    def test_stale_tick_returns_null(self):
        tick_tracker.last_tick_ts = _mono() - TICK_MAX_AGE - 100
        result = {"vehicles": [], "count": 0}
        out = _inject_tick_hints(result)
        assert out["nextFreshDataIn"] is None
        assert out["dataAge"] is None


class TestVehiclesEndpointTickHints:
    @pytest.fixture(autouse=True)
    def reset_state(self):
        orig_ts = tick_tracker.last_tick_ts
        orig_ca = client_activity.last_ts
        breaker.failures = 0
        breaker.last_failure_time = 0.0
        yield
        tick_tracker.last_tick_ts = orig_ts
        client_activity.last_ts = orig_ca
        breaker.failures = 0

    @pytest.fixture
    async def client(self):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c

    @pytest.mark.asyncio
    async def test_response_contains_tick_fields(self, client):
        resp = await client.get("/api/vehicles?swLat=49.3&swLon=8.6&neLat=49.4&neLon=8.7")
        if resp.status_code == 200:
            data = resp.json()
            assert "nextFreshDataIn" in data
            assert "dataAge" in data

    @pytest.mark.asyncio
    async def test_response_tick_null_when_no_tick(self, client):
        tick_tracker.last_tick_ts = None
        resp = await client.get("/api/vehicles?swLat=49.3&swLon=8.6&neLat=49.4&neLon=8.7")
        if resp.status_code == 200:
            data = resp.json()
            assert data["nextFreshDataIn"] is None
            assert data["dataAge"] is None

    @pytest.mark.asyncio
    async def test_client_activity_touched(self, client):
        client_activity.last_ts = 0
        await client.get("/api/vehicles?swLat=49.3&swLon=8.6&neLat=49.4&neLon=8.7")
        assert client_activity.last_ts > 0

    @pytest.mark.asyncio
    async def test_health_tick_fields(self, client):
        tick_tracker.last_tick_ts = _mono() - 5
        resp = await client.get("/api/health")
        data = resp.json()
        assert data["tick_known"] is True
        assert isinstance(data["tick_age_s"], float)
        assert data["calibrator_mode"] in ("active", "idle")

    @pytest.mark.asyncio
    async def test_health_no_tick(self, client):
        tick_tracker.last_tick_ts = None
        resp = await client.get("/api/health")
        data = resp.json()
        assert data["tick_known"] is False
        assert data["tick_age_s"] is None


class TestCalibration:
    @pytest.fixture(autouse=True)
    def reset_tracker(self):
        orig = tick_tracker.last_tick_ts
        orig_pos = tick_tracker._last_positions.copy()
        yield
        tick_tracker.last_tick_ts = orig
        tick_tracker._last_positions = orig_pos

    @pytest.mark.asyncio
    async def test_run_calibration_detects_tick(self):
        tick_tracker._last_positions = {}
        tick_tracker.last_tick_ts = None

        call_count = [0]
        positions_sequence = [
            {"j1": (8660000, 49340000), "j2": (8670000, 49350000), "j3": (8680000, 49360000)},
            {"j1": (8660000, 49340000), "j2": (8670000, 49350000), "j3": (8680000, 49360000)},
            {"j1": (8661000, 49341000), "j2": (8671000, 49351000), "j3": (8681000, 49361000)},
        ]

        async def mock_fetch(app_, breaker_, endpoint_, envelope_):
            idx = min(call_count[0], len(positions_sequence) - 1)
            call_count[0] += 1
            jny_l = [{"jid": k, "pos": {"x": v[0], "y": v[1]}} for k, v in positions_sequence[idx].items()]
            return {"jnyL": jny_l}

        mock_app = MagicMock()
        with patch("tick._calib_fetch", side_effect=mock_fetch):
            found = await _run_calibration(mock_app, breaker, tick_tracker,
                                           HAFAS_ENDPOINT, _build_hafas_envelope,
                                           scan_seconds=5, min_changed=TICK_MIN_CHANGED_BUSES)

        assert found is True
        assert tick_tracker.last_tick_ts is not None

    @pytest.mark.asyncio
    async def test_run_calibration_aborts_on_breaker_open(self):
        breaker.failures = 5
        breaker.last_failure_time = time.time()
        mock_app = MagicMock()

        found = await _run_calibration(mock_app, breaker, tick_tracker,
                                       HAFAS_ENDPOINT, _build_hafas_envelope,
                                       scan_seconds=5, min_changed=3)
        assert found is False

        breaker.failures = 0
        breaker.last_failure_time = 0.0

    @pytest.mark.asyncio
    async def test_run_calibration_handles_none_responses(self):
        tick_tracker._last_positions = {}

        async def mock_fetch(app_, breaker_, endpoint_, envelope_):
            return None

        mock_app = MagicMock()
        with patch("tick._calib_fetch", side_effect=mock_fetch):
            found = await _run_calibration(mock_app, breaker, tick_tracker,
                                           HAFAS_ENDPOINT, _build_hafas_envelope,
                                           scan_seconds=3, min_changed=3)

        assert found is False


class TestKillSwitch:
    @pytest.fixture
    async def client(self):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c

    @pytest.mark.asyncio
    async def test_tick_enabled_by_default(self):
        assert _TICK_ENABLED is True

    @pytest.mark.asyncio
    async def test_health_has_tick_fields_when_enabled(self, client):
        resp = await client.get("/api/health")
        data = resp.json()
        assert "tick_known" in data


class TestCalibFetch:
    @pytest.mark.asyncio
    async def test_returns_none_when_breaker_open(self):
        from tick import _calib_fetch
        mock_breaker = MagicMock()
        mock_breaker.is_open = True
        result = await _calib_fetch(MagicMock(), mock_breaker, "http://x", lambda m, r: {})
        assert result is None

    @pytest.mark.asyncio
    async def test_returns_res_on_success(self):
        from tick import _calib_fetch

        mock_breaker = MagicMock()
        mock_breaker.is_open = False

        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json.return_value = {
            "err": "OK",
            "svcResL": [{"err": "OK", "res": {"jnyL": [{"jid": "j1", "pos": {"x": 1, "y": 2}}]}}],
        }

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_resp
        mock_app = MagicMock()
        mock_app.state.client = mock_client

        result = await _calib_fetch(mock_app, mock_breaker, "http://x", lambda m, r: {"payload": True})
        assert result == {"jnyL": [{"jid": "j1", "pos": {"x": 1, "y": 2}}]}

    @pytest.mark.asyncio
    async def test_returns_none_on_api_error(self):
        from tick import _calib_fetch

        mock_breaker = MagicMock()
        mock_breaker.is_open = False

        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json.return_value = {"err": "FAIL", "svcResL": [{}]}

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_resp
        mock_app = MagicMock()
        mock_app.state.client = mock_client

        result = await _calib_fetch(mock_app, mock_breaker, "http://x", lambda m, r: {})
        assert result is None

    @pytest.mark.asyncio
    async def test_returns_none_on_svc_error(self):
        from tick import _calib_fetch

        mock_breaker = MagicMock()
        mock_breaker.is_open = False

        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json.return_value = {"err": "OK", "svcResL": [{"err": "FAIL"}]}

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_resp
        mock_app = MagicMock()
        mock_app.state.client = mock_client

        result = await _calib_fetch(mock_app, mock_breaker, "http://x", lambda m, r: {})
        assert result is None

    @pytest.mark.asyncio
    async def test_returns_none_on_exception(self):
        from tick import _calib_fetch

        mock_breaker = MagicMock()
        mock_breaker.is_open = False

        mock_client = AsyncMock()
        mock_client.post.side_effect = Exception("network error")
        mock_app = MagicMock()
        mock_app.state.client = mock_client

        result = await _calib_fetch(mock_app, mock_breaker, "http://x", lambda m, r: {})
        assert result is None


class TestTickCalibratorLoop:
    @pytest.mark.asyncio
    async def test_waits_for_client_then_calibrates(self):
        from tick import tick_calibrator, ClientActivity, TickTracker

        tracker = TickTracker()
        activity = ClientActivity()
        activity.touch()  # Already active
        mock_breaker = MagicMock()
        mock_breaker.is_open = False

        async def mock_run_calib(app, br, tr, ep, env, scan_seconds, min_changed):
            tr.last_tick_ts = _mono()
            return True

        mock_app = MagicMock()

        with patch("tick._run_calibration", side_effect=mock_run_calib):
            task = asyncio.create_task(tick_calibrator(
                mock_app, mock_breaker, tracker, activity, "http://x", lambda m, r: {}
            ))
            await asyncio.sleep(0.2)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

        assert tracker.last_tick_ts is not None

    @pytest.mark.asyncio
    async def test_cancellation_during_wait(self):
        from tick import tick_calibrator, ClientActivity, TickTracker

        tracker = TickTracker()
        activity = ClientActivity()
        mock_breaker = MagicMock()

        mock_app = MagicMock()
        task = asyncio.create_task(tick_calibrator(
            mock_app, mock_breaker, tracker, activity, "http://x", lambda m, r: {}
        ))
        await asyncio.sleep(0.1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


class TestPersistence:
    def test_persist_and_load(self, tmp_path, monkeypatch):
        from tick import TICK_STATE_FILE
        state_file = tmp_path / ".tick_state"
        monkeypatch.setattr("tick.TICK_STATE_FILE", state_file)

        tracker = TickTracker()
        ts = _mono() - 10
        tracker.last_tick_ts = ts
        tracker._persist_tick(ts)

        assert state_file.exists()
        data = json.loads(state_file.read_text())
        assert "mono_offset" in data

    def test_load_persisted_valid(self, tmp_path, monkeypatch):
        import json as json_mod
        from tick import TICK_STATE_FILE
        state_file = tmp_path / ".tick_state"
        monkeypatch.setattr("tick.TICK_STATE_FILE", state_file)

        # Simulate a recent tick
        mono_offset = time.time() - (_mono() - 5)
        state_file.write_text(json_mod.dumps({"mono_offset": mono_offset}))

        tracker = TickTracker()
        tracker.load_persisted()
        assert tracker.last_tick_ts is not None
        age = _mono() - tracker.last_tick_ts
        assert 4 < age < 7

    def test_load_persisted_stale(self, tmp_path, monkeypatch):
        import json as json_mod
        from tick import TICK_STATE_FILE
        state_file = tmp_path / ".tick_state"
        monkeypatch.setattr("tick.TICK_STATE_FILE", state_file)

        # Simulate a very old tick (> TICK_MAX_AGE)
        mono_offset = time.time() - (_mono() - TICK_MAX_AGE - 100)
        state_file.write_text(json_mod.dumps({"mono_offset": mono_offset}))

        tracker = TickTracker()
        tracker.load_persisted()
        assert tracker.last_tick_ts is None

    def test_load_persisted_missing_file(self, tmp_path, monkeypatch):
        from tick import TICK_STATE_FILE
        state_file = tmp_path / ".tick_state_nonexistent"
        monkeypatch.setattr("tick.TICK_STATE_FILE", state_file)

        tracker = TickTracker()
        tracker.load_persisted()
        assert tracker.last_tick_ts is None

    def test_load_persisted_corrupt_json(self, tmp_path, monkeypatch):
        from tick import TICK_STATE_FILE
        state_file = tmp_path / ".tick_state"
        state_file.write_text("not valid json{{{")
        monkeypatch.setattr("tick.TICK_STATE_FILE", state_file)

        tracker = TickTracker()
        tracker.load_persisted()
        assert tracker.last_tick_ts is None

    def test_load_persisted_missing_key(self, tmp_path, monkeypatch):
        import json as json_mod
        from tick import TICK_STATE_FILE
        state_file = tmp_path / ".tick_state"
        state_file.write_text(json_mod.dumps({"wrong_key": 123}))
        monkeypatch.setattr("tick.TICK_STATE_FILE", state_file)

        tracker = TickTracker()
        tracker.load_persisted()
        assert tracker.last_tick_ts is None

    def test_persist_tick_handles_write_error(self, tmp_path, monkeypatch):
        from tick import TICK_STATE_FILE
        # Point to a non-writable directory
        state_file = tmp_path / "nonexistent_dir" / ".tick_state"
        monkeypatch.setattr("tick.TICK_STATE_FILE", state_file)

        tracker = TickTracker()
        # Should not raise
        tracker._persist_tick(_mono())


class TestSingleflight:
    @pytest.fixture(autouse=True)
    def reset_state(self):
        from proxy import _inflight, tick_tracker as tt, client_activity as ca, cache
        _inflight.clear()
        cache._key = None
        cache._data = None
        cache._ts = 0
        orig_ts = tt.last_tick_ts
        orig_ca = ca.last_ts
        breaker.failures = 0
        breaker.last_failure_time = 0.0
        yield
        _inflight.clear()
        cache._key = None
        cache._data = None
        cache._ts = 0
        tt.last_tick_ts = orig_ts
        ca.last_ts = orig_ca
        breaker.failures = 0

    @pytest.fixture
    async def client(self):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c

    @pytest.mark.asyncio
    async def test_concurrent_same_key_single_hafas_call(self, client):
        """Two concurrent requests with same bbox should result in only one HAFAS call."""
        import proxy
        call_count = [0]

        async def mock_hafas(request, method, req):
            call_count[0] += 1
            await asyncio.sleep(0.1)
            return {"common": {"prodL": [], "locL": []}, "jnyL": []}

        with patch.object(proxy, '_hafas_call', side_effect=mock_hafas):
            results = await asyncio.gather(
                client.get("/api/vehicles?swLat=49.30&swLon=8.60&neLat=49.40&neLon=8.70"),
                client.get("/api/vehicles?swLat=49.30&swLon=8.60&neLat=49.40&neLon=8.70"),
            )
        assert results[0].status_code == 200
        assert results[1].status_code == 200
        assert call_count[0] == 1

    @pytest.mark.asyncio
    async def test_different_keys_both_fetch(self, client):
        """Two requests with different bbox should both fetch independently."""
        import proxy
        call_count = [0]

        async def mock_hafas(request, method, req):
            call_count[0] += 1
            await asyncio.sleep(0.05)
            return {"common": {"prodL": [], "locL": []}, "jnyL": []}

        with patch.object(proxy, '_hafas_call', side_effect=mock_hafas):
            results = await asyncio.gather(
                client.get("/api/vehicles?swLat=49.30&swLon=8.60&neLat=49.40&neLon=8.70"),
                client.get("/api/vehicles?swLat=49.00&swLon=8.00&neLat=49.10&neLon=8.10"),
            )
        assert results[0].status_code == 200
        assert results[1].status_code == 200
        assert call_count[0] == 2

    @pytest.mark.asyncio
    async def test_inflight_cleaned_up_after_request(self, client):
        """_inflight dict should be empty after requests complete."""
        from proxy import _inflight
        await client.get("/api/vehicles?swLat=49.30&swLon=8.60&neLat=49.40&neLon=8.70")
        assert len(_inflight) == 0
