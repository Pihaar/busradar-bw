"""
Busradar BW — Stops Cache Builder

Builds the complete stops cache by querying HAFAS LocGeoPos on a grid
and discovering all platforms via StationBoard (dur=1440).
Runs once at startup (if cache is stale) and daily at 3:00.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import time
from datetime import datetime
from pathlib import Path

import httpx

HAFAS_ENDPOINT = "https://db-regio.hafas.de/bin/mgate.exe"
AUTH_AID = "FiBa5ytjCvR0J47P"
CLIENT_ID = "DB-REGIO"
CLIENT_VERSION = "3000000"
CLIENT_NAME = "DB Busradar BW"
EXT = "DB.REGIO.1"
VER = "1.39"

CACHE_FILE = Path(os.environ.get("BUSRADAR_STATE_DIR", str(Path(__file__).parent))) / "stops_cache.json"
HAFAS_CONCURRENCY = 5

# Coverage area derived from actual bus positions (JourneyGeoPos maxDist=200km)
# Bounding box: Lat 47.54-49.62, Lon 7.58-10.07
# Grid with 5km steps covers this efficiently
GRID_LAT_MIN = 47.50
GRID_LAT_MAX = 49.65
GRID_LON_MIN = 7.55
GRID_LON_MAX = 10.10
GRID_STEP_KM = 5

LOG = logging.getLogger("stops_builder")


def _build_envelope(method: str, req: dict) -> dict:
    return {
        "auth": {"type": "AID", "aid": AUTH_AID},
        "client": {"type": "AND", "id": CLIENT_ID, "v": CLIENT_VERSION, "name": CLIENT_NAME},
        "ext": EXT,
        "ver": VER,
        "lang": "de",
        "svcReqL": [{"meth": method, "req": req}],
    }


async def _hafas_call(client: httpx.AsyncClient, method: str, req: dict) -> dict | None:
    payload = _build_envelope(method, req)
    try:
        resp = await client.post(HAFAS_ENDPOINT, json=payload)
        resp.raise_for_status()
        data = resp.json()
        if data.get("err") != "OK":
            return None
        svc = data.get("svcResL", [{}])[0]
        if svc.get("err") != "OK":
            return None
        return svc.get("res", {})
    except Exception as e:
        LOG.warning("HAFAS call failed: %s", e)
        return None


async def _fetch_stops_in_radius(client: httpx.AsyncClient, lat: float, lon: float, radius: int) -> list[dict]:
    req = {
        "ring": {
            "cCrd": {"x": round(lon * 1_000_000), "y": round(lat * 1_000_000)},
            "maxDist": radius,
        },
        "getPOIs": False,
        "getStops": True,
    }
    res = await _hafas_call(client, "LocGeoPos", req)
    if not res:
        return []
    return res.get("locL", [])


async def _discover_platforms(client: httpx.AsyncClient, lid: str) -> list[dict]:
    platforms = []
    seen = set()

    for board_type in ("DEP", "ARR"):
        req = {
            "stbLoc": {"lid": lid},
            "type": board_type,
            "dur": 1440,
            "jnyFltrL": [{"type": "PROD", "mode": "INC", "value": "32"}],
        }
        res = await _hafas_call(client, "StationBoard", req)
        if not res:
            continue

        loc_l = res.get("common", {}).get("locL", [])
        jny_l = res.get("jnyL", [])

        used_indices = set()
        for jny in jny_l:
            stb = jny.get("stbStop", {})
            if "locX" in stb:
                used_indices.add(stb["locX"])

        for idx in used_indices:
            if idx < 0 or idx >= len(loc_l):
                continue
            loc = loc_l[idx]
            ext_id = loc.get("extId", "")
            if ext_id in seen:
                continue
            seen.add(ext_id)

            crd = loc.get("crd", {})
            if crd.get("x", 0) == 0 or crd.get("y", 0) == 0:
                continue

            gid_l = loc.get("gidL", [])
            has_physical = any(g.startswith("b×") for g in gid_l)
            if not has_physical:
                continue

            platform = ""
            for gid in gid_l:
                if gid.startswith("A×"):
                    parts = gid.split(":")
                    if len(parts) >= 5 and parts[4]:
                        platform = parts[4]
                    break

            platforms.append({
                "name": loc.get("name", "?"),
                "lid": loc.get("lid", ""),
                "lat": crd.get("y", 0) / 1_000_000,
                "lon": crd.get("x", 0) / 1_000_000,
                "extId": ext_id,
                "platform": platform,
            })

    return platforms


def _dist_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    dlat = (lat2 - lat1) * 111000
    dlon = (lon2 - lon1) * 111000 * math.cos(math.radians(lat1))
    return math.sqrt(dlat * dlat + dlon * dlon)


def _parse_stop(loc: dict) -> dict | None:
    crd = loc.get("crd", {})
    if crd.get("x", 0) == 0 or crd.get("y", 0) == 0:
        return None
    gid_l = loc.get("gidL", [])
    has_physical = any(g.startswith("b×") for g in gid_l)
    if not has_physical:
        return None
    platform = ""
    for gid in gid_l:
        if gid.startswith("A×"):
            parts = gid.split(":")
            if len(parts) >= 5 and parts[4]:
                platform = parts[4]
            break
    return {
        "name": loc.get("name", "?"),
        "lid": loc.get("lid", ""),
        "lat": crd.get("y", 0) / 1_000_000,
        "lon": crd.get("x", 0) / 1_000_000,
        "extId": loc.get("extId", ""),
        "platform": platform,
    }


async def build_stops_cache():
    LOG.info("Building stops cache (concurrency=%d)...", HAFAS_CONCURRENCY)
    start = time.time()

    async with httpx.AsyncClient(
        timeout=30.0,
        limits=httpx.Limits(max_connections=HAFAS_CONCURRENCY, max_keepalive_connections=HAFAS_CONCURRENCY),
        headers={"Content-Type": "application/json", "User-Agent": "BusradarBW-StopsBuilder/1.0"},
    ) as client:

        sem = asyncio.Semaphore(HAFAS_CONCURRENCY)

        async def _bounded(coro):
            async with sem:
                return await coro

        all_stops = {}

        # --- Stage 1: Grid scan ---
        step_deg = GRID_STEP_KM / 111.0
        grid_points = []
        lat = GRID_LAT_MIN
        while lat <= GRID_LAT_MAX:
            lon = GRID_LON_MIN
            while lon <= GRID_LON_MAX:
                grid_points.append((lat, lon))
                lon += step_deg
            lat += step_deg

        results = await asyncio.gather(
            *[_bounded(_fetch_stops_in_radius(client, la, lo, int(GRID_STEP_KM * 1000))) for la, lo in grid_points],
            return_exceptions=True,
        )
        errors1 = 0
        for r in results:
            if isinstance(r, Exception):
                errors1 += 1
                continue
            for loc in r:
                stop = _parse_stop(loc)
                if stop and stop["extId"] not in all_stops:
                    all_stops[stop["extId"]] = stop

        LOG.info("Grid: %d stops, %d errors from %d calls in %.0fs",
                 len(all_stops), errors1, len(grid_points), time.time() - start)

        # --- Stage 2: Platform discovery ---
        discover_stops = list(all_stops.values())
        done = [0]

        async def _platforms_task(stop):
            sub_stops = await _bounded(_discover_platforms(client, stop["lid"]))
            for sub in sub_stops:
                if sub["extId"] not in all_stops:
                    all_stops[sub["extId"]] = sub
            done[0] += 1  # safe: single-threaded asyncio, no await between check and assign
            if done[0] % 500 == 0:
                LOG.info("  Platforms: %d/%d", done[0], len(discover_stops))
            return None

        results2 = await asyncio.gather(
            *[_platforms_task(s) for s in discover_stops],
            return_exceptions=True,
        )
        errors2 = sum(1 for r in results2 if isinstance(r, Exception))
        LOG.info("Platforms done: %d processed, %d errors in %.0fs",
                 len(discover_stops), errors2, time.time() - start)

        # --- Stage 3: Redundancy filter ---
        redundant = await _find_redundant_stops_parallel(client, sem, all_stops)
        for ext_id in redundant:
            del all_stops[ext_id]
        LOG.info("Removed %d redundant collection stops", len(redundant))

        # --- Error threshold check ---
        total_calls = len(grid_points) + len(discover_stops)
        total_errors = errors1 + errors2
        if total_calls > 0 and total_errors / total_calls > 0.10:
            LOG.error("Build aborted: %.1f%% error rate (%d/%d). Cache NOT written.",
                      total_errors / total_calls * 100, total_errors, total_calls)
            return None

        final_stops = list(all_stops.values())

        cache_data = {
            "stops": final_stops,
            "count": len(final_stops),
            "built_at": datetime.now().isoformat(),
            "build_time_sec": round(time.time() - start, 1),
        }

        CACHE_FILE.with_suffix('.tmp').write_text(
            json.dumps(cache_data, ensure_ascii=False), encoding="utf-8"
        )
        CACHE_FILE.with_suffix('.tmp').rename(CACHE_FILE)
        LOG.info("Stops cache built: %d stops in %.1fs, saved to %s",
                 len(final_stops), time.time() - start, CACHE_FILE)

    return cache_data


async def _find_redundant_stops_parallel(client, sem, all_stops):
    """Parallel version of redundancy check."""
    stops_list = list(all_stops.values())
    platform_stops = [s for s in stops_list if s["platform"]]
    no_platform = [s for s in stops_list if not s["platform"]]

    candidates = []
    for s in no_platform:
        nearby_plats = []
        for p in platform_stops:
            if _dist_m(s["lat"], s["lon"], p["lat"], p["lon"]) > 300:
                continue
            if s["name"] in p["name"] or p["name"].split(" (")[0] in s["name"] or p["name"] in s["name"]:
                nearby_plats.append(p)
        if nearby_plats:
            candidates.append((s, nearby_plats))

    LOG.info("Checking %d redundant stop candidates...", len(candidates))
    redundant = set()

    async def _check_redundant(s, plats):
        async with sem:
            lid = f"A=1@L={s['extId']}@"
            req = {
                "stbLoc": {"lid": lid},
                "type": "DEP",
                "dur": 1440,
                "jnyFltrL": [{"type": "PROD", "mode": "INC", "value": "32"}],
            }
            res = await _hafas_call(client, "StationBoard", req)
            if not res:
                return None

            jny_l = res.get("jnyL", [])
            loc_l = res.get("common", {}).get("locL", [])
            prod_l = res.get("common", {}).get("prodL", [])
            plat_ext_ids = {p["extId"] for p in plats}

            own_lines = set()
            plat_lines = set()
            for jny in jny_l:
                stb = jny.get("stbStop", {})
                loc_idx = stb.get("locX", -1)
                dep_ext = ""
                if 0 <= loc_idx < len(loc_l):
                    dep_ext = loc_l[loc_idx].get("extId", "")
                prod = prod_l[jny.get("prodX", 0)] if 0 <= jny.get("prodX", 0) < len(prod_l) else {}
                line = prod.get("nameS", prod.get("name", ""))
                if dep_ext == s["extId"]:
                    own_lines.add(line)
                elif dep_ext in plat_ext_ids:
                    plat_lines.add(line)

            if not (own_lines - plat_lines):
                redundant.add(s["extId"])
            return None

    await asyncio.gather(
        *[_check_redundant(s, plats) for s, plats in candidates],
        return_exceptions=True,
    )
    return redundant


def load_stops_cache() -> dict | None:
    """Load whatever stops cache exists. The "stale after 3am" cutoff that
    used to live here forced a synchronous-feeling startup rebuild every
    time the server restarted after 3am — which fans out hundreds of
    queued HAFAS coroutines through `build_stops_cache` and starves the
    event loop for several seconds, making /api/health and the SSE
    handshake time out. Serving yesterday's stops while the background
    refresh runs is strictly better than serving nothing; the daily 3am
    scheduler still keeps the file genuinely fresh on long-running
    deploys. Callers that want to know whether a refresh is due call
    is_stops_cache_stale(cached) on the SAME dict so the read-twice
    TOCTOU window between load + staleness check disappears."""
    if not CACHE_FILE.exists():
        return None
    try:
        return json.loads(CACHE_FILE.read_text(encoding="utf-8"))
    except Exception as e:
        LOG.warning("stops_cache.json unreadable, treating as missing: %s", e)
        return None


def is_stops_cache_stale(cached: dict | None = None) -> bool:
    """True iff the cache was built before the most recent 3am tick (or is
    missing entirely). Pass the dict returned by load_stops_cache() to
    avoid a second file read (and the TOCTOU window where the daily
    rebuild could swap the file between the two reads)."""
    if cached is None:
        if not CACHE_FILE.exists():
            return True
        try:
            cached = json.loads(CACHE_FILE.read_text(encoding="utf-8"))
        except Exception:
            return True
    try:
        built_at = datetime.fromisoformat(cached.get("built_at", "2000-01-01"))
        now = datetime.now()
        reset_today = now.replace(hour=3, minute=0, second=0, microsecond=0)
        return now >= reset_today and built_at < reset_today
    except Exception:
        return True


async def schedule_daily_rebuild():
    while True:
        now = datetime.now()
        next_run = now.replace(hour=3, minute=0, second=0, microsecond=0)
        if now >= next_run:
            from datetime import timedelta
            next_run += timedelta(days=1)
        wait_seconds = (next_run - now).total_seconds()
        LOG.info("Next stops cache rebuild at %s (in %.0f min)", next_run.strftime("%H:%M"), wait_seconds / 60)
        await asyncio.sleep(wait_seconds)
        try:
            await build_stops_cache()
        except Exception as e:
            LOG.error("Stops cache rebuild failed: %s", e)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    asyncio.run(build_stops_cache())
