"""Tests for tick.sse_push_loop — the 10s SSE broadcast pacemaker.

Covers cadence (fires fire_push_tick every SSE_PUSH_PERIOD), idle-block-on-
no-subscribers, subscriber-join wakeup, and error-recovery."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

import fanout
import tick
from tick import ClientActivity, TickTracker, _push_grid_fire, sse_push_loop


@pytest.fixture
def fresh_fanout(monkeypatch):
    monkeypatch.setattr(fanout, "tick_seq", 0)
    monkeypatch.setattr(fanout, "push_seq", 0)
    monkeypatch.setattr(fanout, "tick_push_seq", 0)


# A tracker with no detected tick → next_tick_prediction() returns None → the
# loop takes the fixed-cadence fallback path, which is what the cadence tests
# below exercise (one fire per SSE_PUSH_PERIOD).
def _uncalibrated_tracker():
    return TickTracker()


class TestSsePushLoopCadence:
    @pytest.mark.asyncio
    async def test_loop_fires_at_push_period(self, monkeypatch, fresh_fanout):
        """3 firings expected within 3.5 × SSE_PUSH_PERIOD. Shorten period
        to keep tests fast."""
        monkeypatch.setattr(tick, "SSE_PUSH_PERIOD", 0.05)
        mock_fire = AsyncMock()
        monkeypatch.setattr(fanout, "fire_push_tick", mock_fire)

        activity = ClientActivity()
        activity.subscriber_joined()  # >=1 sub → loop is active

        task = asyncio.create_task(sse_push_loop(activity, _uncalibrated_tracker()))
        try:
            await asyncio.sleep(0.05 * 3.5)
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        # 3 or 4 fires depending on exact scheduler timing; assert >= 3
        assert mock_fire.call_count >= 3, f"expected >=3 fires, got {mock_fire.call_count}"

    @pytest.mark.asyncio
    async def test_loop_idle_when_no_subscribers(self, monkeypatch, fresh_fanout):
        """0 subscribers → loop blocks on wakeup, does NOT fire fire_push_tick."""
        monkeypatch.setattr(tick, "SSE_PUSH_PERIOD", 0.02)
        mock_fire = AsyncMock()
        monkeypatch.setattr(fanout, "fire_push_tick", mock_fire)

        activity = ClientActivity()  # no subscribers
        task = asyncio.create_task(sse_push_loop(activity, _uncalibrated_tracker()))
        try:
            await asyncio.sleep(0.15)  # much longer than SSE_PUSH_PERIOD
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        assert mock_fire.call_count == 0

    @pytest.mark.asyncio
    async def test_loop_wakes_up_on_subscriber_join(self, monkeypatch, fresh_fanout):
        """Loop is idle-blocked; subscriber_joined() must unblock it and
        the next push must fire within SSE_PUSH_PERIOD."""
        monkeypatch.setattr(tick, "SSE_PUSH_PERIOD", 0.03)
        mock_fire = AsyncMock()
        monkeypatch.setattr(fanout, "fire_push_tick", mock_fire)

        activity = ClientActivity()
        task = asyncio.create_task(sse_push_loop(activity, _uncalibrated_tracker()))
        try:
            await asyncio.sleep(0.05)  # let it park in wait_for_wakeup
            assert mock_fire.call_count == 0
            activity.subscriber_joined()
            await asyncio.sleep(0.05 + 0.03)  # wakeup latency + one SSE_PUSH_PERIOD
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        assert mock_fire.call_count >= 1

    @pytest.mark.asyncio
    async def test_fire_push_tick_exception_does_not_kill_loop(self, monkeypatch, fresh_fanout):
        """Ensure a single fire_push_tick failure is swallowed and the next
        iteration still runs — otherwise a transient HAFAS blip would kill
        SSE forever."""
        monkeypatch.setattr(tick, "SSE_PUSH_PERIOD", 0.03)
        call_log: list[int] = []

        async def fire_flaky(tick_aligned=False):
            call_log.append(1)
            if len(call_log) == 1:
                raise RuntimeError("transient")

        monkeypatch.setattr(fanout, "fire_push_tick", fire_flaky)

        activity = ClientActivity()
        activity.subscriber_joined()

        task = asyncio.create_task(sse_push_loop(activity, _uncalibrated_tracker()))
        try:
            await asyncio.sleep(0.15)
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        # At least 2 iterations must have run (first raised, second succeeded).
        assert len(call_log) >= 2


class TestCalibratorNoLongerBroadcasts:
    def test_calibrator_source_does_not_call_fire_tick(self):
        """The calibrator was the sole caller of fanout.fire_tick before v1.2.0.
        Regression guard: the string must not appear in the calibrator
        implementation. sse_push_loop uses fire_push_tick instead."""
        import inspect

        src = inspect.getsource(tick._run_calibration)
        assert "fire_tick" not in src, "calibrator must not broadcast"
        src2 = inspect.getsource(tick.tick_calibrator)
        assert "fire_tick" not in src2 and "fire_push_tick" not in src2


class TestPushGridFire:
    """Pure, deterministic tests of the phase-locked grid formula, using the
    REAL module constants (TICK_PERIOD=30, SSE_PUSH_PERIOD=10, TICK_BUFFER=1),
    so the '30 = 3 x 10' every-third-aligned property holds."""

    def test_math_floor_not_int_regression(self):
        # now just after a tick, next tick +30s away. int() would truncate the
        # negative numerator toward zero and place the first fire at +11s;
        # math.floor correctly places it at +1s (TICK_BUFFER after the tick).
        wait, aligned = _push_grid_fire(pred=30.0, now=0.0)
        assert abs(wait - 1.0) < 1e-9, f"expected first fire at +1s, got {wait}"
        assert aligned is True

    def test_full_cycle_two_aligned_per_period(self):
        # Walk the grid across one full TICK_PERIOD from a fresh tick.
        seq = []
        for now in (0.0, 1.0, 11.0, 21.0):
            seq.append(_push_grid_fire(pred=30.0, now=now))
        # (wait, aligned): +1 aligned, then +10 spacing, aligned only on the
        # tick-coincident grid point.
        assert seq[0] == (1.0, True)  # fire at t=1 (tick just passed)
        assert seq[1] == (10.0, False)  # t=1 -> next fire t=11
        assert seq[2] == (10.0, False)  # t=11 -> t=21
        assert seq[3] == (10.0, True)  # t=21 -> t=31 (next tick +1)

    def test_join_just_before_tick(self):
        wait, aligned = _push_grid_fire(pred=30.0, now=29.0)
        assert abs(wait - 2.0) < 1e-9  # next aligned fire at t=31
        assert aligned is True

    def test_grid_point_yields_strictly_future_fire(self):
        # now exactly on a grid point (t=11) must return the NEXT point (t=21),
        # never a zero/negative wait that would double-fire.
        wait, aligned = _push_grid_fire(pred=30.0, now=11.0)
        assert wait > 0
        assert abs(wait - 10.0) < 1e-9

    def test_pred_equals_now_boundary(self):
        # Tick coincident with now (next_tick_prediction can return pred == now
        # at an exact TICK_PERIOD boundary): still a strictly-future fire at
        # now + TICK_BUFFER, flagged aligned. No zero/negative wait.
        wait, aligned = _push_grid_fire(pred=30.0, now=30.0)
        assert abs(wait - 1.0) < 1e-9
        assert aligned is True

    def test_now_just_past_pred(self):
        # _mono() sampled a hair after pred was computed (loop reality) → still
        # a positive wait and still the tick-coincident aligned fire.
        wait, aligned = _push_grid_fire(pred=30.0, now=30.5)
        assert abs(wait - 0.5) < 1e-9
        assert aligned is True

    def test_wait_bounded_and_positive_for_any_pred(self):
        # Sweep now across a full period for several pred offsets; wait always
        # in (0, SSE_PUSH_PERIOD] and never exceeds the safety clamp.
        for pred in (5.0, 15.0, 30.0, 100.0):
            for i in range(60):
                now = i * 0.5
                if now >= pred:
                    continue  # pred must be in the future
                wait, _ = _push_grid_fire(pred=pred, now=now)
                assert 0 < wait <= tick.SSE_PUSH_PERIOD + tick.TICK_BUFFER

    def test_aligned_exactly_every_third_grid_point(self):
        # Starting from the first fire, every third subsequent fire is aligned.
        pred, now = 30.0, 0.0
        flags = []
        for _ in range(9):
            wait, aligned = _push_grid_fire(pred=pred, now=now)
            flags.append(aligned)
            now += wait  # advance to the fire, then a hair past to force next
            now += 1e-6
        # first fire aligned (tick just passed), then True every 3rd.
        assert flags[0] is True
        assert [i for i, f in enumerate(flags) if f] == [0, 3, 6]


class TestPushLoopAlignmentWiring:
    @pytest.mark.asyncio
    async def test_fallback_flags_every_third_fire_aligned(self, monkeypatch, fresh_fanout):
        """Uncalibrated tracker → fallback path → tick_aligned pattern
        True, False, False, True, ... so REPORT_ONLY keeps a ~30s cadence."""
        monkeypatch.setattr(tick, "SSE_PUSH_PERIOD", 0.02)
        mock_fire = AsyncMock()
        monkeypatch.setattr(fanout, "fire_push_tick", mock_fire)
        activity = ClientActivity()
        activity.subscriber_joined()
        task = asyncio.create_task(sse_push_loop(activity, _uncalibrated_tracker()))
        try:
            await asyncio.sleep(0.02 * 6.5)
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        flags = [c.kwargs.get("tick_aligned") for c in mock_fire.call_args_list]
        assert len(flags) >= 4
        # Fire #0 aligned, #1/#2 not, #3 aligned.
        assert flags[0] is True
        assert flags[1] is False and flags[2] is False
        assert flags[3] is True

    @pytest.mark.asyncio
    async def test_calibrated_tracker_produces_aligned_and_unaligned_fires(
        self, monkeypatch, fresh_fanout
    ):
        """With a known tick, the loop emits a mix of aligned and unaligned
        fires (proving it uses the phase-locked grid, not a flat fallback)."""
        # Shrink the whole timescale keeping the 3:1 ratio (30 = 3 x 10).
        monkeypatch.setattr(tick, "SSE_PUSH_PERIOD", 0.03)
        monkeypatch.setattr(tick, "TICK_PERIOD", 0.09)
        monkeypatch.setattr(tick, "TICK_BUFFER", 0.005)
        mock_fire = AsyncMock()
        monkeypatch.setattr(fanout, "fire_push_tick", mock_fire)
        tracker = TickTracker()
        tracker.last_tick_ts = tick._mono()  # tick "just now"
        activity = ClientActivity()
        activity.subscriber_joined()
        task = asyncio.create_task(sse_push_loop(activity, tracker))
        try:
            await asyncio.sleep(0.09 * 4)
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        flags = [c.kwargs.get("tick_aligned") for c in mock_fire.call_args_list]
        assert any(f is True for f in flags), f"no aligned fire: {flags}"
        assert any(f is False for f in flags), f"no unaligned fire: {flags}"

    @pytest.mark.asyncio
    async def test_calibration_loss_still_produces_aligned_fires(self, monkeypatch, fresh_fanout):
        """Transition calibrated → uncalibrated mid-loop (tick goes stale). The
        loop must keep flagging tick-aligned fires in the fallback regime so
        REPORT_ONLY is not starved beyond one cycle. fallback_fires is reset to
        0 when the phase-locked branch runs, so the first fallback fire is
        aligned."""
        monkeypatch.setattr(tick, "SSE_PUSH_PERIOD", 0.03)
        monkeypatch.setattr(tick, "TICK_PERIOD", 0.09)
        monkeypatch.setattr(tick, "TICK_BUFFER", 0.005)

        class _FlipTracker:
            def __init__(self, flip_after):
                self._ts = tick._mono()
                self._flip_after = flip_after
                self._n = 0

            def next_tick_prediction(self):
                self._n += 1
                if self._n > self._flip_after:
                    return None  # calibration lost
                now = tick._mono()
                elapsed = now - self._ts
                cycles = int(elapsed / tick.TICK_PERIOD) + (
                    0 if elapsed % tick.TICK_PERIOD == 0 else 1
                )
                return self._ts + max(1, cycles) * tick.TICK_PERIOD

        mock_fire = AsyncMock()
        monkeypatch.setattr(fanout, "fire_push_tick", mock_fire)
        tracker = _FlipTracker(flip_after=3)
        activity = ClientActivity()
        activity.subscriber_joined()
        task = asyncio.create_task(sse_push_loop(activity, tracker))
        try:
            await asyncio.sleep(0.09 * 5)
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        flags = [c.kwargs.get("tick_aligned") for c in mock_fire.call_args_list]
        # An aligned fire must occur in BOTH regimes (calibrated prefix and the
        # fallback tail) — the seam must not starve REPORT_ONLY of alignment.
        assert len(flags) >= 5, f"too few fires: {flags}"
        assert any(f is True for f in flags[:3]), f"no aligned fire while calibrated: {flags}"
        assert any(f is True for f in flags[3:]), f"no aligned fire after calibration loss: {flags}"
