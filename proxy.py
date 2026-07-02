"""
Busradar BW — FastAPI Backend Proxy

Proxies requests to the HAFAS mgate.exe API, adding input validation,
rate limiting, caching, and security headers.

This module orchestrates: route registration, app/lifespan setup, security
middleware, and the version/service-worker plumbing. Helpers live in:

* audit.py       — rate-limited audit logging
* hafas.py       — HAFAS endpoint client + circuit breaker
* caches.py      — single-slot + per-endpoint caches and singleflight
* sse_handler.py — SSE stream handler + sidecar POST endpoints
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import subprocess
import time
from contextlib import asynccontextmanager
from enum import Enum
from pathlib import Path

import httpx
from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from pydantic import BaseModel, Field, field_validator

import fanout
# Re-export submodule symbols so tests can keep using `from proxy import X`.
# noqa: F401 — these names are deliberately imported into the proxy namespace.
from audit import (  # noqa: F401
    _audit,
    _audit_log_last,
    AUDIT_LOG_MAX_KEYS,
)
from caches import (  # noqa: F401
    _Cache,
    cache,
    stops_cache,
    cached_singleflight,
    _inflight,
    _journey_cache,
    _journey_cache_lock,
    _inflight_journey,
    _JOURNEY_CACHE_TTL,
    _stationboard_cache,
    _stationboard_cache_lock,
    _inflight_stationboard,
    _STATIONBOARD_CACHE_TTL,
    _line_search_cache,
    _LINE_SEARCH_CACHE_TTL,
    CACHE_TTL,
    STOPS_CACHE_TTL,
)
from hafas import (  # noqa: F401
    HAFAS_ENDPOINT,
    AUTH_AID,
    CLIENT_ID,
    CLIENT_VERSION,
    CLIENT_NAME,
    EXT,
    VER,
    UPSTREAM_TIMEOUT,
    MAX_CONSECUTIVE_FAILURES,
    CIRCUIT_BREAKER_COOLDOWN,
    JID_PATTERN,
    LID_PATTERN,
    _build_hafas_envelope,
    _CircuitBreaker,
    breaker,
    _hafas_call_via_app,
)
from sse_handler import (  # noqa: F401
    ALLOWED_ORIGINS,
    SSE_COOKIE_NAME,
    SSE_COOKIE_PATH,
    SSE_COOKIE_SECURE,
    SSE_PROTOCOL_VERSION,
    SSE_KEEPALIVE_MIN,
    SSE_KEEPALIVE_MAX,
    SSE_BODY_LIMIT,
    SSE_SLOW_YIELD_THRESHOLD_S,
    SelectPayload,
    ViewportPayload,
    _client_ip,
    _check_origin,
    _err_response,
    _fetch_for_selection,
    _fetch_journey_for_subscriber,
    _fetch_stationboard_for_subscriber,
    _fetch_vehicles_for_viewport,
    _format_keepalive,
    _format_sse,
    _lookup_subscriber,
    _noop_async,
    _post_rate_check,
    _post_rate_check_ip,
    _post_rate_per_ip,
    _rate_check_request,
    _read_body_with_limit,
    client_activity,
    handle_sse_stream,
    handle_viewport,
    handle_select,
)
from tick import (
    TickTracker, tick_calibrator, sse_push_loop,
    _TICK_ENABLED, _SSE_PUSH_ENABLED, TICK_MAX_AGE,
)


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


tick_tracker = TickTracker()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Init-order guard: tick.py imports fanout and calls fanout.fire_tick()
    # from tick_calibrator. If fanout's module-level state was somehow not
    # set up before that fires, fail loud rather than silently miss ticks.
    if not hasattr(fanout, "tick_condition") or not hasattr(fanout, "registry"):
        raise RuntimeError("fanout module not initialized before lifespan")
    # Single-worker assumption for the SubscriberRegistry: each uvicorn worker
    # has its own in-memory registry. With N workers the connected-clients
    # count would appear divided by N and viewport-POST cookies could route
    # to the wrong worker. The SSE migration plan documents this as the
    # explicit out-of-scope limit; revisit if multi-worker is needed.
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

    from stops_builder import load_stops_cache, is_stops_cache_stale
    cached = load_stops_cache()
    stale = is_stops_cache_stale(cached)
    skip_rebuild = os.environ.get("BUSRADAR_SKIP_STOPS_REBUILD") == "1"
    # Initialise the rebuild-in-progress flag before any background task
    # can flip it. /api/health reads this so operators can tell whether a
    # multi-minute HAFAS-fanout rebuild is currently consuming the server.
    app.state.stops_rebuilding = False

    # All long-lived background tasks are tracked so the lifespan cancels
    # them cleanly on shutdown. Untracked tasks otherwise ran past
    # app.state.client.aclose() and logged "client closed" tracebacks.
    background_tasks: list[asyncio.Task] = []

    if skip_rebuild:
        log.warning("BUSRADAR_SKIP_STOPS_REBUILD=1 set — skipping startup stops rebuild")
    if cached:
        app.state.stops_data = cached
        log.info("Stops cache loaded: %d stops (stale=%s)", cached["count"], stale)
        if stale and not skip_rebuild:
            log.info("Stops cache is stale, refreshing in background")
            background_tasks.append(asyncio.create_task(_build_stops_on_startup(app)))
    else:
        log.info("Stops cache missing or unreadable, building in background...")
        app.state.stops_data = {"stops": [], "count": 0}
        if not skip_rebuild:
            background_tasks.append(asyncio.create_task(_build_stops_on_startup(app)))

    background_tasks.append(asyncio.create_task(schedule_daily_rebuild_wrapper(app)))

    if _TICK_ENABLED:
        background_tasks.append(asyncio.create_task(
            tick_calibrator(app, breaker, tick_tracker, client_activity,
                           HAFAS_ENDPOINT, _build_hafas_envelope)
        ))
    if _SSE_PUSH_ENABLED:
        background_tasks.append(asyncio.create_task(sse_push_loop(client_activity)))

    yield

    # Cancel in reverse creation order: push loop first (so it stops
    # broadcasting), then calibrator, then rebuild tasks. Errors are
    # logged separately from CancelledError so a real shutdown bug is
    # visible in the journal rather than swallowed.
    for _t in reversed(background_tasks):
        _t.cancel()
        try:
            await _t
        except asyncio.CancelledError:
            pass
        except Exception:
            log.exception("[lifespan] background task raised during shutdown")
    await app.state.client.aclose()
    log.info("httpx client closed")


async def _build_stops_on_startup(app: FastAPI):
    from stops_builder import build_stops_cache
    import time as _t
    app.state.stops_rebuilding = True
    t0 = _t.time()
    try:
        data = await build_stops_cache()
        app.state.stops_data = data
        log.info("Startup stops build complete: %d stops in %.0fs", data.get("count", 0), _t.time() - t0)
    except Exception as e:
        log.error("Startup stops build failed after %.0fs: %s", _t.time() - t0, e)
    finally:
        app.state.stops_rebuilding = False


async def schedule_daily_rebuild_wrapper(app: FastAPI):
    from stops_builder import build_stops_cache
    import time as _t
    while True:
        from datetime import datetime, timedelta
        now = datetime.now()
        next_run = now.replace(hour=3, minute=0, second=0, microsecond=0)
        if now >= next_run:
            next_run += timedelta(days=1)
        wait_seconds = (next_run - now).total_seconds()
        log.info("Next stops rebuild at %s", next_run.strftime("%Y-%m-%d %H:%M"))
        await asyncio.sleep(wait_seconds)
        app.state.stops_rebuilding = True
        t0 = _t.time()
        try:
            data = await build_stops_cache()
            app.state.stops_data = data
            log.info("Daily stops rebuild complete: %d stops in %.0fs", data.get("count", 0), _t.time() - t0)
        except Exception as e:
            log.error("Daily stops rebuild failed after %.0fs: %s", _t.time() - t0, e)
        finally:
            app.state.stops_rebuilding = False


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
        res = await _hafas_call_via_app(request.app, "StationBoard", hafas_req)
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


@app.post("/api/journey")
async def get_journey(request: Request, body: JourneyRequest):
    # Per-IP rate-limit so the unauthenticated POST surface can't be flooded.
    # Opt-in burst 10/s per IP (canonicalized) — matches SSE sidecar gates.
    if not _rate_check_request(request, sub=None):
        return JSONResponse(
            status_code=429,
            content={"error": "rate_limit", "scope": "ip"},
            headers={"Retry-After": "1"},
        )
    now = time.time()
    cached = _journey_cache.get(body.jid)
    if cached and (now - cached[0]) < _JOURNEY_CACHE_TTL:
        return cached[1]

    hafas_req = {"jid": body.jid, "getPolyline": True}
    res = await _hafas_call_via_app(request.app, "JourneyDetails", hafas_req)

    if "error" in res:
        # Opaque client-facing reason — same shape as the SSE path. Internal
        # taxonomy (`upstream_unavailable`, `upstream_timeout`, etc.) stays in
        # logs but never reaches the wire.
        return JSONResponse(status_code=502, content={"error": "upstream"})

    # Cache write + eviction under the same lock the SSE singleflight path
    # uses, otherwise concurrent eviction's `sorted(...)` over the live dict
    # can race the SSE writer with a "dictionary changed size during iteration"
    # RuntimeError.
    async with _journey_cache_lock:
        _journey_cache[body.jid] = (time.time(), res)
        if len(_journey_cache) > 200:
            oldest = sorted(_journey_cache, key=lambda k: _journey_cache[k][0])[:100]
            for k in oldest:
                _journey_cache.pop(k, None)

    return res


class BoardType(str, Enum):
    DEP = "DEP"
    ARR = "ARR"


class StationBoardRequest(BaseModel):
    lid: str = Field(max_length=200)
    type: BoardType = BoardType.DEP
    # Window must match the SSE-side StationSelection constraint (60..1440,
    # multiples of 60) so the two interfaces can't pollute their shared
    # _stationboard_cache with keys the other side will never reuse.
    dur: int = Field(default=60, ge=60, le=1440)

    @field_validator("dur")
    @classmethod
    def _dur_must_be_multiple_of_60(cls, v: int) -> int:
        if v % 60 != 0:
            raise ValueError("dur must be a multiple of 60")
        return v

    @field_validator("lid")
    @classmethod
    def validate_lid(cls, v: str) -> str:
        if not LID_PATTERN.match(v):
            raise ValueError("Invalid location ID format")
        return v


@app.post("/api/stationboard")
async def get_stationboard(request: Request, body: StationBoardRequest):
    if not _rate_check_request(request, sub=None):
        return JSONResponse(
            status_code=429,
            content={"error": "rate_limit", "scope": "ip"},
            headers={"Retry-After": "1"},
        )
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

    res = await _hafas_call_via_app(request.app, "StationBoard", hafas_req)

    if "error" in res:
        return JSONResponse(status_code=502, content={"error": "upstream"})

    async with _stationboard_cache_lock:
        _stationboard_cache[cache_key] = (time.time(), res)
        if len(_stationboard_cache) > 500:
            oldest = sorted(_stationboard_cache, key=lambda k: _stationboard_cache[k][0])[:250]
            for k in oldest:
                _stationboard_cache.pop(k, None)

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
        # True while either the startup or the daily 3am stops-cache
        # rebuild is running. The rebuild fans out hundreds of HAFAS
        # calls (~600 grid points + per-stop platform discovery) and
        # takes a few minutes; surfacing it here lets operators tell
        # "live data slow because rebuild in progress" apart from
        # "live data slow because something is wrong".
        "stops_rebuilding": bool(getattr(request.app.state, "stops_rebuilding", False)),
        "stops_count": (getattr(request.app.state, "stops_data", None) or {}).get("count", 0),
    }
    if _TICK_ENABLED:
        tick_age = (mono_now - ts) if ts else None
        result["tick_known"] = tick_age is not None and tick_age < TICK_MAX_AGE
        result["tick_age_s"] = round(tick_age, 1) if tick_age is not None else None
        result["calibrator_mode"] = "active" if client_activity.is_active() else "idle"
    return result


@app.get("/api/line_search")
async def line_search(
    request: Request,
    q: str = Query(min_length=1, max_length=10),
):
    """Search for active bus lines BW-wide."""
    if not _rate_check_request(request, sub=None):
        return JSONResponse(
            status_code=429,
            content={"error": "rate_limit", "scope": "ip"},
            headers={"Retry-After": "1"},
        )
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
        res = await _hafas_call_via_app(request.app, "JourneyGeoPos", hafas_req)
        if "error" in res:
            return JSONResponse(status_code=502, content={"error": "upstream"})
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


# --- Templated static assets ---
# /sw.js and / (index.html) both want the same trick: load a file at
# import time, substitute `__APP_VERSION__` for the deploy version,
# serve the result with no-cache headers, and fall back to a 503 stub
# when the template is unreadable. TemplatedAsset captures that
# pattern so a fourth route (e.g. a versioned manifest.json) is one
# instance, not another copy-pasted route handler.
_SW_PLACEHOLDER = "__APP_VERSION__"


class TemplatedAsset:
    """Hand-served static file with `__APP_VERSION__` substituted at
    import time. Stores the rendered body + the metadata needed to
    answer requests (media type, fallback stub for the 503 path,
    extra response headers like Service-Worker-Allowed).

    The class deliberately doesn't read the file or do the substitution
    lazily — both happen once at construction so request-time work is
    just two attribute reads and a Response constructor. Edit-in-place
    deploys still need a process restart to pick up template changes,
    which matches the existing deploy model (RPM + transactional-update
    + reboot)."""

    def __init__(self, path: Path, version: str, media_type: str,
                 fallback_body: str, extra_headers: dict | None = None):
        self.path = path
        self.media_type = media_type
        self.fallback_body = fallback_body
        self.extra_headers = extra_headers or {}
        try:
            self.template = path.read_text(encoding="utf-8")
        except OSError as e:
            log.error("[startup] failed to read %s: %s", path, e)
            self.template = ""
        self.rendered = _render_template_version(self.template, version)
        if self.template and not self.rendered:
            log.warning("[startup] %s template loaded but render produced empty body", path.name)

    def response(self) -> Response:
        no_cache = "no-cache, no-store, must-revalidate"
        if not self.rendered:
            return Response(
                self.fallback_body,
                media_type=self.media_type,
                status_code=503,
                headers={"Cache-Control": no_cache},
            )
        headers = {"Cache-Control": no_cache}
        headers.update(self.extra_headers)
        return Response(self.rendered, media_type=self.media_type, headers=headers)


def _render_template_version(template: str, version: str) -> str:
    """Substitute `__APP_VERSION__` in a template string. Falls back to
    "unknown" when version is missing so a misconfigured deploy still
    yields parseable output (the cache simply won't rotate)."""
    if not template:
        return ""
    if version == _SW_PLACEHOLDER:
        # Defensive: a VERSION file that literally contains the placeholder
        # would no-op the substitution and serve invalid output.
        log.error("[startup] _VERSION equals the placeholder; refusing to render")
        return ""
    return template.replace(_SW_PLACEHOLDER, version or "unknown")


# Historical name kept as an alias — the existing test surface imports
# `_render_sw` and a churn-only rename gains nothing.
_render_sw = _render_template_version


_STATIC_DIR = Path(__file__).resolve().parent / "static"

_sw_asset = TemplatedAsset(
    path=_STATIC_DIR / "sw.js",
    version=_VERSION,
    media_type="application/javascript",
    fallback_body="// service worker unavailable\n",
    extra_headers={"Service-Worker-Allowed": "/"},
)

_index_asset = TemplatedAsset(
    path=_STATIC_DIR / "index.html",
    version=_VERSION,
    media_type="text/html; charset=utf-8",
    fallback_body="<!doctype html><meta charset=utf-8><title>busradar</title>service unavailable\n",
)

if _VERSION == "unknown":
    log.warning("[startup] _VERSION is 'unknown'; SW cache name will not rotate on deploy")

# Back-compat aliases so existing tests / external callers reading
# _SW_TEMPLATE / _SW_RENDERED / _INDEX_TEMPLATE / _INDEX_RENDERED at
# module load keep working. New code should reach through the asset
# objects directly.
_SW_PATH = _sw_asset.path
_SW_TEMPLATE = _sw_asset.template
_SW_RENDERED = _sw_asset.rendered
_INDEX_PATH = _index_asset.path
_INDEX_TEMPLATE = _index_asset.template
_INDEX_RENDERED = _index_asset.rendered


@app.get("/api/stream/")
async def sse_stream(request: Request):
    return await handle_sse_stream(request, _VERSION)


@app.post("/api/stream/viewport")
async def stream_viewport(request: Request):
    return await handle_viewport(request)


@app.post("/api/stream/select")
async def stream_select(request: Request):
    return await handle_select(request)


@app.get("/sw.js")
async def serve_sw():
    return _sw_asset.response()


@app.get("/")
async def serve_root():
    return _index_asset.response()


@app.get("/index.html")
async def serve_index():
    return _index_asset.response()


# html=False — the explicit @app.get("/") and @app.get("/index.html") routes
# above own the index template (with __APP_VERSION__ substituted into the
# style.css URL). Leaving html=True here would let StaticFiles fall back to
# serving the raw template (placeholder intact) on any quirk that bypassed
# the explicit routes, silently breaking the cache-bust mechanism.
app.mount("/", StaticFiles(directory="static", html=False), name="static")
