"""Tests for the SSE-side Steig board-tagging + backfill wiring
(_tag_stationboard, _schedule_steig_backfill)."""

from __future__ import annotations

import asyncio
from datetime import datetime
from types import SimpleNamespace
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


class TestTagStationboard:
    def test_arr_board_not_tagged(self, reset_steig):
        payload: dict = {}
        sel = SimpleNamespace(lid=f"A=1@L={_A}@", board_type="ARR")
        sse_handler._tag_stationboard(None, sel, _board([("j1", "134500")]), payload)
        assert "platforms" not in payload

    def test_lid_without_extid_not_tagged(self, reset_steig):
        payload: dict = {}
        sel = SimpleNamespace(lid="A=1@O=foo@", board_type="DEP")
        sse_handler._tag_stationboard(None, sel, _board([("j1", "134500")]), payload)
        assert "platforms" not in payload

    def test_non_family_stop_not_tagged(self, reset_steig):
        payload: dict = {}
        sel = SimpleNamespace(lid="A=1@L=9999999@", board_type="DEP")
        sse_handler._tag_stationboard(None, sel, _board([("j1", "134500")]), payload)
        assert "platforms" not in payload

    def test_family_cache_hit_tags_without_backfill(self, reset_steig, monkeypatch):
        scheduled = []
        monkeypatch.setattr(sse_handler, "_schedule_steig_backfill", lambda *a: scheduled.append(a))
        steig._steig_cache[("j1", _sd())] = (1000.0, {"134500": _A})
        payload: dict = {}
        sel = SimpleNamespace(lid=f"A=1@L={_A}@", board_type="DEP")
        sse_handler._tag_stationboard(None, sel, _board([("j1", "134500")]), payload)
        assert payload["platforms"] == [_A]
        assert scheduled == []  # nothing unresolved -> no backfill

    def test_family_cache_miss_schedules_backfill(self, reset_steig, monkeypatch):
        scheduled = []
        monkeypatch.setattr(sse_handler, "_schedule_steig_backfill", lambda *a: scheduled.append(a))
        payload: dict = {}
        sel = SimpleNamespace(lid=f"A=1@L={_A}@", board_type="DEP")
        sse_handler._tag_stationboard(None, sel, _board([("j1", "134500")]), payload)
        assert payload["platforms"] == [None]  # fail-open until backfill lands
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
        assert steig._steig_cache[("j1", sd)][1] == {"134500": _A}
        assert not sse_handler._backfill_tasks  # done-callback cleared the ref
