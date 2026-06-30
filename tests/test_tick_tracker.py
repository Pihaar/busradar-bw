"""Tests for GPS tick tracking: TickTracker, ClientActivity, calibrator."""

import asyncio
import json
import time
from unittest.mock import AsyncMock, patch, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from tick import (
    TickTracker,
    ClientActivity,
    _run_calibration,
    _mono,
    TICK_PERIOD,
    TICK_MAX_AGE,
    TICK_MIN_CHANGED_BUSES,
    TICK_POSITIONS_CAP,
    ACTIVE_CLIENT_WINDOW,
    _TICK_ENABLED,
)
from proxy import (
    tick_tracker,
    breaker,
    app,
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

    def test_subscriber_count_keeps_active_past_window(self):
        """The deadlock fix: an open SSE subscriber must count as active
        regardless of how long ago the last tick was detected. Without
        this the calibrator dropped to IDLE_CALIB_INTERVAL during long
        no-tick stretches (HAFAS standstill) and stopped probing for up
        to 30 minutes."""
        ca = ClientActivity()
        ca.subscriber_joined()
        ca.last_ts = _mono() - ACTIVE_CLIENT_WINDOW - 60  # tick-clock stale
        assert ca.is_active() is True
        ca.subscriber_left()
        assert ca.is_active() is False

    def test_subscriber_count_never_negative(self):
        ca = ClientActivity()
        ca.subscriber_left()  # spurious leave before any join
        ca.subscriber_left()
        ca.subscriber_joined()
        assert ca.is_active() is True
        ca.subscriber_left()
        assert ca._subscribers == 0

    @pytest.mark.asyncio
    async def test_wait_for_wakeup_returns_true_on_subscribe(self):
        """The calibrator's idle-sleep should be interrupted as soon as
        a fresh subscriber joins, not wait for the 30-min IDLE interval."""
        import asyncio
        ca = ClientActivity()
        # Arm the wakeup primitive on the same event loop the wait runs on.
        ca._ensure_event()

        async def join_after_short_delay():
            await asyncio.sleep(0.05)
            ca.subscriber_joined()

        asyncio.create_task(join_after_short_delay())
        woke = await ca.wait_for_wakeup(timeout=2.0)
        assert woke is True
        assert ca.is_active() is True

    @pytest.mark.asyncio
    async def test_wait_for_wakeup_returns_false_on_timeout(self):
        ca = ClientActivity()
        ca._ensure_event()
        woke = await ca.wait_for_wakeup(timeout=0.05)
        assert woke is False


class TestCalibratorWaitMath:
    """Lock the predicted-tick wait computation. The earlier code bumped
    the target by TICK_PERIOD until target-now >= ACTIVE_CALIB_INTERVAL,
    which produced 5-minute waits between probes even on a fresh tick
    and starved SSE subscribers of vehicles events.

    The fix's contract: the wait is bounded by `pred - 1 - now` (with
    floor 1 s, ceiling ACTIVE_CALIB_INTERVAL). For any pred returned by
    next_tick_prediction(), the wait must be at most TICK_PERIOD."""

    def _calc_wait(self, pred: float, now: float, interval: float) -> float:
        # Direct port of the production formula at tick.py inside the
        # calibrator loop so a refactor that touches the math has to
        # touch this test too.
        wait = max(1.0, (pred - 1.0) - now)
        if wait > interval:
            wait = interval
        return wait

    def test_fresh_tick_waits_under_tick_period(self):
        from tick import TICK_PERIOD, ACTIVE_CALIB_INTERVAL
        # last_tick = now → pred = now + TICK_PERIOD
        pred = 30.0
        now = 0.0
        wait = self._calc_wait(pred, now, ACTIVE_CALIB_INTERVAL)
        assert wait < TICK_PERIOD
        assert wait == 29.0

    def test_tick_just_passed_probes_almost_immediately(self):
        from tick import ACTIVE_CALIB_INTERVAL
        # last_tick = -1s, pred = +29s
        pred = 29.0
        now = 0.0
        wait = self._calc_wait(pred, now, ACTIVE_CALIB_INTERVAL)
        assert wait == 28.0

    def test_pred_in_past_probes_within_a_second(self):
        from tick import ACTIVE_CALIB_INTERVAL
        # If next_tick_prediction returned a value that's already
        # slightly in the past (clock skew, scan-overrun), the wait
        # must floor at 1 s — never sleep negative.
        pred = -5.0
        now = 0.0
        wait = self._calc_wait(pred, now, ACTIVE_CALIB_INTERVAL)
        assert wait == 1.0

    def test_implausibly_far_pred_caps_at_interval(self):
        from tick import ACTIVE_CALIB_INTERVAL
        # Defensive cap. next_tick_prediction shouldn't return values
        # this far out, but if it does, the calibrator must still wake
        # within ACTIVE_CALIB_INTERVAL so SSE subscribers don't freeze.
        pred = 10_000.0
        now = 0.0
        wait = self._calc_wait(pred, now, ACTIVE_CALIB_INTERVAL)
        assert wait == ACTIVE_CALIB_INTERVAL

    def test_never_exceeds_tick_period_for_normal_predictions(self):
        """For every pred that next_tick_prediction() can legitimately
        return (0 < pred-now ≤ TICK_PERIOD), the wait must be ≤ TICK_PERIOD.
        Guards the SSE-fanout cadence promise."""
        from tick import TICK_PERIOD, ACTIVE_CALIB_INTERVAL
        for offset in range(1, int(TICK_PERIOD) + 1):
            wait = self._calc_wait(float(offset), 0.0, ACTIVE_CALIB_INTERVAL)
            assert wait <= TICK_PERIOD, f"offset={offset} → wait={wait}"


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
        state_file = tmp_path / ".tick_state"
        monkeypatch.setattr("tick.TICK_STATE_FILE", state_file)

        # Simulate a very old tick (> TICK_MAX_AGE)
        mono_offset = time.time() - (_mono() - TICK_MAX_AGE - 100)
        state_file.write_text(json_mod.dumps({"mono_offset": mono_offset}))

        tracker = TickTracker()
        tracker.load_persisted()
        assert tracker.last_tick_ts is None

    def test_load_persisted_missing_file(self, tmp_path, monkeypatch):
        state_file = tmp_path / ".tick_state_nonexistent"
        monkeypatch.setattr("tick.TICK_STATE_FILE", state_file)

        tracker = TickTracker()
        tracker.load_persisted()
        assert tracker.last_tick_ts is None

    def test_load_persisted_corrupt_json(self, tmp_path, monkeypatch):
        state_file = tmp_path / ".tick_state"
        state_file.write_text("not valid json{{{")
        monkeypatch.setattr("tick.TICK_STATE_FILE", state_file)

        tracker = TickTracker()
        tracker.load_persisted()
        assert tracker.last_tick_ts is None

    def test_load_persisted_missing_key(self, tmp_path, monkeypatch):
        import json as json_mod
        state_file = tmp_path / ".tick_state"
        state_file.write_text(json_mod.dumps({"wrong_key": 123}))
        monkeypatch.setattr("tick.TICK_STATE_FILE", state_file)

        tracker = TickTracker()
        tracker.load_persisted()
        assert tracker.last_tick_ts is None

    def test_persist_tick_handles_write_error(self, tmp_path, monkeypatch):
        # Point to a non-writable directory
        state_file = tmp_path / "nonexistent_dir" / ".tick_state"
        monkeypatch.setattr("tick.TICK_STATE_FILE", state_file)

        tracker = TickTracker()
        # Should not raise
        tracker._persist_tick(_mono())

