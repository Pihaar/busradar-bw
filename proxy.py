"""
Busradar BW — FastAPI Backend Proxy

Proxies requests to the HAFAS mgate.exe API, adding input validation,
rate limiting, caching, and security headers.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import random
import re
import secrets
import shutil
import subprocess
import time
from contextlib import asynccontextmanager
from enum import Enum
from pathlib import Path

import httpx
from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from pydantic import BaseModel, Field, field_validator

import fanout
from tick import (
    TickTracker, ClientActivity, ConnectedClients, inject_tick_hints, tick_calibrator,
    is_valid_client_id, _TICK_ENABLED, TICK_MAX_AGE,
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


_VERSION_RE = re.compile(r"^[A-Za-z0-9._+\-]{1,64}$")
_VERSION_FILE_MAX = 256


def _sanitize_version(raw: str) -> str | None:
    """Strip + validate version string. Reject control chars, oversize, exotic alphabets."""
    v = raw.strip()
    if not v or len(v) > 64:
        return None
    return v if _VERSION_RE.match(v) else None


def _read_version() -> str:
    """Resolve app version. Prefers VERSION file (set by RPM build), falls back
    to `git describe` for local dev, "unknown" if neither yields a valid string.

    Output is regex-validated (alphanumeric + `._+-`, max 64 chars) so that any
    upstream tag content reaching `/api/health` stays a safe JSON literal."""
    here = Path(__file__).resolve().parent
    vfile = here / "VERSION"
    if vfile.exists():
        try:
            raw = vfile.read_bytes()[:_VERSION_FILE_MAX].decode("utf-8", errors="replace")
            v = _sanitize_version(raw)
            if v:
                return v
        except OSError:
            pass
    git_bin = shutil.which("git")
    if git_bin:
        try:
            r = subprocess.run(
                [git_bin,
                 "-c", "core.fsmonitor=",
                 "-c", "core.sshCommand=",
                 "-c", "core.pager=",
                 "-c", "protocol.allow=never",
                 "describe", "--tags", "--always", "--dirty"],
                cwd=here, capture_output=True, timeout=2, check=False,
                env={"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "LC_ALL": "C"},
            )
            if r.returncode == 0:
                raw = r.stdout.decode("utf-8", errors="replace")
                v = _sanitize_version(raw)
                if v:
                    return v
        except (subprocess.SubprocessError, OSError, ValueError):
            pass
    return "unknown"


_VERSION = _read_version()

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
connected_clients = ConnectedClients()
tick_tracker = TickTracker()
_inflight: dict[tuple, asyncio.Future] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Init-order guard: tick.py imports fanout and calls fanout.fire_tick()
    # from tick_calibrator. If fanout's module-level state was somehow not
    # set up before that fires, fail loud rather than silently miss ticks.
    if not hasattr(fanout, "tick_condition") or not hasattr(fanout, "registry"):
        raise RuntimeError("fanout module not initialized before lifespan")
    # Single-Worker-Annahme für ConnectedClients-Counter: jeder Worker hat eigene Map.
    # Bei N Workern würde der Counter durch N geteilt erscheinen.
    try:
        wc = int(os.environ.get("WEB_CONCURRENCY", "1"))
        if wc > 1:
            log.warning("WEB_CONCURRENCY=%d > 1 — connected-clients counter is per-worker only", wc)
    except (ValueError, TypeError):
        pass

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


@app.exception_handler(Exception)
async def _sanitized_exception_handler(request: Request, exc: Exception):
    """Generic catch-all. Logs the traceback server-side but never returns
    it to the client (SEC-236, no information disclosure). Validation
    errors and HTTPException still get FastAPI's normal handling — this
    only wraps unhandled exceptions from handlers."""
    log.exception("[handler] unhandled exception in %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"error": "internal"})


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


async def _hafas_call(request_or_app, method: str, req: dict) -> dict:
    """Call HAFAS. Accepts either a Request (for normal handlers) or a FastAPI
    app (for SSE subscribers that don't have a per-request object). The shared
    httpx.AsyncClient lives on app.state.client either way."""
    app_ref = request_or_app.app if hasattr(request_or_app, "app") else request_or_app
    if breaker.is_open:
        return {"error": "upstream_unavailable", "detail": "Service temporarily unavailable"}

    payload = _build_hafas_envelope(method, req)
    try:
        resp = await app_ref.state.client.post(HAFAS_ENDPOINT, json=payload)
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
    return inject_tick_hints(result, tick_tracker, connected_clients.display_count(), _VERSION)


def _inject_tick_hints_no_count(result: dict) -> dict:
    """Used on stale/error paths to suppress the counter so the bucket isn't
    leaked as a recon surface during HAFAS outages; the frontend guards this."""
    return inject_tick_hints(result, tick_tracker, None, _VERSION)


@app.get("/api/vehicles")
async def get_vehicles_legacy(request: Request):
    """Polling endpoint is gone — the client now uses /api/stream/. Returns
    410 with a stable JSON envelope so any stale bookmark/SDK can detect the
    migration without parsing the HTML shell. Hits are audit-logged
    (rate-limited per IP-hash) so we can see whether anything still polls
    during the iter 2b 72h evidence-gate."""
    ip = request.client.host if request.client else ""
    _audit("legacy-polling-hit", ip)
    return JSONResponse(
        status_code=410,
        content={"error": "gone", "migrate": "sse", "stream": "/api/stream/"},
        headers={"Cache-Control": "no-store"},
    )


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
        "version": _VERSION,
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


_SW_PATH = Path(__file__).resolve().parent / "static" / "sw.js"
try:
    _SW_TEMPLATE = _SW_PATH.read_text(encoding="utf-8")
except OSError as e:
    log.error("[startup] failed to read %s: %s", _SW_PATH, e)
    _SW_TEMPLATE = ""

_SW_PLACEHOLDER = "__APP_VERSION__"


def _render_sw(template: str, version: str) -> str:
    """Substitute the version placeholder in the SW source. Falls back to a
    stable name when version is "unknown" so that a misconfigured deploy still
    yields a parseable JS file (cache simply won't rotate)."""
    if not template:
        return ""
    if version == _SW_PLACEHOLDER:
        # Defensive: a VERSION file that literally contains the placeholder
        # would no-op the substitution and serve invalid JS.
        log.error("[startup] _VERSION equals the SW placeholder; refusing to render")
        return ""
    return template.replace(_SW_PLACEHOLDER, version or "unknown")


_SW_RENDERED = _render_sw(_SW_TEMPLATE, _VERSION)
if _SW_TEMPLATE and not _SW_RENDERED:
    log.warning("[startup] SW template loaded but render produced empty body")
elif _VERSION == "unknown":
    log.warning("[startup] _VERSION is 'unknown'; SW cache name will not rotate on deploy")


# === SSE Stream (Iter 1) ===

ALLOWED_ORIGINS = tuple(
    o.strip() for o in os.environ.get(
        "BUSRADAR_ALLOWED_ORIGINS",
        "https://busradar.pihaar.de,http://localhost:8000,http://127.0.0.1:8000",
    ).split(",") if o.strip()
)
SSE_COOKIE_NAME = "busradar_sse"
SSE_COOKIE_PATH = "/api/stream/"
# Secure-Cookie nur über HTTPS. Per env überschreibbar damit Dev über plain
# http://localhost weiterhin funktioniert (Browsers droppen Secure-Cookies
# über Plain-HTTP); Production läuft hinter nginx-TLS → True.
SSE_COOKIE_SECURE = os.environ.get("BUSRADAR_COOKIE_SECURE", "1") != "0"
SSE_KEEPALIVE_MIN = 12.0
SSE_KEEPALIVE_MAX = 18.0
SSE_BODY_LIMIT = 1024  # POST viewport / select payloads stay small
AUDIT_LOG_MAX_KEYS = 4096  # cap audit-log dict size against slow-leak via scanner

_audit_log_last: dict[str, float] = {}
_AUDIT_RATE = 60.0


def _audit(reason: str, ip: str, **extra) -> None:
    """Rate-limit audit-warnings to 1/min per (reason, ip-hash)."""
    import hashlib
    now = time.monotonic()
    ip_hash = hashlib.sha256(ip.encode()).hexdigest()[:8] if ip else "noip"
    key = f"{reason}:{ip_hash}"
    # Cap dict size against slow-leak via scanner rotating IPs forever.
    if len(_audit_log_last) >= AUDIT_LOG_MAX_KEYS:
        # Drop the oldest half — cheap, no per-entry timestamp scan.
        oldest = sorted(_audit_log_last.items(), key=lambda kv: kv[1])[: AUDIT_LOG_MAX_KEYS // 2]
        for k, _ in oldest:
            _audit_log_last.pop(k, None)
    last = _audit_log_last.get(key, 0.0)
    if now - last < _AUDIT_RATE:
        return
    _audit_log_last[key] = now
    log.warning("[audit] %s ip_hash=%s %s", reason, ip_hash, extra or "")


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else ""


def _check_origin(request: Request) -> bool:
    origin = request.headers.get("Origin")
    if not origin:
        return False
    return origin in ALLOWED_ORIGINS


class ViewportPayload(BaseModel):
    swLat: float = Field(ge=-90.0, le=90.0)
    swLon: float = Field(ge=-180.0, le=180.0)
    neLat: float = Field(ge=-90.0, le=90.0)
    neLon: float = Field(ge=-180.0, le=180.0)
    posMode: str = Field(default="CALC", pattern="^(CALC|REPORT_ONLY)$")

    @field_validator("neLat")
    @classmethod
    def _check_lat_ordering(cls, v, info):
        if "swLat" in info.data and v <= info.data["swLat"]:
            raise ValueError("neLat must be greater than swLat")
        return v

    @field_validator("neLon")
    @classmethod
    def _check_lon_ordering(cls, v, info):
        if "swLon" in info.data and v <= info.data["swLon"]:
            raise ValueError("neLon must be greater than swLon")
        return v


def _format_sse(event: str | None, data: dict, event_id: int | None = None) -> str:
    """Serialize one SSE message. `event` may be None for default 'message',
    `data` is always JSON-encoded so the client side parses uniformly."""
    parts: list[str] = []
    if event_id is not None:
        parts.append(f"id: {event_id}")
    if event:
        parts.append(f"event: {event}")
    parts.append("data: " + json.dumps(data, separators=(",", ":")))
    parts.append("")
    parts.append("")
    return "\n".join(parts)


def _format_keepalive() -> str:
    """Comment line — SSE-compliant, ignored by EventSource clients but keeps
    proxies (nginx 30s/3600s, mobile carriers) from killing the connection."""
    return ": keepalive\n\n"


async def _fetch_vehicles_for_viewport(
    app: FastAPI,
    viewport: tuple[float, float, float, float],
    posMode: str,
) -> dict:
    """Fetch one HAFAS snapshot for the given viewport. Uses bbox quantization
    so subscribers within ~1.1 km share the singleflight inflight key; under
    the same key, exactly one upstream HAFAS call runs regardless of how many
    subscribers are pulling that quantized cell on the current tick."""
    sw_lat, sw_lon, ne_lat, ne_lon = viewport
    cx = int((sw_lon + ne_lon) / 2 * 1_000_000)
    cy = int((sw_lat + ne_lat) / 2 * 1_000_000)
    # Use max of lat/lon spans (in metres) so wide-short viewports still get coverage.
    lat_span_m = (ne_lat - sw_lat) * 111_000
    lon_span_m = (ne_lon - sw_lon) * 111_000 * math.cos(math.radians((sw_lat + ne_lat) / 2))
    max_dist = int(min(80_000, max(lat_span_m, lon_span_m) / 2))
    posMode = posMode if posMode in ("CALC", "REPORT_ONLY") else "CALC"

    hafas_req = {
        "ring": {"cCrd": {"x": cx, "y": cy}, "maxDist": max_dist},
        "perSize": 120,
        "perStep": 10,
        "jnyFltrL": [{"type": "PROD", "mode": "INC", "value": "32"}],
        "trainPosMode": posMode,
    }
    key = ("sse", fanout.quantize_bbox(viewport), posMode)
    existing = _inflight.get(key)
    if existing is not None and not existing.done():
        try:
            return await asyncio.shield(existing)
        except (asyncio.CancelledError, Exception):
            # Originator's future died (cancelled or errored). Don't piggyback;
            # fall through and start our own fetch under the same key. Pop the
            # stale entry so it can't catch the next requester either.
            _inflight.pop(key, None)

    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    _inflight[key] = fut
    try:
        # Cap _inflight via simple LRU-like eviction so a viewport-spam attack
        # can't grow the dict unbounded. Pop oldest only when over cap and not
        # the entry we just inserted.
        if len(_inflight) > fanout.MAX_INFLIGHT:
            oldest = next(iter(_inflight))
            if oldest != key:
                _inflight.pop(oldest, None)
        res = await _hafas_call(app, "JourneyGeoPos", hafas_req)
        if "error" in res:
            out = {"error": res["error"]}
        else:
            from datetime import datetime
            out = {
                "vehicles": _flatten_vehicles(res),
                "serverTime": datetime.now().strftime("%H%M%S"),
            }
        if not fut.done():
            fut.set_result(out)
        return out
    except asyncio.CancelledError:
        # Originator cancelled mid-flight. Propagate cancellation to any
        # piggyback awaiters so they don't hang.
        if not fut.done():
            fut.cancel()
        raise
    except Exception as e:
        if not fut.done():
            fut.set_exception(e)
        raise
    finally:
        _inflight.pop(key, None)


@app.get("/api/stream/")
async def sse_stream(request: Request):
    """SSE endpoint. Subscribers receive `vehicles` events whenever a HAFAS
    tick is detected, plus `connected` count updates and `:keepalive`
    comments. State changes (viewport, selection) come in via the sidecar
    POST endpoints, identified by an HttpOnly cookie set on this first
    GET response. Connection-id is never written to JS or to access_log.
    Last-Event-ID is deliberately ignored — every reconnect is a fresh
    subscriber with a fresh state. The browser auto-reconnects on drop."""

    ip = _client_ip(request)
    try:
        sub = await fanout.registry.subscribe(ip)
    except fanout.CapExceeded as e:
        retry_after = secrets.randbelow(61) + 30  # 30-90s jitter
        return JSONResponse(
            status_code=429,
            content={
                "error": "rate_limit",
                "scope": e.scope,
                "limit": e.limit,
                "retryAfter": retry_after,
            },
            headers={"Retry-After": str(retry_after)},
        )
    # Tick calibrator runs at IDLE_CALIB_INTERVAL=30min when no client activity
    # is recorded. After the iter-2a /api/vehicles → 410 cutover, that touch is
    # gone — calibrator stalls and the SSE loop never wakes. Touch on every new
    # subscribe so the calibrator stays in ACTIVE_CALIB_INTERVAL (5min) mode.
    client_activity.touch()

    async def event_generator():
        try:
            # First event: client knows the stream is live + the app version.
            yield _format_sse(
                "subscribe",
                {"tickSeq": fanout.tick_seq, "appVersion": _VERSION},
            )
            # Emit current connected count up front so the UI doesn't wait
            # up to 30s (one HAFAS tick) before showing it.
            yield _format_sse("connected", {"count": len(fanout.registry)})

            local_seq = fanout.tick_seq
            event_id = 0
            last_connected_count = len(fanout.registry)

            while True:
                # Wait either for a new tick or, in absence of one, for a
                # randomized keepalive interval. asyncio.wait_for raises
                # TimeoutError, which is the keepalive signal.
                keepalive = SSE_KEEPALIVE_MIN + (
                    secrets.randbelow(int((SSE_KEEPALIVE_MAX - SSE_KEEPALIVE_MIN) * 10))
                    / 10.0
                )
                try:
                    async with fanout.tick_condition:
                        await asyncio.wait_for(
                            fanout.tick_condition.wait_for(
                                lambda: fanout.tick_seq > local_seq
                            ),
                            timeout=keepalive,
                        )
                    local_seq = fanout.tick_seq
                    # Keep calibrator in ACTIVE_CALIB_INTERVAL (5min) mode.
                    client_activity.touch()
                except asyncio.TimeoutError:
                    yield _format_keepalive()
                    continue

                # New tick. If subscriber gave us a viewport, fetch + emit.
                if sub.viewport:
                    snap = await _fetch_vehicles_for_viewport(
                        request.app, sub.viewport, sub.pos_mode
                    )
                    event_id += 1
                    if "error" in snap:
                        yield _format_sse(
                            "error",
                            {"reason": snap["error"], "stale": True},
                            event_id,
                        )
                    else:
                        yield _format_sse("vehicles", snap, event_id)

                # Always emit `connected` after a tick (coalesces with any
                # add/remove that happened during this loop iteration).
                count = len(fanout.registry)
                if count != last_connected_count:
                    last_connected_count = count
                    yield _format_sse("connected", {"count": count})

                if fanout.should_disconnect_slow_consumer(sub):
                    _audit("slow-consumer-disconnect", sub.ip, drops=sub.consecutive_drops)
                    break
        finally:
            # AsyncExitStack-style cleanup, but each step suppressed so a
            # later step still runs if an earlier one raises.
            try:
                await fanout.registry.unsubscribe(sub.connection_id)
            except Exception:
                log.exception("[sse] unsubscribe failed for cid")
            # Cookie cleared via headers on the StreamingResponse; the cookie
            # is path-scoped so the browser keeps it only for /api/stream/*
            # POSTs anyway. Task cancel happens at the StreamingResponse level
            # when the client disconnects (CancelledError propagates here).

    response = StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
    response.set_cookie(
        SSE_COOKIE_NAME,
        sub.connection_id,
        max_age=7200,
        httponly=True,
        secure=SSE_COOKIE_SECURE,
        samesite="strict",
        path=SSE_COOKIE_PATH,
    )
    return response


def _lookup_subscriber(request: Request) -> tuple[fanout.Subscriber | None, str | None]:
    """Common subscriber-lookup for the sidecar POST endpoints.

    Returns (sub, error_code) where error_code is one of:
      None — sub is valid
      'missing_cookie' — no cookie at all → 401
      'unknown_connection' — cookie present but subscriber gone → 409
      'origin_mismatch' — Origin header check failed → 403
    """
    if not _check_origin(request):
        _audit("origin-mismatch", _client_ip(request),
               origin=request.headers.get("Origin", "<missing>"))
        return None, "origin_mismatch"
    cid = request.cookies.get(SSE_COOKIE_NAME)
    if not cid:
        return None, "missing_cookie"
    sub = fanout.registry.get(cid)
    if sub is None:
        _audit("invalid-cookie", _client_ip(request))
        return None, "unknown_connection"
    return sub, None


def _err_response(code: str) -> JSONResponse:
    status = {
        "origin_mismatch": 403,
        "missing_cookie": 401,
        "unknown_connection": 409,
        "body_too_large": 413,
    }.get(code, 400)
    return JSONResponse(status_code=status, content={"error": code})


# Token-bucket for viewport-POST per subscriber: 1/s refill, burst 3.
def _viewport_rate_check(sub) -> bool:
    """Returns True if allowed. Continuous refill, capped at burst=3."""
    now = time.monotonic()
    last = getattr(sub, "_viewport_last_refill", now)
    tokens = getattr(sub, "_viewport_tokens", 3.0)
    tokens = min(3.0, tokens + (now - last))
    sub._viewport_last_refill = now
    if tokens >= 1.0:
        sub._viewport_tokens = tokens - 1.0
        return True
    sub._viewport_tokens = tokens
    return False


async def _read_body_with_limit(request: Request, limit: int) -> bytes | None:
    """Read body up to `limit` bytes. Returns None if Content-Length advertises
    more than the limit (pre-read rejection) OR if the streamed body exceeds
    the limit. Avoids buffering an attacker-supplied gigabyte payload."""
    cl = request.headers.get("content-length")
    if cl is not None:
        try:
            if int(cl) > limit:
                return None
        except ValueError:
            return None
    buf = bytearray()
    async for chunk in request.stream():
        buf.extend(chunk)
        if len(buf) > limit:
            return None
    return bytes(buf)


@app.post("/api/stream/viewport")
async def stream_viewport(request: Request):
    """Update the viewport the subscriber's next tick should fetch."""
    raw = await _read_body_with_limit(request, SSE_BODY_LIMIT)
    if raw is None:
        _audit("body-too-large", _client_ip(request))
        return _err_response("body_too_large")

    sub, err = _lookup_subscriber(request)
    if err:
        return _err_response(err)

    if not _viewport_rate_check(sub):
        return JSONResponse(
            status_code=429,
            content={"error": "rate_limit", "scope": "subscriber"},
            headers={"Retry-After": "1"},
        )

    try:
        payload = ViewportPayload.model_validate_json(raw)
    except Exception:
        return JSONResponse(status_code=422, content={"error": "invalid_payload"})

    sub.viewport = (payload.swLat, payload.swLon, payload.neLat, payload.neLon)
    sub.pos_mode = payload.posMode
    # Plan: "sofortiger Pull bei Viewport-Change". The SSE loop is waiting on
    # the tick condition; fire it now so the subscriber fetches its new
    # viewport without waiting for the next 30s HAFAS tick (or, worse,
    # the 5/30-minute calibrator beat). The singleflight `_inflight` keeps
    # this from amplifying — other subscribers wake too but their fetches
    # collapse onto the same upstream call if they share a quantized bbox.
    await fanout.fire_tick()
    return JSONResponse(content={"ok": True})


@app.post("/api/stream/select")
async def stream_select(request: Request):
    """Stub for iter 4. Validates origin + cookie, returns 501 for now so
    the contract is testable but no journey/stationboard fetch happens yet."""
    raw = await _read_body_with_limit(request, SSE_BODY_LIMIT)
    if raw is None:
        _audit("body-too-large", _client_ip(request))
        return _err_response("body_too_large")

    sub, err = _lookup_subscriber(request)
    if err:
        return _err_response(err)

    return JSONResponse(
        status_code=501,
        content={"error": "not_implemented", "iter": 4},
    )


@app.get("/sw.js")
async def serve_sw():
    """Hand-served so we can substitute the cache-version into the SW source.
    StaticFiles can't template, and we need a fresh CACHE name per release."""
    if not _SW_RENDERED:
        return Response(
            "// service worker unavailable\n",
            media_type="application/javascript",
            status_code=503,
            headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
        )
    return Response(
        _SW_RENDERED,
        media_type="application/javascript",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Service-Worker-Allowed": "/",
        },
    )


app.mount("/", StaticFiles(directory="static", html=True), name="static")
