"""
Busradar BW — per-departure Steig (platform) resolution for multi-platform
"Drehscheibe" stops.

Some stops split into two physical Bussteige that sit at (almost) the same
coordinate and appear as separate map markers, e.g. Walldorf-Drehscheibe
(Steig A extId 4466864, Steig B extId 4407123). The HAFAS StationBoard does
NOT separate them — both platform lids return a byte-identical board with
stbStop.locX == 0. Only the JourneyDetails of each individual journey carry
the real Steig (the Walldorf stop's own extId inside the journey's stopL).

The Steig is a property of a concrete departure, not a stable function of
(line, direction): a line may pass the stop twice in one trip at different
Steige, and night variants differ. So we resolve PER departure and never
generalise.

## Central config (config-as-code)

`STEIG_FAMILIES` is the single place to onboard a stop: one frozenset per
physical multi-platform stop, holding that stop's Steig extIds. Adding a stop
= add one frozenset after verifying its Steig extIds against HAFAS
JourneyDetails. There is deliberately NO runtime-loaded config file (no
external parser, no file permissions, no fail-open-on-parse-error surface):
the config is code, validated at import time and in the test-suite.

Load-time rules (enforced by `build_family_index`): each family has >= 2
extIds; every extId matches `[0-9]{1,12}`; every extId belongs to at most one
family (disjoint). On ANY violation the whole config is rejected and the
built-in known-good default is used instead — fail-closed, never an empty or
permissive set.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import Awaitable, Callable, Iterable
from typing import Any

LOG = logging.getLogger("busradar")

# extId validation shared with the wire-data guard: ASCII digits only (NOT
# \d — that matches Unicode digit categories) and length-bounded.
_EXTID_RE = re.compile(r"\A[0-9]{1,12}\Z")

# Known-good fallback (verified 2026-08-02 vs HAFAS JourneyDetails + EFA
# de:08226:4025 platform A/B): Walldorf-Drehscheibe Steig A / Steig B. Used
# when the editable STEIG_FAMILIES below fails validation, so the feature
# fails closed to a verified baseline instead of an empty/permissive set.
_BUILTIN_DEFAULT: tuple[frozenset[str], ...] = (frozenset({"4466864", "4407123"}),)

# --- Editable central config -------------------------------------------------
# One entry per physical multi-platform stop; each family = the stop's Steig
# extIds. Onboard a new stop by adding a frozenset here after verifying its
# Steig extIds against HAFAS JourneyDetails (see plan #222). Rules enforced at
# load: >= 2 extIds per family; extId matches [0-9]{1,12}; disjoint families.
#   - Walldorf-Drehscheibe (verified 2026-08-02): Steig A 4466864, Steig B 4407123.
STEIG_FAMILIES: tuple[frozenset[str], ...] = (frozenset({"4466864", "4407123"}),)


def _validate_and_index(families: Iterable[Iterable[str]]) -> dict[str, frozenset[str]]:
    """Build the reverse index extId -> family, raising ValueError on the
    first rule violation (< 2 members, malformed extId, non-disjoint)."""
    index: dict[str, frozenset[str]] = {}
    for members in families:
        fam = frozenset(members)
        if len(fam) < 2:
            raise ValueError(f"family with <2 extIds: {sorted(fam)}")
        for ext in fam:
            if not _EXTID_RE.match(ext):
                raise ValueError(f"invalid extId: {ext!r}")
            if ext in index:
                raise ValueError(f"extId listed in >1 family (not disjoint): {ext}")
            index[ext] = fam
    return index


def build_family_index(
    families: Iterable[Iterable[str]],
) -> tuple[dict[str, frozenset[str]], tuple[frozenset[str], ...]]:
    """Validate the family config and return (reverse_index, families_in_effect).

    On any validation error the config is rejected wholesale and the built-in
    known-good default is used instead (fail-closed). The built-in default is a
    trusted constant, so validating it never raises.
    """
    fams = tuple(frozenset(f) for f in families)
    try:
        index = _validate_and_index(fams)
        return index, fams
    except ValueError as e:
        LOG.warning("[steig] family config invalid (%s) -> fail-closed to built-in default", e)
        return _validate_and_index(_BUILTIN_DEFAULT), _BUILTIN_DEFAULT


_FAMILY_INDEX, _FAMILIES_IN_EFFECT = build_family_index(STEIG_FAMILIES)
# SEC-215: config-load is an audit-relevant event — record what is in effect.
LOG.info(
    "[steig] loaded %d platform families (%d extIds)",
    len(_FAMILIES_IN_EFFECT),
    len(_FAMILY_INDEX),
)


def family_for(ext_id: str) -> frozenset[str] | None:
    """Return the platform family containing ext_id, or None. O(1). Used by
    both the board-tagging gate ("is this a multi-Steig stop?") and the
    plausibility check ("is a resolved Steig in the opened stop's family?")."""
    return _FAMILY_INDEX.get(ext_id)


# --- Per-departure Steig resolution runtime ---------------------------------
#
# The board is re-pushed to each subscriber on every SSE tick (~10s). Tagging
# runs on every push from the cache; unknown jids are resolved by a background
# JourneyDetails backfill that populates the cache, so the NEXT tick's push
# carries the tags. The emit never waits on JourneyDetails ("second phase" is
# just the next tick), and the backfill uses its own small semaphore so it
# can't starve the live vehicle-poll path.

_STEIG_TTL_S = 6 * 3600.0
_STEIG_CAP = 2000
_DTIME_RE = re.compile(r"\A[0-9]{6,8}\Z")
_LID_EXTID_RE = re.compile(r"@L=([0-9]+)@")

# (jid, service_date) -> (mono_ts, {dep_time_key: steig_extId | None})
# A value of None for a time-key means "ambiguous" (two family stops of the
# same journey share that departure time with different Steige) -> tag null.
_steig_cache: dict[tuple[str, str], tuple[float, dict[str, str | None]]] = {}
_steig_lock = asyncio.Lock()
_steig_inflight: set[tuple[str, str]] = set()
# Separate from the live vehicle fetch (which is bounded only by the httpx
# pool). Caps the JD-backfill fanout so opening a Drehscheibe board can't
# saturate the pool and stall map updates for other subscribers.
_jd_sem = asyncio.Semaphore(2)

# Per-family cumulative health counters for /api/health (silent-break warning).
# {family_key: {"total": int, "resolved": int, "last_resolved_mono": float|None}}
_family_stats: dict[str, dict[str, Any]] = {}

# Injectable monotonic clock (tests monkeypatch steig._now for determinism).
_now: Callable[[], float] = time.monotonic


def _family_key(family: frozenset[str]) -> str:
    """Stable, JSON-safe key for a family (sorted extIds joined)."""
    return "+".join(sorted(family))


def extid_from_lid(lid: str) -> str | None:
    """Extract the numeric extId from a HAFAS lid's `@L=<digits>@` field, or
    None. Used to find the opened stop's Steig family from its selection lid."""
    m = _LID_EXTID_RE.search(lid or "")
    return m.group(1) if m else None


def dep_time_key(entry: dict[str, Any]) -> str | None:
    """Shared departure-time key for BOTH a board row's stbStop and a
    JourneyDetails stopL entry, so the two sides match. Prefer scheduled
    (dTimeS, stable across delay); fall back to real (dTimeR). Validated ASCII
    digits (6-8, HAFAS may encode past-midnight times), else None."""
    for k in ("dTimeS", "dTimeR"):
        v = entry.get(k)
        if isinstance(v, str) and _DTIME_RE.match(v):
            return v
    return None


def resolve_family_stops(jd_res: dict[str, Any]) -> dict[str, str | None]:
    """From a JourneyDetails result, map each family-stop departure-time-key to
    its Steig extId, for stops in ANY configured family (one JD call serves all
    families a journey touches). Collision (two family stops, same time-key,
    different Steig) -> None (ambiguous). Non-family stops are ignored."""
    journey = jd_res.get("journey") or {}
    stop_l = journey.get("stopL") or []
    loc_l = (jd_res.get("common") or {}).get("locL") or []
    out: dict[str, str | None] = {}
    for s in stop_l:
        li = s.get("locX")
        if not isinstance(li, int) or li < 0 or li >= len(loc_l):
            continue
        ext = loc_l[li].get("extId")
        if not isinstance(ext, str) or family_for(ext) is None:
            continue
        key = dep_time_key(s)
        if key is None:
            continue
        if key in out:
            if out[key] != ext:  # different Steig at same time -> ambiguous
                out[key] = None
        else:
            out[key] = ext
    return out


def _cache_get(key: tuple[str, str]) -> dict[str, str | None] | None:
    v = _steig_cache.get(key)
    if v is None:
        return None
    ts, data = v
    if _now() - ts >= _STEIG_TTL_S:
        return None  # expired (lazy read; the sweep removes it on next write)
    return data


def tag_board(
    board_res: dict[str, Any], opened_ext_id: str, service_date: str
) -> tuple[list[str | None], list[str]]:
    """Compute per-row `platformExtId` tags for a DEP board of a Steig-family
    stop. Returns (platforms, unresolved_jids):
      - platforms: aligned to board jnyL; a Steig extId (in the opened stop's
        family) or None (fail-open -> client shows the row on both Steige).
      - unresolved_jids: jids with no cache entry yet -> caller schedules a
        background backfill; those rows stay None until the next tick.
    No-op (empty platforms) if the opened stop is not a family member."""
    family = family_for(opened_ext_id)
    jny_l = board_res.get("jnyL") or []
    if family is None:
        return [], []
    platforms: list[str | None] = []
    unresolved: list[str] = []
    resolved = 0
    for j in jny_l:
        jid = j.get("jid")
        tkey = dep_time_key(j.get("stbStop") or {})
        tag: str | None = None
        if isinstance(jid, str) and jid:
            data = _cache_get((jid, service_date))
            if data is None:
                unresolved.append(jid)
            elif tkey is not None:
                steig = data.get(tkey)
                # Plausibility + SEC-100 guard in one: only emit a Steig that
                # is in THIS stop's family. Family members are all validated
                # numeric extIds (checked at config load), so membership alone
                # guarantees the emitted value is a clean extId — no separate
                # regex needed. A None (ambiguous) or out-of-family value fails
                # closed to None (row shown on both Steige).
                if steig and steig in family:
                    tag = steig
                    resolved += 1
        platforms.append(tag)
    st = _family_stats.setdefault(
        _family_key(family), {"total": 0, "resolved": 0, "last_resolved_mono": None}
    )
    st["total"] += len(jny_l)
    st["resolved"] += resolved
    if resolved:
        st["last_resolved_mono"] = _now()
    return platforms, unresolved


def _sweep_and_cap() -> None:
    """Evict expired entries and, if still over the cap, the oldest ones.
    Called under _steig_lock on every write."""
    now = _now()
    for k in [k for k, (ts, _) in _steig_cache.items() if now - ts >= _STEIG_TTL_S]:
        _steig_cache.pop(k, None)
    if len(_steig_cache) > _STEIG_CAP:
        oldest = sorted(_steig_cache, key=lambda k: _steig_cache[k][0])[
            : len(_steig_cache) - _STEIG_CAP
        ]
        for k in oldest:
            _steig_cache.pop(k, None)


async def _resolve_one(
    jid: str, service_date: str, fetch_jd: Callable[[str], Awaitable[dict[str, Any]]]
) -> None:
    key = (jid, service_date)
    try:
        async with _jd_sem:
            res = await fetch_jd(jid)
        # fetch_jd already normalises upstream + per-service errors to
        # {"error": ...}; a bad/empty result leaves the jid unresolved
        # (rows stay fail-open on both Steige) rather than caching a guess.
        if not isinstance(res, dict) or "error" in res:
            return
        mapping = resolve_family_stops(res)
        async with _steig_lock:
            _steig_cache[key] = (_now(), mapping)
            _sweep_and_cap()
    finally:
        _steig_inflight.discard(key)


async def backfill(
    unresolved: Iterable[str],
    service_date: str,
    fetch_jd: Callable[[str], Awaitable[dict[str, Any]]],
) -> None:
    """Resolve unknown jids' Steige via JourneyDetails and populate the cache.
    Scheduled as a background task by the SSE board path; never blocks the emit.
    Singleflight per (jid, service_date) so concurrent board opens share work."""
    tasks = []
    for jid in dict.fromkeys(unresolved):  # dedupe, preserve order
        key = (jid, service_date)
        if key in _steig_inflight:
            continue
        _steig_inflight.add(key)
        tasks.append(_resolve_one(jid, service_date, fetch_jd))
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


def health_snapshot() -> dict[str, Any]:
    """Per-family resolution stats for /api/health (silent HAFAS-GID-break
    early warning). A family that stays at resolved==0 while total grows, or
    whose last_resolved age keeps climbing, signals the Steig field broke."""
    now = _now()
    out: dict[str, Any] = {}
    for fam, st in _family_stats.items():
        last = st["last_resolved_mono"]
        out[fam] = {
            "total": st["total"],
            "resolved": st["resolved"],
            "last_resolved_age_s": (round(now - last, 1) if last is not None else None),
        }
    return out
