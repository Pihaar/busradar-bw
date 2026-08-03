"""Tests for the SSE-side Steig board-tagging + backfill + cache-warmer wiring
(tag_board_result, _schedule_steig_backfill, _warm_steig_families, steig_warm_loop)."""

from __future__ import annotations

import asyncio
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

import sse_handler
import steig

_A = "4466864"  # Walldorf-Drehscheibe Steig A (in the real config)


@pytest.fixture
def reset_steig(monkeypatch):
    steig._steig_cache.clear()
    steig._steig_inflight.clear()
    steig._family_stats.clear()
    monkeypatch.setattr(steig, "_now", lambda: 1000.0)
    yield
    steig._steig_cache.clear()
    steig._steig_inflight.clear()
    steig._family_stats.clear()


def _sd() -> str:
    return datetime.now(ZoneInfo("Europe/Berlin")).strftime("%Y%m%d")


def _board(rows):
    return {"jnyL": [{"jid": j, "stbStop": {"dTimeS": t}} for j, t in rows]}


class TestTagBoardResult:
    def test_arr_board_returned_unchanged(self, reset_steig):
        board = _board([("j1", "134500")])
        out = sse_handler.tag_board_result(None, f"A=1@L={_A}@", "ARR", board)
        assert out is board  # identity, no platforms

    def test_lid_without_extid_unchanged(self, reset_steig):
        board = _board([("j1", "134500")])
        assert sse_handler.tag_board_result(None, "A=1@O=foo@", "DEP", board) is board

    def test_non_family_stop_unchanged(self, reset_steig):
        board = _board([("j1", "134500")])
        assert sse_handler.tag_board_result(None, "A=1@L=9999999@", "DEP", board) is board

    def test_family_cache_hit_tags_without_backfill(self, reset_steig, monkeypatch):
        scheduled = []
        monkeypatch.setattr(sse_handler, "_schedule_steig_backfill", lambda *a: scheduled.append(a))
        steig._steig_cache[("j1", _sd())] = (1000.0, {"134500": _A})
        board = _board([("j1", "134500")])
        out = sse_handler.tag_board_result(None, f"A=1@L={_A}@", "DEP", board)
        assert out["platforms"] == [_A]
        assert "platforms" not in board  # shallow copy — cached board untouched
        assert scheduled == []  # nothing unresolved -> no backfill

    def test_family_cache_miss_schedules_backfill(self, reset_steig, monkeypatch):
        scheduled = []
        monkeypatch.setattr(sse_handler, "_schedule_steig_backfill", lambda *a: scheduled.append(a))
        board = _board([("j1", "134500")])
        out = sse_handler.tag_board_result(None, f"A=1@L={_A}@", "DEP", board)
        assert out["platforms"] == [None]  # fail-open until backfill lands
        assert scheduled == [(None, ["j1"], _sd())]


class TestScheduleBackfill:
    async def test_populates_cache_via_journey_fetch(self, reset_steig, monkeypatch):
        async def fake_fetch(app, jid):
            return {
                "common": {"locL": [{"extId": _A}]},
                "journey": {"stopL": [{"locX": 0, "dTimeS": "134500"}]},
            }

        monkeypatch.setattr(sse_handler, "_fetch_journey_for_subscriber", fake_fetch)
        sd = "20260101"
        sse_handler._schedule_steig_backfill(object(), ["j1"], sd)
        await asyncio.gather(*list(sse_handler._backfill_tasks))
        # The done-callback (_backfill_tasks.discard) is scheduled via call_soon,
        # so it runs on the next loop iteration, not synchronously when gather
        # returns — yield once so the ref is actually cleared before asserting.
        await asyncio.sleep(0)
        assert steig._steig_cache[("j1", sd)][1] == {"134500": _A}
        assert not sse_handler._backfill_tasks  # done-callback cleared the ref


class TestWarmSteigFamilies:
    async def test_warms_family_cache(self, reset_steig, monkeypatch):
        async def fake_board(app, lid, board_type, dur):
            assert board_type == "DEP" and dur == 1440
            return _board([("jA", "134500"), ("jB", "150000")])

        jd_map = {
            "jA": {
                "common": {"locL": [{"extId": _A}]},
                "journey": {"stopL": [{"locX": 0, "dTimeS": "134500"}]},
            },
            "jB": {
                "common": {"locL": [{"extId": "4407123"}]},
                "journey": {"stopL": [{"locX": 0, "dTimeS": "150000"}]},
            },
        }

        async def fake_jd(app, jid):
            return jd_map[jid]

        monkeypatch.setattr(sse_handler, "_fetch_stationboard_for_subscriber", fake_board)
        monkeypatch.setattr(sse_handler, "_fetch_journey_for_subscriber", fake_jd)
        await sse_handler._warm_steig_families(object())
        sd = _sd()
        assert steig._steig_cache[("jA", sd)][1] == {"134500": _A}
        assert steig._steig_cache[("jB", sd)][1] == {"150000": "4407123"}

    async def test_skips_on_board_error(self, reset_steig, monkeypatch):
        async def fake_board(app, lid, board_type, dur):
            return {"error": "upstream"}

        called = []

        async def fake_jd(app, jid):
            called.append(jid)
            return {}

        monkeypatch.setattr(sse_handler, "_fetch_stationboard_for_subscriber", fake_board)
        monkeypatch.setattr(sse_handler, "_fetch_journey_for_subscriber", fake_jd)
        await sse_handler._warm_steig_families(object())
        assert steig._steig_cache == {}
        assert called == []  # no JD fetch when the board errors

    async def test_board_without_jids_no_backfill(self, reset_steig, monkeypatch):
        async def fake_board(app, lid, board_type, dur):
            return {"jnyL": [{"stbStop": {"dTimeS": "134500"}}]}  # jny without jid

        monkeypatch.setattr(sse_handler, "_fetch_stationboard_for_subscriber", fake_board)
        await sse_handler._warm_steig_families(object())
        assert steig._steig_cache == {}


class TestSteigWarmLoop:
    async def test_normal_then_exception_iteration(self, reset_steig, monkeypatch):
        seq = []

        async def fake_warm(app):
            seq.append(1)
            if len(seq) == 2:
                raise RuntimeError("boom")  # exercises the except-Exception arm

        monkeypatch.setattr(sse_handler, "_warm_steig_families", fake_warm)
        monkeypatch.setattr(sse_handler, "_STEIG_WARM_INTERVAL_S", 0.001)
        task = asyncio.create_task(sse_handler.steig_warm_loop(object()))
        await asyncio.sleep(0.02)
        task.cancel()  # cancel lands during a sleep (outside the try) -> propagates
        with pytest.raises(asyncio.CancelledError):
            await task
        assert len(seq) >= 2  # ran a normal AND an exception iteration

    async def test_cancel_during_warm_reraises(self, reset_steig, monkeypatch):
        started = asyncio.Event()

        async def fake_warm(app):
            started.set()
            await asyncio.sleep(10)  # block so the cancel lands INSIDE the try

        monkeypatch.setattr(sse_handler, "_warm_steig_families", fake_warm)
        task = asyncio.create_task(sse_handler.steig_warm_loop(object()))
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
