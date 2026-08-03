"""Tests for steig.py — Steig-family config validation, reverse index,
fail-closed fallback, and family_for lookup."""

from __future__ import annotations

import pytest

import steig
from steig import (
    _BUILTIN_DEFAULT,
    _validate_and_index,
    build_family_index,
    dep_time_key,
    extid_from_lid,
    family_for,
    resolve_family_stops,
    tag_board,
)


@pytest.fixture
def reset_steig(monkeypatch):
    """Clean runtime state + a deterministic monotonic clock for each test."""
    steig._steig_cache.clear()
    steig._steig_inflight.clear()
    steig._family_stats.clear()
    clock = {"t": 1000.0}
    monkeypatch.setattr(steig, "_now", lambda: clock["t"])
    yield clock
    steig._steig_cache.clear()
    steig._steig_inflight.clear()
    steig._family_stats.clear()


# Walldorf family extIds used throughout the runtime tests.
_A = "4466864"
_B = "4407123"


def _board(rows):
    """Minimal HAFAS StationBoard res: rows = list of (jid, dTimeS)."""
    return {"jnyL": [{"jid": jid, "stbStop": {"dTimeS": dts}} for jid, dts in rows]}


def _jd(stops):
    """Minimal JourneyDetails res: stops = list of (extId, dTimeS)."""
    loc_l = []
    stop_l = []
    for ext, dts in stops:
        stop_l.append({"locX": len(loc_l), "dTimeS": dts})
        loc_l.append({"extId": ext})
    return {"common": {"locL": loc_l}, "journey": {"stopL": stop_l}}


class TestValidateAndIndex:
    def test_valid_config_builds_reverse_index(self):
        idx = _validate_and_index([{"100", "200"}, {"300", "400", "500"}])
        assert idx["100"] == frozenset({"100", "200"})
        assert idx["500"] == frozenset({"300", "400", "500"})
        assert len(idx) == 5

    def test_family_with_one_member_raises(self):
        with pytest.raises(ValueError, match="<2 extIds"):
            _validate_and_index([{"100"}])

    def test_empty_family_raises(self):
        with pytest.raises(ValueError, match="<2 extIds"):
            _validate_and_index([set()])

    def test_non_numeric_extid_raises(self):
        with pytest.raises(ValueError, match="invalid extId"):
            _validate_and_index([{"100", "12a"}])

    def test_unicode_digit_extid_raises(self):
        # Fullwidth digits must be rejected (ASCII-only guard).
        with pytest.raises(ValueError, match="invalid extId"):
            _validate_and_index([{"100", "１２"}])

    def test_overlong_extid_raises(self):
        with pytest.raises(ValueError, match="invalid extId"):
            _validate_and_index([{"100", "1234567890123"}])

    def test_non_disjoint_families_raise(self):
        with pytest.raises(ValueError, match="not disjoint"):
            _validate_and_index([{"100", "200"}, {"200", "300"}])


class TestBuildFamilyIndex:
    def test_valid_config_returned_as_is(self):
        idx, fams = build_family_index([{"100", "200"}])
        assert idx["100"] == frozenset({"100", "200"})
        assert fams == (frozenset({"100", "200"}),)

    def test_invalid_config_falls_back_to_builtin(self, caplog):
        # A non-disjoint config is rejected wholesale → built-in default.
        with caplog.at_level("WARNING"):
            idx, fams = build_family_index([{"100", "200"}, {"200", "300"}])
        assert fams == _BUILTIN_DEFAULT
        assert idx["4466864"] == frozenset({"4466864", "4407123"})
        assert "fail-closed to built-in default" in caplog.text

    def test_builtin_default_itself_is_valid(self):
        # The fallback must never itself fail validation.
        idx = _validate_and_index(_BUILTIN_DEFAULT)
        assert idx["4407123"] == frozenset({"4466864", "4407123"})


class TestFamilyFor:
    def test_walldorf_steige_resolve_to_same_family(self):
        fam_a = family_for("4466864")
        fam_b = family_for("4407123")
        assert fam_a is not None
        assert fam_a == fam_b == frozenset({"4466864", "4407123"})

    def test_unknown_extid_returns_none(self):
        assert family_for("9999999") is None

    def test_families_accessor_returns_config(self):
        assert steig.families() == (frozenset({"4466864", "4407123"}),)

    def test_module_loaded_walldorf_family(self):
        assert (frozenset({"4466864", "4407123"}),) == steig._FAMILIES_IN_EFFECT
        assert len(steig._FAMILY_INDEX) == 2


class TestExtidFromLid:
    def test_simple_synthesized_lid(self):
        assert extid_from_lid("A=1@L=4466864@") == "4466864"

    def test_fully_qualified_lid(self):
        lid = "A=1@O=Walldorf@X=8@Y=49@U=80@L=4407123@i=A×de:1:2:3:B,b×BRN_1@"
        assert extid_from_lid(lid) == "4407123"

    def test_no_l_field_returns_none(self):
        assert extid_from_lid("A=1@O=foo@") is None

    def test_empty_string(self):
        assert extid_from_lid("") is None


class TestDepTimeKey:
    def test_prefers_scheduled(self):
        assert dep_time_key({"dTimeS": "134500", "dTimeR": "134800"}) == "134500"

    def test_falls_back_to_real(self):
        assert dep_time_key({"dTimeR": "134800"}) == "134800"

    def test_past_midnight_seven_digits(self):
        assert dep_time_key({"dTimeS": "1250000"}) == "1250000"

    def test_missing_both_returns_none(self):
        assert dep_time_key({}) is None

    def test_non_digit_rejected(self):
        assert dep_time_key({"dTimeS": "13:45", "dTimeR": "abc"}) is None

    def test_invalid_scheduled_falls_back_to_valid_real(self):
        # dTimeS present but malformed -> loop continues to the valid dTimeR.
        assert dep_time_key({"dTimeS": "13:45", "dTimeR": "134800"}) == "134800"


class TestResolveFamilyStops:
    def test_maps_family_stop_to_steig(self):
        mapping = resolve_family_stops(_jd([("999", "120000"), (_A, "134500")]))
        assert mapping == {"134500": _A}

    def test_ignores_non_family_stops(self):
        # 999 is not in any family -> not recorded.
        assert resolve_family_stops(_jd([("999", "120000")])) == {}

    def test_bad_locx_skipped(self):
        jd = {
            "common": {"locL": [{"extId": _A}]},
            "journey": {"stopL": [{"locX": 5, "dTimeS": "1"}]},
        }
        assert resolve_family_stops(jd) == {}

    def test_locx_not_int_skipped(self):
        jd = {
            "common": {"locL": [{"extId": _A}]},
            "journey": {"stopL": [{"locX": None, "dTimeS": "134500"}]},
        }
        assert resolve_family_stops(jd) == {}

    def test_ext_not_str_skipped(self):
        jd = {
            "common": {"locL": [{"extId": 123}]},
            "journey": {"stopL": [{"locX": 0, "dTimeS": "134500"}]},
        }
        assert resolve_family_stops(jd) == {}

    def test_missing_time_key_skipped(self):
        assert resolve_family_stops(_jd([(_A, None)])) == {}

    def test_double_pass_different_steig_same_time_is_ambiguous(self):
        # Same journey hits A and B at the same dTimeS -> ambiguous -> None.
        assert resolve_family_stops(_jd([(_A, "134500"), (_B, "134500")])) == {"134500": None}

    def test_double_pass_same_steig_same_time_kept(self):
        assert resolve_family_stops(_jd([(_A, "134500"), (_A, "134500")])) == {"134500": _A}

    def test_double_pass_two_times_two_steige(self):
        mapping = resolve_family_stops(_jd([(_A, "134500"), (_B, "150000")]))
        assert mapping == {"134500": _A, "150000": _B}


class TestTagBoard:
    def test_non_family_stop_is_noop(self, reset_steig):
        platforms, unresolved = tag_board(_board([("j1", "134500")]), "999", "20260802")
        assert platforms == []
        assert unresolved == []

    def test_cache_miss_marks_unresolved(self, reset_steig):
        platforms, unresolved = tag_board(_board([("j1", "134500")]), _A, "20260802")
        assert platforms == [None]
        assert unresolved == ["j1"]

    def test_cache_hit_tags_matching_row(self, reset_steig):
        steig._steig_cache[("j1", "20260802")] = (1000.0, {"134500": _A})
        platforms, unresolved = tag_board(_board([("j1", "134500")]), _A, "20260802")
        assert platforms == [_A]
        assert unresolved == []
        st = steig._family_stats[steig._family_key(family_for(_A))]
        assert st == {"total": 1, "resolved": 1, "last_resolved_mono": 1000.0}

    def test_steig_out_of_family_fails_closed(self, reset_steig):
        # 999 is not in the opened stop's family -> None (fail-open both).
        steig._steig_cache[("j1", "20260802")] = (1000.0, {"134500": "999"})
        platforms, _ = tag_board(_board([("j1", "134500")]), _A, "20260802")
        assert platforms == [None]

    def test_ambiguous_steig_none_tagged_null(self, reset_steig):
        steig._steig_cache[("j1", "20260802")] = (1000.0, {"134500": None})
        platforms, _ = tag_board(_board([("j1", "134500")]), _A, "20260802")
        assert platforms == [None]

    def test_board_row_time_not_in_journey(self, reset_steig):
        # Journey resolved but this row's time isn't a family-stop time.
        steig._steig_cache[("j1", "20260802")] = (1000.0, {"150000": _A})
        platforms, unresolved = tag_board(_board([("j1", "134500")]), _A, "20260802")
        assert platforms == [None]
        assert unresolved == []

    def test_row_missing_time_key_null(self, reset_steig):
        steig._steig_cache[("j1", "20260802")] = (1000.0, {"134500": _A})
        board = {"jnyL": [{"jid": "j1", "stbStop": {}}]}
        platforms, _ = tag_board(board, _A, "20260802")
        assert platforms == [None]

    def test_row_missing_jid_null_not_unresolved(self, reset_steig):
        board = {"jnyL": [{"stbStop": {"dTimeS": "134500"}}]}
        platforms, unresolved = tag_board(board, _A, "20260802")
        assert platforms == [None]
        assert unresolved == []

    def test_stats_no_resolution_leaves_last_none(self, reset_steig):
        tag_board(_board([("j1", "134500")]), _A, "20260802")
        st = steig._family_stats[steig._family_key(family_for(_A))]
        assert st == {"total": 1, "resolved": 0, "last_resolved_mono": None}

    def test_cache_expired_treated_as_miss(self, reset_steig):
        steig._steig_cache[("j1", "20260802")] = (1000.0, {"134500": _A})
        reset_steig["t"] = 1000.0 + steig._STEIG_TTL_S + 1
        platforms, unresolved = tag_board(_board([("j1", "134500")]), _A, "20260802")
        assert platforms == [None]
        assert unresolved == ["j1"]

    def test_double_pass_two_rows_two_steige(self, reset_steig):
        # Flagship case: one journey (jid) lists the stop twice at different
        # dTimeS on different Steige -> two board rows -> [A, B] by time-match.
        steig._steig_cache[("j1", "20260802")] = (1000.0, {"134500": _A, "150000": _B})
        board = _board([("j1", "134500"), ("j1", "150000")])
        platforms, unresolved = tag_board(board, _A, "20260802")
        assert platforms == [_A, _B]
        assert unresolved == []

    def test_mixed_resolved_and_unresolved_alignment(self, reset_steig):
        # Parallel-array alignment: j1 cached -> A, j2 missing -> None + unresolved.
        steig._steig_cache[("j1", "20260802")] = (1000.0, {"134500": _A})
        board = _board([("j1", "134500"), ("j2", "150000")])
        platforms, unresolved = tag_board(board, _A, "20260802")
        assert platforms == [_A, None]
        assert unresolved == ["j2"]
        st = steig._family_stats[steig._family_key(family_for(_A))]
        assert st["total"] == 2
        assert st["resolved"] == 1


class TestSweepAndCap:
    def test_expired_swept(self, reset_steig):
        steig._steig_cache[("old", "d")] = (1000.0, {})
        reset_steig["t"] = 1000.0 + steig._STEIG_TTL_S + 1
        steig._sweep_and_cap()
        assert ("old", "d") not in steig._steig_cache

    def test_over_cap_oldest_removed(self, reset_steig, monkeypatch):
        monkeypatch.setattr(steig, "_STEIG_CAP", 2)
        for i in range(4):
            steig._steig_cache[(f"j{i}", "d")] = (1000.0 + i, {})
        steig._sweep_and_cap()
        assert len(steig._steig_cache) == 2
        assert ("j0", "d") not in steig._steig_cache
        assert ("j3", "d") in steig._steig_cache

    def test_under_cap_no_removal(self, reset_steig):
        steig._steig_cache[("j0", "d")] = (1000.0, {})
        steig._sweep_and_cap()
        assert ("j0", "d") in steig._steig_cache

    def test_combined_expiry_then_cap(self, reset_steig, monkeypatch):
        monkeypatch.setattr(steig, "_STEIG_CAP", 1)
        steig._steig_cache[("old", "d")] = (1000.0, {})  # will expire
        steig._steig_cache[("a", "d")] = (2000.0, {})
        steig._steig_cache[("b", "d")] = (2001.0, {})
        reset_steig["t"] = 1000.0 + steig._STEIG_TTL_S + 1  # 'old' expired; a,b fresh
        steig._sweep_and_cap()
        assert ("old", "d") not in steig._steig_cache  # removed by expiry
        assert len(steig._steig_cache) == 1  # then capped
        assert ("b", "d") in steig._steig_cache  # newest survives the cap

    def test_exact_ttl_boundary_is_expired(self, reset_steig):
        steig._steig_cache[("j", "d")] = (1000.0, {})
        reset_steig["t"] = 1000.0 + steig._STEIG_TTL_S  # == TTL -> >= -> expired
        steig._sweep_and_cap()
        assert ("j", "d") not in steig._steig_cache


class TestBackfill:
    async def test_populates_cache_from_journeydetails(self, reset_steig):
        async def fetch_jd(jid):
            return _jd([(_A, "134500")])

        await steig.backfill(["j1"], "20260802", fetch_jd)
        assert steig._steig_cache[("j1", "20260802")][1] == {"134500": _A}
        assert ("j1", "20260802") not in steig._steig_inflight

    async def test_error_result_not_cached(self, reset_steig):
        async def fetch_jd(jid):
            return {"error": "upstream"}

        await steig.backfill(["j1"], "20260802", fetch_jd)
        assert ("j1", "20260802") not in steig._steig_cache
        assert ("j1", "20260802") not in steig._steig_inflight

    async def test_non_dict_result_not_cached(self, reset_steig):
        async def fetch_jd(jid):
            return None

        await steig.backfill(["j1"], "20260802", fetch_jd)
        assert ("j1", "20260802") not in steig._steig_cache

    async def test_exception_discards_inflight(self, reset_steig):
        async def fetch_jd(jid):
            raise RuntimeError("boom")

        await steig.backfill(["j1"], "20260802", fetch_jd)
        assert ("j1", "20260802") not in steig._steig_cache
        assert ("j1", "20260802") not in steig._steig_inflight

    async def test_dedupes_and_skips_inflight(self, reset_steig):
        calls = []

        async def fetch_jd(jid):
            calls.append(jid)
            return _jd([(_A, "134500")])

        steig._steig_inflight.add(("j2", "20260802"))  # pretend already resolving
        await steig.backfill(["j1", "j1", "j2"], "20260802", fetch_jd)
        assert calls == ["j1"]  # j1 once (dedupe), j2 skipped (inflight)

    async def test_empty_unresolved_no_op(self, reset_steig):
        async def fetch_jd(jid):  # pragma: no cover - must not be called
            raise AssertionError("should not fetch")

        await steig.backfill([], "20260802", fetch_jd)
        assert steig._steig_cache == {}


class TestHealthSnapshot:
    def test_empty(self, reset_steig):
        assert steig.health_snapshot() == {}

    def test_reports_rate_and_age(self, reset_steig):
        steig._steig_cache[("j1", "20260802")] = (1000.0, {"134500": _A})
        tag_board(_board([("j1", "134500")]), _A, "20260802")  # resolved=1, last=1000
        reset_steig["t"] = 1005.0
        snap = steig.health_snapshot()
        key = steig._family_key(family_for(_A))
        assert snap[key]["total"] == 1
        assert snap[key]["resolved"] == 1
        assert snap[key]["last_resolved_age_s"] == 5.0

    def test_age_none_when_never_resolved(self, reset_steig):
        tag_board(_board([("j1", "134500")]), _A, "20260802")  # resolved=0
        snap = steig.health_snapshot()
        key = steig._family_key(family_for(_A))
        assert snap[key]["last_resolved_age_s"] is None
