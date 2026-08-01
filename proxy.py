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
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from enum import Enum
from pathlib import Path
from typing import Any, cast

import httpx
from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

import fanout

# Re-export submodule symbols so tests can keep using `from proxy import X`.
from audit import (  # noqa: F401
    AUDIT_LOG_MAX_KEYS,
    _audit,
    _audit_log_last,
)
from caches import (  # noqa: F401
    _JOURNEY_CACHE_TTL,
    _LINE_SEARCH_CACHE_TTL,
    _STATIONBOARD_CACHE_TTL,
    CACHE_TTL,
    STOPS_CACHE_TTL,
    _Cache,
    _inflight,
    _inflight_journey,
    _inflight_stationboard,
    _journey_cache,
    _journey_cache_lock,
    _line_search_cache,
    _stationboard_cache,
    _stationboard_cache_lock,
    cache,
    cached_singleflight,
    stops_cache,
)
from hafas import (  # noqa: F401
    AUTH_AID,
    CIRCUIT_BREAKER_COOLDOWN,
    CLIENT_ID,
    CLIENT_NAME,
    CLIENT_VERSION,
    EXT,
    HAFAS_ENDPOINT,
    JID_PATTERN,
    LID_PATTERN,
    MAX_CONSECUTIVE_FAILURES,
    UPSTREAM_TIMEOUT,
    VER,
    _build_hafas_envelope,
    _CircuitBreaker,
    _hafas_call_via_app,
    breaker,
)
from sse_handler import (  # noqa: F401
    ALLOWED_ORIGINS,
    SSE_BODY_LIMIT,
    SSE_COOKIE_NAME,
    SSE_COOKIE_PATH,
    SSE_COOKIE_SECURE,
    SSE_KEEPALIVE_MAX,
    SSE_KEEPALIVE_MIN,
    SSE_PROTOCOL_VERSION,
    SSE_SLOW_YIELD_THRESHOLD_S,
    SelectPayload,
    ViewportPayload,
    _check_origin,
    _client_ip,
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
    handle_select,
    handle_sse_stream,
    handle_viewport,
)
from tick import (
    _SSE_PUSH_ENABLED,
    _TICK_ENABLED,
    TICK_MAX_AGE,
    TickTracker,
    sse_push_loop,
    tick_calibrator,
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
            # git_bin is from shutil.which (trusted PATH lookup) and every argv
            # entry is a fixed literal — no untrusted input reaches the process.
            r = subprocess.run(  # noqa: S603  # nosec B603
                [
                    git_bin,
                    "-c",
                    "core.fsmonitor=",
                    "-c",
                    "core.sshCommand=",
                    "-c",
                    "core.pager=",
                    "-c",
                    "protocol.allow=never",
                    "describe",
                    "--tags",
                    "--always",
                    "--dirty",
                ],
                cwd=here,
                capture_output=True,
                timeout=2,
                check=False,
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
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
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

    from stops_builder import is_stops_cache_stale, load_stops_cache

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
    background_tasks: list[asyncio.Task[None]] = []

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
        background_tasks.append(
            asyncio.create_task(
                tick_calibrator(
                    app,
                    breaker,
                    tick_tracker,
                    client_activity,
                    HAFAS_ENDPOINT,
                    _build_hafas_envelope,
                )
            )
        )
    if _SSE_PUSH_ENABLED:
        background_tasks.append(asyncio.create_task(sse_push_loop(client_activity, tick_tracker)))

    yield

    # Cancel in reverse creation order: push loop first (so it stops
    # broadcasting), then calibrator, then rebuild tasks. Errors are
    # logged separately from CancelledError so a real shutdown bug is
    # visible in the journal rather than swallowed. Each await is
    # timeout-bounded so a task that ignores cancel (rare, but a
    # transactional_update or slow HAFAS response can hold it) can't
    # brick uvicorn's grace-period shutdown.
    for _t in reversed(background_tasks):
        _t.cancel()
        try:
            await asyncio.wait_for(_t, timeout=5.0)
        except asyncio.CancelledError:
            pass
        except TimeoutError:
            log.warning("[lifespan] background task did not cancel within 5s")
        except Exception:
            log.exception("[lifespan] background task raised during shutdown")
    await app.state.client.aclose()
    log.info("httpx client closed")


async def _build_stops_on_startup(app: FastAPI) -> None:
    import time as _t

    from stops_builder import build_stops_cache

    app.state.stops_rebuilding = True
    t0 = _t.time()
    try:
        data = await build_stops_cache()
        app.state.stops_data = data
        log.info(
            "Startup stops build complete: %d stops in %.0fs",
            cast("dict[str, Any]", data).get("count", 0),
            _t.time() - t0,
        )
    except Exception as e:
        log.error("Startup stops build failed after %.0fs: %s", _t.time() - t0, e)
    finally:
        app.state.stops_rebuilding = False


async def schedule_daily_rebuild_wrapper(app: FastAPI) -> None:
    import time as _t

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
        app.state.stops_rebuilding = True
        t0 = _t.time()
        try:
            data = await build_stops_cache()
            app.state.stops_data = data
            log.info(
                "Daily stops rebuild complete: %d stops in %.0fs",
                cast("dict[str, Any]", data).get("count", 0),
                _t.time() - t0,
            )
        except Exception as e:
            log.error("Daily stops rebuild failed after %.0fs: %s", _t.time() - t0, e)
        finally:
            app.state.stops_rebuilding = False


app = FastAPI(title="Busradar BW", lifespan=lifespan)


@app.exception_handler(Exception)
async def _sanitized_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Generic catch-all. Logs the traceback server-side but never returns
    it to the client (SEC-236, no information disclosure). Validation
    errors and HTTPException still get FastAPI's normal handling — this
    only wraps unhandled exceptions from handlers."""
    log.error(
        "[handler] unhandled exception in %s %s",
        request.method,
        request.url.path,
        exc_info=exc,
    )
    return JSONResponse(status_code=500, content={"error": "internal"})


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        response = await call_next(request)
        # nginx (the edge) is the single wire emitter of these three: it strips
        # the app's copy via proxy_hide_header and re-adds its own, so responses
        # carry exactly one of each (a duplicate "X-Frame-Options: DENY, DENY" is
        # malformed and some browsers ignore it). The app still sets them so it
        # self-protects if ever run without nginx. Service-Worker-Allowed is the
        # inverse case: app-only, because duplicating it (nginx + app) yields the
        # combined scope "/, /" that breaks Firefox service-worker registration.
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "geolocation=(self)"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self' 'sha256-awVWMbWgk3dxKQpOaRlevanDj2peBlVkB83wOZKxfk4='; "
            # Explicit worker-src so the service worker registration doesn't
            # depend on the worker-src → script-src fallback. The fallback
            # *should* allow a same-origin SW (script-src has 'self'), but
            # some Firefox setups reject registration ("operation is
            # insecure") when worker-src is only inherited; being explicit
            # removes the ambiguity. 'self' = same-origin /sw.js only.
            "worker-src 'self'; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' https://*.basemaps.cartocdn.com "
            "https://tile.openstreetmap.org https://*.tile.openstreetmap.org data:; "
            "connect-src 'self'; "
            "font-src 'self'; "
            "base-uri 'self'; "
            "object-src 'none'; "
            "frame-ancestors 'none'"
        )
        return response


app.add_middleware(SecurityHeadersMiddleware)


def _hafas_time_to_min(t: str) -> int:
    """Minutes-of-day for a HAFAS time. Times are normally "HHMMSS"; a day
    offset prefixes extra digits ("1HHMMSS" = next day). Mirrors the client's
    parseHafasTimeToMin so a delayed real time that crosses midnight reads as
    +N rather than being mis-parsed into a huge delay (the +66-at-midnight bug).
    """
    offset = 0
    if len(t) > 6:
        offset = int(t[: len(t) - 6])
        t = t[len(t) - 6 :]
    return (int(t[:2]) + offset * 24) * 60 + int(t[2:4])


def _calc_delay(stop: dict[str, Any]) -> int | None:
    for prefix in ("d", "a"):
        time_s = stop.get(f"{prefix}TimeS")
        time_r = stop.get(f"{prefix}TimeR")
        if time_s and time_r:
            try:
                plan_min = _hafas_time_to_min(time_s)
                real_min = _hafas_time_to_min(time_r)
                delay = real_min - plan_min
                # Fallback for HAFAS returning a next-day time WITHOUT the
                # offset prefix (bare "0001..."); the offset handling above
                # covers the prefixed case.
                if delay < -720:
                    delay += 1440
                elif delay > 720:
                    delay -= 1440
                return delay
            except (ValueError, IndexError):
                return None
    return None


def _flatten_vehicles(res: dict[str, Any]) -> list[dict[str, Any]]:
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
            next_stops.append(
                {
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
                }
            )

        vehicles.append(
            {
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
            }
        )

    return vehicles


@app.get("/api/stops")
async def get_stops(
    request: Request,
    lat: float = Query(default=49.2944, ge=47.0, le=55.0),
    lon: float = Query(default=8.6434, ge=5.0, le=16.0),
    radius: int = Query(default=5000, ge=100, le=20000),
) -> dict[str, Any]:
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
) -> dict[str, Any]:
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
        results.sort(
            key=lambda s: math.sqrt(
                ((s["lat"] - lat) * 111) ** 2 + ((s["lon"] - lon) * 111 * 0.65) ** 2
            )
        )

    return {"results": results[:50], "count": min(len(results), 50)}


class JourneyRequest(BaseModel):
    jid: str = Field(max_length=300)

    @field_validator("jid")
    @classmethod
    def validate_jid(cls, v: str) -> str:
        if not JID_PATTERN.match(v):
            raise ValueError("Invalid journey ID format")
        return v


@app.post("/api/journey", response_model=None)
async def get_journey(request: Request, body: JourneyRequest) -> dict[str, Any] | JSONResponse:
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


# Wall-clock budget for the whole server-side auto-expand cascade. The cascade
# can issue up to ~6 serial HAFAS calls (geometric 60→1440); at UPSTREAM_TIMEOUT
# (10s) each that is up to ~60s, which would blow past nginx's proxy_read_timeout
# (30s) and turn a slow HAFAS into a 504. This budget returns the best board
# gathered so far (200) instead. Read as a module attribute at call time so tests
# can monkeypatch it; kept < the nginx read timeout, > one full UPSTREAM_TIMEOUT so
# at least one attempt always fits.
_CASCADE_BUDGET_S = 14.0
_EXT_ID_RE = re.compile(r"^[0-9]{1,20}$")


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
    # Opt-in server-side auto-expand: when true, get_stationboard widens `dur`
    # geometrically (starting at `dur`) until the extId-scoped board has more than
    # `min_results` entries, and returns the settled window as `settledDur`.
    # Default false keeps the legacy single-fetch behaviour for every caller.
    auto_expand: bool = False
    # Stop the cascade once the extId-scoped entry count exceeds this. 0 means
    # "expand until any entry appears" (initial open); load-more passes the count
    # currently shown so the next window must reveal MORE. No upper bound: the
    # value only controls the early stop, the geometric ≤6 step ceiling bounds the
    # upstream fan-out.
    min_results: int = Field(default=0, ge=0)
    # Platform extId to scope the emptiness check to (mirrors the client's extId
    # filter, see _extid_scoped_count). Empty/non-numeric/oversized coerces to None
    # (fall back to a raw count) rather than 422 — the client sends "" for stops
    # without a platform id. Never enters the HAFAS envelope or the cache key.
    ext_id: str | None = None

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

    @field_validator("ext_id")
    @classmethod
    def _normalize_ext_id(cls, v: str | None) -> str | None:
        # Coerce anything that isn't a plausible numeric extId to None so a
        # missing/odd platform id degrades to a raw count instead of rejecting
        # the request.
        return v if v and _EXT_ID_RE.match(v) else None


def _extid_scoped_count(res: dict[str, Any], ext_id: str | None) -> int:
    """Count board entries at platform `ext_id`, mirroring the client's extId
    filter (static/ui.js renderDepartures, ~1808-1813). Falls back to the raw
    entry count when no ext_id is given or the ext_id isn't a distinct loc in this
    board (single-platform stop / unknown platform). Kept in sync with the client
    filter: if one side's extId handling changes, change both."""
    jny_l = res.get("jnyL", [])
    if not ext_id:
        return len(jny_l)
    loc_l = res.get("common", {}).get("locL", [])
    if not any(loc.get("extId") == ext_id for loc in loc_l):
        return len(jny_l)

    def _at_ext(j: dict[str, Any]) -> bool:
        loc_x = (j.get("stbStop") or {}).get("locX")
        return loc_x is not None and 0 <= loc_x < len(loc_l) and loc_l[loc_x].get("extId") == ext_id

    return sum(1 for j in jny_l if _at_ext(j))


async def _expand_stationboard(
    app: FastAPI,
    lid: str,
    board_type: str,
    start_dur: int,
    min_results: int,
    ext_id: str | None,
) -> tuple[dict[str, Any] | None, int | None]:
    """Server-side geometric auto-expand. Widens `dur` (start_dur, ×2, capped at
    1440) until the extId-scoped board has more than `min_results` entries, using
    the shared singleflight stationboard fetch so concurrent identical cascades and
    the SSE tick collapse onto one upstream call per window. Returns the best (last
    successful) board and the dur it was fetched at, or (None, None) if no fetch
    succeeded. `_CASCADE_BUDGET_S` bounds the whole walk so a slow HAFAS yields the
    best board so far instead of running into the nginx read timeout (504)."""
    best_res: dict[str, Any] | None = None
    best_dur: int | None = None
    d = start_dur
    try:
        async with asyncio.timeout(_CASCADE_BUDGET_S):
            while True:
                res = await _fetch_stationboard_for_subscriber(app, lid, board_type, d)
                if "error" in res:
                    break  # fail-securely: don't hammer a sick HAFAS with more steps
                best_res, best_dur = res, d  # remember every success, even an empty board
                if _extid_scoped_count(res, ext_id) > min_results:
                    break  # settled: the window now shows more than the client already had
                if d >= 1440:
                    break  # reached the max window
                d = min(d * 2, 1440)
    except TimeoutError:
        pass  # budget exhausted → return whatever board we gathered so far
    return best_res, best_dur


@app.post("/api/stationboard", response_model=None)
async def get_stationboard(
    request: Request, body: StationBoardRequest
) -> dict[str, Any] | JSONResponse:
    if not _rate_check_request(request, sub=None):
        return JSONResponse(
            status_code=429,
            content={"error": "rate_limit", "scope": "ip"},
            headers={"Retry-After": "1"},
        )

    if body.auto_expand:
        # Server-side cascade: one client request, the server widens the window
        # internally. Replaces the old client-side loop that fired up to 24 DEP +
        # 24 ARR requests and burst through the per-IP rate limit on quiet stops.
        best_res, best_dur = await _expand_stationboard(
            request.app, body.lid, body.type.value, body.dur, body.min_results, body.ext_id
        )
        if best_res is None:
            return JSONResponse(status_code=502, content={"error": "upstream"})
        # Shallow copy: settledDur must not leak into the shared cached/singleflight
        # object (it is served verbatim to the SSE tick and to later cache hits).
        return {**best_res, "settledDur": best_dur}

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
async def health(request: Request) -> dict[str, Any]:
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


@app.get("/api/line_search", response_model=None)
async def line_search(
    request: Request,
    q: str = Query(min_length=1, max_length=10),
) -> dict[str, Any] | JSONResponse:
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

    def __init__(
        self,
        path: Path,
        version: str,
        media_type: str,
        fallback_body: str,
        extra_headers: dict[str, str] | None = None,
        cache_control: str = "no-cache, no-store, must-revalidate",
    ):
        self.path = path
        self.media_type = media_type
        self.fallback_body = fallback_body
        self.extra_headers = extra_headers or {}
        self.cache_control = cache_control
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
            # A degraded error stub must never be stored or bf-cached: it would
            # pin the failure into the browser. The 200 path may relax caching
            # (see self.cache_control) but the 503 fallback always stays no-store.
            return Response(
                self.fallback_body,
                media_type=self.media_type,
                status_code=503,
                headers={"Cache-Control": no_cache},
            )
        headers = {"Cache-Control": self.cache_control}
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
    # The app shell carries no PII/secrets, so it is intentionally
    # storable-at-rest to unblock the browser back/forward cache. Dropping
    # only no-store (not no-cache) still forces revalidation on every
    # navigation. sw.js keeps the no-store default so a stale worker can
    # never be bf-cached.
    cache_control="no-cache, must-revalidate",
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
async def sse_stream(request: Request) -> Response:
    return await handle_sse_stream(request, _VERSION)


@app.post("/api/stream/viewport")
async def stream_viewport(request: Request) -> JSONResponse:
    return await handle_viewport(request)


@app.post("/api/stream/select")
async def stream_select(request: Request) -> JSONResponse:
    return await handle_select(request)


@app.get("/sw.js")
async def serve_sw() -> Response:
    return _sw_asset.response()


@app.get("/")
async def serve_root() -> Response:
    return _index_asset.response()


@app.get("/index.html")
async def serve_index() -> Response:
    return _index_asset.response()


# html=False — the explicit @app.get("/") and @app.get("/index.html") routes
# above own the index template (with __APP_VERSION__ substituted into the
# style.css URL). Leaving html=True here would let StaticFiles fall back to
# serving the raw template (placeholder intact) on any quirk that bypassed
# the explicit routes, silently breaking the cache-bust mechanism.
app.mount("/", StaticFiles(directory="static", html=False), name="static")
