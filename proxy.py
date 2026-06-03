"""
Busradar BW — FastAPI Backend Proxy

Proxies requests to the HAFAS mgate.exe API, adding input validation,
rate limiting, caching, and security headers.
"""

from __future__ import annotations

import asyncio
import logging
import math
import os
import random
import re
import time
from contextlib import asynccontextmanager
from enum import Enum

import httpx
from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from pydantic import BaseModel, Field, field_validator

from tick import (
    TickTracker, ClientActivity, inject_tick_hints, tick_calibrator,
    _TICK_ENABLED, TICK_MAX_AGE,
)

HAFAS_ENDPOINT = "https://db-regio.hafas.de/bin/mgate.exe"
AUTH_AID = "FiBa5ytjCvR0J47P"
CLIENT_ID = "DB-REGIO"
CLIENT_VERSION = "3000000"
CLIENT_NAME = "DB Busradar BW"
EXT = "DB.REGIO.1"
VER = "1.39"

CACHE_TTL = 9.5
STOPS_CACHE_TTL = 86400.0
UPSTREAM_TIMEOUT = 10.0
MAX_CONSECUTIVE_FAILURES = 3
CIRCUIT_BREAKER_COOLDOWN = 30.0

logging.basicConfig(
    format='{"time":"%(asctime)s","level":"%(levelname)s","tag":"%(name)s","msg":"%(message)s"}',
    level=logging.INFO,
)
log = logging.getLogger("busradar")


def _build_hafas_envelope(method: str, req: dict) -> dict:
    return {
        "auth": {"type": "AID", "aid": AUTH_AID},
        "client": {"type": "AND", "id": CLIENT_ID, "v": CLIENT_VERSION, "name": CLIENT_NAME},
        "ext": EXT,
        "ver": VER,
        "lang": "de",
        "svcReqL": [{"meth": method, "req": req}],
    }


class _Cache:
    def __init__(self, ttl: float = CACHE_TTL, daily_reset_hour: int | None = None):
        self._data: dict | None = None
        self._key: tuple | None = None
        self._ts: float = 0
        self._mono_ts: float = 0.0
        self._jitter: float = 0.0
        self._lock = asyncio.Lock()
        self._ttl = ttl
        self._daily_reset_hour = daily_reset_hour

    def _is_expired(self) -> bool:
        if self._ts == 0:
            return True
        if self._daily_reset_hour is not None:
            from datetime import datetime
            cached_dt = datetime.fromtimestamp(self._ts)
            now = datetime.now()
            reset_today = now.replace(hour=self._daily_reset_hour, minute=0, second=0, microsecond=0)
            if now >= reset_today and cached_dt < reset_today:
                return True
            return False
        return (time.time() - self._ts) >= self._ttl

    async def get(self, key: tuple) -> dict | None:
        async with self._lock:
            if self._key == key and not self._is_expired():
                return self._data
            return None

    async def get_tick_aware(self, key: tuple, tracker) -> dict | None:
        """Return cached data if key matches and tick-based expiry hasn't passed. Thread-safe."""
        async with self._lock:
            if self._key != key or self._data is None:
                return None
            age = time.monotonic() - self._mono_ts if self._mono_ts else 0.0
            remaining = tracker.cache_expiry_seconds(age, fallback_ttl=self._ttl)
            if remaining > self._jitter:
                return self._data
            return None

    async def set(self, key: tuple, data: dict):
        async with self._lock:
            self._key = key
            self._data = data
            self._ts = time.time()
            self._mono_ts = time.monotonic()
            self._jitter = random.uniform(0, 0.5)

    @property
    def stale_data(self) -> dict | None:
        return self._data


class _CircuitBreaker:
    def __init__(self):
        self.failures = 0
        self.last_failure_time = 0.0

    def record_failure(self):
        self.failures += 1
        self.last_failure_time = time.time()
        if self.failures == MAX_CONSECUTIVE_FAILURES:
            log.warning("[circuit_breaker] OPEN after %d failures", self.failures)

    def record_success(self):
        if self.failures >= MAX_CONSECUTIVE_FAILURES:
            log.info("[circuit_breaker] CLOSED, upstream recovered")
        self.failures = 0

    @property
    def is_open(self) -> bool:
        if self.failures >= MAX_CONSECUTIVE_FAILURES:
            elapsed = time.time() - self.last_failure_time
            return elapsed < CIRCUIT_BREAKER_COOLDOWN
        return False


cache = _Cache(ttl=CACHE_TTL)
stops_cache = _Cache(daily_reset_hour=3)
breaker = _CircuitBreaker()
client_activity = ClientActivity()
tick_tracker = TickTracker()
_inflight: dict[tuple, asyncio.Future] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.client = httpx.AsyncClient(
        timeout=UPSTREAM_TIMEOUT,
        limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
        headers={"Content-Type": "application/json", "User-Agent": "BusradarBW/1.0"},
    )
    log.info("httpx client started")

    from stops_builder import load_stops_cache
    cached = load_stops_cache()
    if cached:
        app.state.stops_data = cached
        log.info("Stops cache loaded: %d stops", cached["count"])
    else:
        log.info("Stops cache stale or missing, building in background...")
        app.state.stops_data = {"stops": [], "count": 0}
        asyncio.create_task(_build_stops_on_startup(app))

    asyncio.create_task(schedule_daily_rebuild_wrapper(app))

    calib_task = None
    if _TICK_ENABLED:
        calib_task = asyncio.create_task(
            tick_calibrator(app, breaker, tick_tracker, client_activity,
                           HAFAS_ENDPOINT, _build_hafas_envelope)
        )

    yield

    if calib_task:
        calib_task.cancel()
        try:
            await calib_task
        except (asyncio.CancelledError, Exception):
            pass
    await app.state.client.aclose()
    log.info("httpx client closed")


async def _build_stops_on_startup(app: FastAPI):
    from stops_builder import build_stops_cache
    try:
        data = await build_stops_cache()
        app.state.stops_data = data
    except Exception as e:
        log.error("Startup stops build failed: %s", e)


async def schedule_daily_rebuild_wrapper(app: FastAPI):
    from stops_builder import build_stops_cache
    while True:
        from datetime import datetime, timedelta
        now = datetime.now()
        next_run = now.replace(hour=3, minute=0, second=0, microsecond=0)
        if now >= next_run:
            next_run += timedelta(days=1)
        wait_seconds = (next_run - now).total_seconds()
        log.info("Next stops rebuild at %s", next_run.strftime("%Y-%m-%d %H:%M"))
        await asyncio.sleep(wait_seconds)
        try:
            data = await build_stops_cache()
            app.state.stops_data = data
        except Exception as e:
            log.error("Daily stops rebuild failed: %s", e)


app = FastAPI(title="Busradar BW", lifespan=lifespan)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "geolocation=(self)"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self' 'sha256-awVWMbWgk3dxKQpOaRlevanDj2peBlVkB83wOZKxfk4='; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' https://*.basemaps.cartocdn.com https://tile.openstreetmap.org https://*.tile.openstreetmap.org data:; "
            "connect-src 'self'; "
            "font-src 'self'; "
            "base-uri 'self'; "
            "object-src 'none'; "
            "frame-ancestors 'none'"
        )
        return response


app.add_middleware(SecurityHeadersMiddleware)


JID_PATTERN = re.compile(r"^[\d|#A-Za-z@:_\-. ]+$")
LID_PATTERN = re.compile(r"^A=\d+@")


async def _hafas_call(request: Request, method: str, req: dict) -> dict:
    if breaker.is_open:
        return {"error": "upstream_unavailable", "detail": "Service temporarily unavailable"}

    payload = _build_hafas_envelope(method, req)
    try:
        resp = await request.app.state.client.post(HAFAS_ENDPOINT, json=payload)
        resp.raise_for_status()
        data = resp.json()

        if data.get("err") != "OK":
            breaker.record_failure()
            log.warning("[hafas] api_error method=%s err=%s", method, data.get("err"))
            return {"error": "upstream_error", "detail": "HAFAS error"}

        svc_res = data.get("svcResL", [{}])[0]
        if svc_res.get("err") != "OK":
            breaker.record_failure()
            log.warning("[hafas] svc_error method=%s err=%s", method, svc_res.get("err"))
            return {"error": "upstream_error", "detail": "HAFAS service error"}

        breaker.record_success()
        return svc_res.get("res", {})

    except httpx.TimeoutException:
        breaker.record_failure()
        log.warning("[hafas] timeout method=%s", method)
        return {"error": "upstream_timeout", "detail": "HAFAS did not respond in time"}
    except httpx.HTTPError as e:
        breaker.record_failure()
        log.error("[hafas] http_error method=%s type=%s", method, type(e).__name__)
        return {"error": "upstream_error", "detail": "Upstream HTTP error"}
    except Exception:
        breaker.record_failure()
        log.exception("[hafas] unexpected_error method=%s", method)
        return {"error": "internal_error", "detail": "Internal proxy error"}


def _calc_delay(stop: dict) -> int | None:
    for prefix in ("d", "a"):
        time_s = stop.get(f"{prefix}TimeS")
        time_r = stop.get(f"{prefix}TimeR")
        if time_s and time_r:
            try:
                plan_min = int(time_s[:2]) * 60 + int(time_s[2:4])
                real_min = int(time_r[:2]) * 60 + int(time_r[2:4])
                delay = real_min - plan_min
                if delay < -720:
                    delay += 1440
                elif delay > 720:
                    delay -= 1440
                return delay
            except (ValueError, IndexError):
                return None
    return None


def _flatten_vehicles(res: dict) -> list[dict]:
    common = res.get("common", {})
    prod_l = common.get("prodL", [])
    loc_l = common.get("locL", [])
    jny_l = res.get("jnyL", [])

    vehicles = []
    for j in jny_l:
        pos = j.get("pos")
        if not pos or pos.get("x") == 0 or pos.get("y") == 0:
            continue

        prod_idx = j.get("prodX", -1)
        prod = prod_l[prod_idx] if 0 <= prod_idx < len(prod_l) else {}

        stop_l = j.get("stopL", [])
        delay = None
        for s in stop_l:
            d = _calc_delay(s)
            if d is not None:
                delay = d

        next_stops = []
        for s in stop_l:
            loc_idx = s.get("locX", -1)
            loc = loc_l[loc_idx] if 0 <= loc_idx < len(loc_l) else {}
            platform = ""
            for gid in loc.get("gidL", []):
                if gid.startswith("A×"):
                    parts = gid.split(":")
                    if len(parts) >= 5 and parts[4]:
                        platform = parts[4]
                        break
            next_stops.append({
                "name": loc.get("name", "?"),
                "lid": loc.get("lid", ""),
                "lat": loc.get("crd", {}).get("y", 0) / 1_000_000,
                "lon": loc.get("crd", {}).get("x", 0) / 1_000_000,
                "extId": loc.get("extId", ""),
                "platform": platform,
                "dTimeS": s.get("dTimeS"),
                "dTimeR": s.get("dTimeR"),
                "aTimeS": s.get("aTimeS"),
                "aTimeR": s.get("aTimeR"),
                "dProgType": s.get("dProgType"),
            })

        vehicles.append({
            "jid": j.get("jid", ""),
            "line": prod.get("nameS", prod.get("name", "?")),
            "lineFull": prod.get("name", "?"),
            "direction": j.get("dirTxt", "?"),
            "lat": pos.get("y", 0) / 1_000_000,
            "lon": pos.get("x", 0) / 1_000_000,
            "delay": delay,
            "dirGeo": j.get("dirGeo"),
            "progress": j.get("proc"),
            "stops": next_stops,
        })

    return vehicles


def _inject_tick_hints(result: dict) -> dict:
    return inject_tick_hints(result, tick_tracker)


@app.get("/api/vehicles")
async def get_vehicles(
    request: Request,
    swLat: float = Query(default=49.0, ge=45.0, le=56.0),
    swLon: float = Query(default=8.0, ge=4.0, le=17.0),
    neLat: float = Query(default=49.6, ge=45.0, le=56.0),
    neLon: float = Query(default=9.0, ge=4.0, le=17.0),
    posMode: str = Query(default="CALC", pattern="^(CALC|REPORT_ONLY)$"),
    _t: int = Query(default=None),
):
    if swLat > neLat or swLon > neLon:
        return JSONResponse(status_code=400, content={"error": "invalid_request", "detail": "Inverted bounds"})

    cache_key = (round(swLat, 2), round(swLon, 2), round(neLat, 2), round(neLon, 2), posMode)
    client_activity.touch()
    skip_cache = _t is not None

    if not skip_cache:
        if _TICK_ENABLED:
            cached = await cache.get_tick_aware(cache_key, tick_tracker)
            if cached:
                return _inject_tick_hints(cached)
        else:
            cached = await cache.get(cache_key)
            if cached:
                from datetime import datetime
                out = dict(cached)
                out["serverTime"] = datetime.now().strftime("%H%M%S")
                return out

    # Singleflight: first request fetches, others await same Future
    fut = _inflight.get(cache_key)
    if fut is not None:
        try:
            return await asyncio.wait_for(asyncio.shield(fut), timeout=UPSTREAM_TIMEOUT + 2)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            pass
        # Fallback: try cache or proceed as new leader
        cached = await cache.get_tick_aware(cache_key, tick_tracker) if _TICK_ENABLED else await cache.get(cache_key)
        if cached:
            return _inject_tick_hints(cached) if _TICK_ENABLED else cached

    loop = asyncio.get_event_loop()
    fut = loop.create_future()
    _inflight[cache_key] = fut
    try:
        hafas_req = {
            "rect": {
                "llCrd": {"x": round(swLon * 1_000_000), "y": round(swLat * 1_000_000)},
                "urCrd": {"x": round(neLon * 1_000_000), "y": round(neLat * 1_000_000)},
            },
            "perSize": 120,
            "perStep": 10,
            "jnyFltrL": [{"type": "PROD", "mode": "INC", "value": "32"}],
            "trainPosMode": posMode,
        }

        res = await _hafas_call(request, "JourneyGeoPos", hafas_req)

        if "error" in res:
            stale = cache.stale_data
            if stale:
                response = _inject_tick_hints(stale) if _TICK_ENABLED else stale
                if not fut.done():
                    fut.set_result(response)
                return response
            response = JSONResponse(status_code=502, content=res)
            if not fut.done():
                fut.set_result(response)
            return response

        from datetime import datetime
        now_dt = datetime.now()
        vehicles = _flatten_vehicles(res)
        result = {
            "vehicles": vehicles,
            "count": len(vehicles),
            "timestamp": time.time(),
            "serverTime": now_dt.strftime("%H%M%S"),
        }

        await cache.set(cache_key, result)

        response = _inject_tick_hints(result) if _TICK_ENABLED else result
        if not fut.done():
            fut.set_result(response)
        return response
    except Exception as e:
        if not fut.done():
            fut.set_exception(e)
        raise
    finally:
        _inflight.pop(cache_key, None)


async def _discover_platforms(request: Request, lid: str) -> list[dict]:
    """Discover sub-platforms by querying DEP+ARR StationBoard and extracting locL entries."""
    platforms = []
    seen = set()

    for board_type in ("DEP", "ARR"):
        hafas_req = {
            "stbLoc": {"lid": lid},
            "type": board_type,
            "dur": 1440,
            "jnyFltrL": [{"type": "PROD", "mode": "INC", "value": "32"}],
        }
        res = await _hafas_call(request, "StationBoard", hafas_req)
        if "error" in res:
            continue

        loc_l = res.get("common", {}).get("locL", [])
        jny_l = res.get("jnyL", [])

        used_loc_indices = set()
        for jny in jny_l:
            stb = jny.get("stbStop", {})
            if "locX" in stb:
                used_loc_indices.add(stb["locX"])

        for idx in used_loc_indices:
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
            has_physical_stop = any(g.startswith("b×") for g in gid_l)
            if not has_physical_stop:
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


@app.get("/api/stops")
async def get_stops(
    request: Request,
    lat: float = Query(default=49.2944, ge=47.0, le=55.0),
    lon: float = Query(default=8.6434, ge=5.0, le=16.0),
    radius: int = Query(default=5000, ge=100, le=20000),
):
    import math
    stops_data = request.app.state.stops_data
    all_stops = stops_data.get("stops", [])

    filtered = []
    for s in all_stops:
        dlat = (s["lat"] - lat) * 111000
        dlon = (s["lon"] - lon) * 111000 * math.cos(math.radians(lat))
        dist = math.sqrt(dlat * dlat + dlon * dlon)
        if dist <= radius:
            filtered.append(s)

    return {"stops": filtered, "count": len(filtered)}


@app.get("/api/search")
async def search_stops(
    request: Request,
    q: str = Query(min_length=2, max_length=100),
    lat: float = Query(default=None),
    lon: float = Query(default=None),
):
    import math

    query_lower = q.lower()
    query_words = query_lower.split()
    stops_data = getattr(request.app.state, "stops_data", None) or {}
    all_stops = stops_data.get("stops", [])

    results = []
    seen_coords = set()
    for s in all_stops:
        name_lower = s["name"].lower()
        if all(w in name_lower for w in query_words):
            coord_key = f"{s['name']}|{s['lat']}|{s['lon']}"
            if coord_key in seen_coords:
                continue
            seen_coords.add(coord_key)
            results.append(s)

    if lat is not None and lon is not None:
        results.sort(key=lambda s: math.sqrt(
            ((s["lat"] - lat) * 111) ** 2 + ((s["lon"] - lon) * 111 * 0.65) ** 2
        ))

    return {"results": results[:50], "count": min(len(results), 50)}


class JourneyRequest(BaseModel):
    jid: str = Field(max_length=300)

    @field_validator("jid")
    @classmethod
    def validate_jid(cls, v: str) -> str:
        if not JID_PATTERN.match(v):
            raise ValueError("Invalid journey ID format")
        return v


_journey_cache: dict = {}
_JOURNEY_CACHE_TTL = 30


@app.post("/api/journey")
async def get_journey(request: Request, body: JourneyRequest):
    now = time.time()
    cached = _journey_cache.get(body.jid)
    if cached and (now - cached[0]) < _JOURNEY_CACHE_TTL:
        return cached[1]

    hafas_req = {"jid": body.jid, "getPolyline": True}
    res = await _hafas_call(request, "JourneyDetails", hafas_req)

    if "error" in res:
        return JSONResponse(status_code=502, content=res)

    _journey_cache[body.jid] = (now, res)
    if len(_journey_cache) > 200:
        oldest = sorted(_journey_cache, key=lambda k: _journey_cache[k][0])[:100]
        for k in oldest:
            del _journey_cache[k]

    return res


class BoardType(str, Enum):
    DEP = "DEP"
    ARR = "ARR"


class StationBoardRequest(BaseModel):
    lid: str = Field(max_length=200)
    type: BoardType = BoardType.DEP
    dur: int = Field(default=60, ge=1, le=1440)

    @field_validator("lid")
    @classmethod
    def validate_lid(cls, v: str) -> str:
        if not LID_PATTERN.match(v):
            raise ValueError("Invalid location ID format")
        return v


_stationboard_cache: dict = {}
_STATIONBOARD_CACHE_TTL = 10


@app.post("/api/stationboard")
async def get_stationboard(request: Request, body: StationBoardRequest):
    now = time.time()
    cache_key = (body.lid, body.type.value, body.dur)
    cached = _stationboard_cache.get(cache_key)
    if cached and (now - cached[0]) < _STATIONBOARD_CACHE_TTL:
        return cached[1]

    hafas_req = {
        "stbLoc": {"lid": body.lid},
        "type": body.type.value,
        "dur": body.dur,
        "jnyFltrL": [{"type": "PROD", "mode": "INC", "value": "32"}],
    }

    res = await _hafas_call(request, "StationBoard", hafas_req)

    if "error" in res:
        return JSONResponse(status_code=502, content=res)

    _stationboard_cache[cache_key] = (now, res)
    if len(_stationboard_cache) > 500:
        oldest = sorted(_stationboard_cache, key=lambda k: _stationboard_cache[k][0])[:250]
        for k in oldest:
            del _stationboard_cache[k]

    return res


@app.get("/api/health")
async def health(request: Request):
    ts = tick_tracker.last_tick_ts
    mono_now = time.monotonic()
    result = {
        "status": "ok",
        "circuit_breaker": "open" if breaker.is_open else "closed",
        "failures": breaker.failures,
    }
    if _TICK_ENABLED:
        tick_age = (mono_now - ts) if ts else None
        result["tick_known"] = tick_age is not None and tick_age < TICK_MAX_AGE
        result["tick_age_s"] = round(tick_age, 1) if tick_age is not None else None
        result["calibrator_mode"] = "active" if client_activity.is_active() else "idle"
    return result


_line_search_cache: dict = {}
_LINE_SEARCH_CACHE_TTL = 30


@app.get("/api/line_search")
async def line_search(
    request: Request,
    q: str = Query(min_length=1, max_length=10),
):
    """Search for active bus lines BW-wide."""
    q_lower = q.strip().lower()
    now = time.time()
    cached = _line_search_cache.get("bw")
    if cached and (now - cached[0]) < _LINE_SEARCH_CACHE_TTL:
        all_vehicles = cached[1]
    else:
        hafas_req = {
            "ring": {
                "cCrd": {"x": 9_000_000, "y": 48_800_000},
                "maxDist": 200000,
            },
            "perSize": 120,
            "perStep": 10,
            "jnyFltrL": [{"type": "PROD", "mode": "INC", "value": "32"}],
            "trainPosMode": "CALC",
        }
        res = await _hafas_call(request, "JourneyGeoPos", hafas_req)
        if "error" in res:
            return JSONResponse(status_code=502, content=res)
        all_vehicles = _flatten_vehicles(res)
        _line_search_cache["bw"] = (now, all_vehicles)

    matches = []
    seen_jids = set()
    for v in all_vehicles:
        if v["jid"] in seen_jids:
            continue
        line_lower = v["line"].lower()
        if line_lower == q_lower or line_lower.startswith(q_lower):
            matches.append(v)
            seen_jids.add(v["jid"])

    return {"vehicles": matches, "count": len(matches)}


app.mount("/", StaticFiles(directory="static", html=True), name="static")
