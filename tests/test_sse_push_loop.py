"""Tests for tick.sse_push_loop — the 10s SSE broadcast pacemaker.

Covers cadence (fires fire_push_tick every SSE_PUSH_PERIOD), idle-block-on-
no-subscribers, subscriber-join wakeup, and error-recovery."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

import fanout
import tick
from tick import ClientActivity, sse_push_loop


@pytest.fixture
def fresh_fanout(monkeypatch):
    monkeypatch.setattr(fanout, "tick_seq", 0)
    monkeypatch.setattr(fanout, "push_seq", 0)


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

        task = asyncio.create_task(sse_push_loop(activity))
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
        task = asyncio.create_task(sse_push_loop(activity))
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
        task = asyncio.create_task(sse_push_loop(activity))
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

        async def fire_flaky():
            call_log.append(1)
            if len(call_log) == 1:
                raise RuntimeError("transient")

        monkeypatch.setattr(fanout, "fire_push_tick", fire_flaky)

        activity = ClientActivity()
        activity.subscriber_joined()

        task = asyncio.create_task(sse_push_loop(activity))
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
