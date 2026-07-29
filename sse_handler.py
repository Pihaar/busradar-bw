"""
Busradar BW — SSE stream handler + sidecar POST endpoints.

Owns:
* The `event_generator` async generator that powers `/api/stream/`.
* Sidecar POST handlers: `handle_viewport`, `handle_select`.
* SSE-specific helpers: format/keepalive/body-limit/origin/IP/rate-check.
* SSE-specific Pydantic models: `ViewportPayload`, `SelectPayload`.
* Fetch helpers: vehicles-for-viewport, journey-for-subscriber,
  stationboard-for-subscriber, and the selection dispatch table.

Direction: imports hafas, caches, audit, fanout. proxy.py wires routes to
the handlers here. To avoid a back-edge, `_flatten_vehicles` is imported
lazily inside `_fetch_vehicles_for_viewport`.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import random
import secrets
import time
from datetime import datetime

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

import fanout
from audit import _audit
from caches import (
    _JOURNEY_CACHE_TTL,
    _STATIONBOARD_CACHE_TTL,
    _follow_geopos_cache,
    _follow_geopos_lock,
    _inflight,
    _inflight_follow_geopos,
    _inflight_journey,
    _inflight_stationboard,
    _journey_cache,
    _journey_cache_lock,
    _stationboard_cache,
    _stationboard_cache_lock,
    cached_singleflight,
)
from hafas import (
    JID_PATTERN,
    LID_PATTERN,
)
from tick import ClientActivity

log = logging.getLogger("busradar")


# === SSE Stream ===

ALLOWED_ORIGINS = tuple(
    o.strip()
    for o in os.environ.get(
        "BUSRADAR_ALLOWED_ORIGINS",
        "https://busradar.pihaar.de,http://localhost:8000,http://127.0.0.1:8000",
    ).split(",")
    if o.strip()
)
# `__Host-` cookie prefix enforces three browser-side invariants:
#   1. Secure attribute set (TLS only)
#   2. No Domain attribute (so no subdomain shadowing)
#   3. Path=/
# In return: a subdomain attacker (e.g. evil.pihaar.de) cannot shadow this
# cookie via Set-Cookie on the parent domain. With a single-domain deploy
# this is defense-in-depth; if a sibling subdomain is ever added it becomes
# load-bearing. The trade-off: Path=/ widens the scope so the cookie travels
# on every same-origin request (HttpOnly + SameSite=Strict keep it from
# meaningful leakage). The dev fallback (BUSRADAR_COOKIE_SECURE=0) drops the
# __Host- prefix because plain-HTTP `__Host-`-cookies are dropped by browsers.
SSE_COOKIE_PATH = "/"
SSE_COOKIE_SECURE = os.environ.get("BUSRADAR_COOKIE_SECURE", "1") != "0"
SSE_COOKIE_NAME = "__Host-busradar_sse" if SSE_COOKIE_SECURE else "busradar_sse"
# Protocol version for the SSE event contract. Bumped when an event name,
# event payload shape, or POST-endpoint contract changes incompatibly.
# The client receives this in the `subscribe` event payload and surfaces
# a terminal banner immediately on mismatch — without waiting for the
# next appVersion change (which only fires after a deploy).
SSE_PROTOCOL_VERSION = "1"

SSE_KEEPALIVE_MIN = 12.0
SSE_KEEPALIVE_MAX = 18.0
SSE_BODY_LIMIT = 1024  # POST viewport / select payloads stay small
# Backpressure: if a single yield batch to the client takes longer than this,
# count a slow-consumer drop. The threshold is intentionally generous because
# the wall-clock measurement conflates client TCP backpressure with event-loop
# scheduling delay (other subscribers competing for the loop). False positives
# at 10s under load were possible; raise to 20s for production headroom.
# `SLOW_CONSUMER_DROP_THRESHOLD` in fanout.py (=5) governs the consecutive
# count before disconnect.
SSE_SLOW_YIELD_THRESHOLD_S = 20.0


# Singleton wired by proxy.py during module init so this module shares the
# same `client_activity` instance the tick calibrator uses.
client_activity = ClientActivity()


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


def _format_sse(event: str | None, data: dict) -> str:
    """Serialize one SSE message. `event` may be None for default 'message',
    `data` is always JSON-encoded so the client side parses uniformly.
    Last-Event-ID is intentionally not supported — every reconnect is a
    fresh subscriber, so no id: field is emitted."""
    parts: list[str] = []
    if event:
        parts.append(f"event: {event}")
    parts.append("data: " + json.dumps(data, separators=(",", ":")))
    parts.append("")
    parts.append("")
    return "\n".join(parts)


async def _noop_async(value):
    """asyncio.gather() requires actual coroutines; this returns the constant
    value so the parallel fetch shape stays clean when no fetch is needed."""
    return value


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
    # Late import to keep `_flatten_vehicles` in proxy.py while avoiding the
    # proxy → sse_handler → proxy cycle at module load. Also routes the HAFAS
    # call through the proxy module so test patches on `proxy._hafas_call_via_app`
    # reach this call site.
    import proxy as _proxy

    _flatten_vehicles = _proxy._flatten_vehicles

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
        except asyncio.CancelledError:
            # Piggybacker's own task is being cancelled — propagate. Don't
            # touch _inflight; the originator (or its own cancellation path)
            # owns cleanup.
            raise
        except Exception:
            # Originator's future errored. Don't piggyback; fall through and
            # start our own fetch under the same key. Identity-compare on
            # pop: only remove the failed future if it's still the one
            # we observed. A new coroutine could have replaced it; without
            # this guard we'd silently evict the new owner's entry.
            if _inflight.get(key) is existing:
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
        res = await _proxy._hafas_call_via_app(app, "JourneyGeoPos", hafas_req)
        if "error" in res:
            out = {"error": res["error"]}
        else:
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
        # Identity-compare: only remove if `_inflight[key]` is still OUR
        # future. A racing originator that won the next slot must not be
        # silently evicted.
        if _inflight.get(key) is fut:
            _inflight.pop(key, None)


def _lookup_subscriber(request: Request) -> tuple[fanout.Subscriber | None, str | None]:
    """Common subscriber-lookup for the sidecar POST endpoints.

    Returns (sub, error_code) where error_code is one of:
      None — sub is valid
      'missing_cookie' — no cookie at all → 401
      'unknown_connection' — cookie present but subscriber gone → 409
      'origin_mismatch' — Origin header check failed → 403
    """
    if not _check_origin(request):
        _audit(
            "origin-mismatch",
            _client_ip(request),
            origin=request.headers.get("Origin", "<missing>"),
        )
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


# Token-bucket for /api/stream POST endpoints. Two-layer protection:
# - per-Subscriber: 5/s refill, burst 15. Stops a single connection from
#   spamming its own session. This is the layer that 429'd normal map
#   panning (old burst 3 / 1-per-s → the 4th quick pan got a 429); at
#   burst 15 / 5-per-s it comfortably clears the ~4 POSTs/s ceiling the
#   250ms viewport debounce allows while still capping a spam loop.
# - per-IP: 6/s refill, burst 40. Closes the cookie-rotation bypass (one
#   IP, up to MAX_SUBSCRIBERS_PER_IP=20 subscribers, each with its own
#   per-sub bucket). This bucket is shared across /viewport, /select,
#   /journey and /stationboard, so it also caps HAFAS-costly stationboard
#   POST-spam — hence kept tighter than the per-sub layer. Burst 40
#   absorbs the auto-expand cascade (up to ~24 /stationboard POSTs in a
#   couple seconds) plus concurrent panning.
#
# Upstream (HAFAS) vehicle-fanout cost is separately bounded by the GLOBAL
# fire_tick token bucket (2/s) + singleflight, so accepted viewport POSTs
# can't amplify to HAFAS regardless of these limits.
_post_rate_per_ip: dict[str, tuple[float, float]] = {}  # ip → (tokens, last_refill)
# Env override (BUSRADAR_POST_RATE_BURST) is for the E2E suite, which
# replays ~20 pages from the same 127.0.0.1 in two minutes.
_POST_RATE_PER_IP_BURST = float(os.environ.get("BUSRADAR_POST_RATE_BURST", "40"))
_POST_RATE_PER_IP_REFILL = 6.0  # tokens/s
_POST_RATE_SUB_BURST = 15.0
_POST_RATE_SUB_REFILL = 5.0  # tokens/s
_POST_RATE_PER_IP_MAX_KEYS = 4096


def _post_rate_check(sub) -> bool:
    """Returns True if a POST is allowed. State is per-Subscriber so two
    different IPs / cookies have independent buckets."""
    now = time.monotonic()
    tokens = min(
        _POST_RATE_SUB_BURST,
        sub.post_rate_tokens + (now - sub.post_rate_last_refill) * _POST_RATE_SUB_REFILL,
    )
    sub.post_rate_last_refill = now
    if tokens >= 1.0:
        sub.post_rate_tokens = tokens - 1.0
        return True
    sub.post_rate_tokens = tokens
    return False


def _post_rate_check_ip(ip: str) -> bool:
    """Returns True if a POST from this IP is allowed under the per-IP cap.
    Defends against cookie-rotation attacks where one IP holds 20 subscribers
    and would otherwise get 60 POSTs/s (3 × 20 burst) across them.

    `ip` should already be canonicalized (IPv4 stays, IPv6 collapses to /64)
    so an attacker with a routed /64 sees one bucket, not 2^64."""
    if not ip:
        # Empty IP means request.client was None (unix socket, misconfigured
        # trusted-proxy header stripping). Deny by default — allowing was
        # an amplification loophole: an attacker who could route through
        # such a proxy would collapse to a single unrated bucket and bypass
        # the per-IP cap entirely (white-hat PIV finding).
        return False
    now = time.monotonic()
    # Eviction first — if we're at the keyspace cap, drop the oldest entry
    # BEFORE inserting the new one. The previous shape ran eviction only in
    # the accept branch, so an attacker who rotates IPs through the deny
    # path could grow the dict past the cap.
    if len(_post_rate_per_ip) >= _POST_RATE_PER_IP_MAX_KEYS and ip not in _post_rate_per_ip:
        try:
            oldest = next(iter(_post_rate_per_ip))
            _post_rate_per_ip.pop(oldest, None)
        except StopIteration:
            pass
    bucket = _post_rate_per_ip.get(ip)
    if bucket is None:
        tokens, last_refill = _POST_RATE_PER_IP_BURST, now
    else:
        tokens, last_refill = bucket
    tokens = min(_POST_RATE_PER_IP_BURST, tokens + (now - last_refill) * _POST_RATE_PER_IP_REFILL)
    if tokens >= 1.0:
        _post_rate_per_ip[ip] = (tokens - 1.0, now)
        return True
    _post_rate_per_ip[ip] = (tokens, now)
    return False


def _rate_check_request(request: Request, sub=None) -> bool:
    """Combined per-IP + per-subscriber rate-check for a POST. The IP is
    canonicalized so an IPv6 attacker with a routed /64 doesn't get 2^64
    fresh buckets. When `sub` is None (legacy unauth endpoints) only the
    per-IP gate runs."""
    ip = fanout.canonicalize_ip(_client_ip(request))
    if not _post_rate_check_ip(ip):
        return False
    return sub is None or _post_rate_check(sub)


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


async def _fetch_journey_for_subscriber(app: FastAPI, jid: str) -> dict:
    """Shared HAFAS journey fetch with cache. Singleflight collapses concurrent
    fetches for the same jid across subscribers onto a single upstream call."""
    # Resolve `_hafas_call_via_app` via the proxy module so that tests
    # patching `proxy._hafas_call_via_app` reach this call site too.
    import proxy as _proxy

    return await cached_singleflight(
        cache=_journey_cache,
        lock=_journey_cache_lock,
        inflight=_inflight_journey,
        key=jid,
        ttl=_JOURNEY_CACHE_TTL,
        evict_at=200,
        evict_keep=100,
        fetch_fn=lambda: _proxy._hafas_call_via_app(
            app, "JourneyDetails", {"jid": jid, "getPolyline": True}
        ),
    )


async def _fetch_stationboard_for_subscriber(
    app: FastAPI, lid: str, board_type: str = "DEP", dur: int = 60
) -> dict:
    """Shared HAFAS stationboard fetch with cache. Singleflight by
    (lid, board_type, dur) so concurrent subscribers for the same stop and
    side share whenever they want the same window. ARR pushes are enabled
    via the StationSelection discriminator field on the SSE side; the legacy
    POST endpoint uses DEP with dur=60."""
    import proxy as _proxy

    cache_key = (lid, board_type, dur)
    return await cached_singleflight(
        cache=_stationboard_cache,
        lock=_stationboard_cache_lock,
        inflight=_inflight_stationboard,
        key=cache_key,
        ttl=_STATIONBOARD_CACHE_TTL,
        evict_at=500,
        evict_keep=250,
        fetch_fn=lambda: _proxy._hafas_call_via_app(
            app,
            "StationBoard",
            {
                "stbLoc": {"lid": lid},
                "type": board_type,
                "dur": dur,
                "jnyFltrL": [{"type": "PROD", "mode": "INC", "value": "32"}],
            },
        ),
    )


class SelectPayload(BaseModel):
    """Client tells the server which journey or stationboard the subscriber
    currently wants pushed on every tick. The `selection` is a discriminated
    union over `fanout.Selection`, or `null` to clear.

    Wire format:
        {"selection": {"kind": "journey", "jid": "..."}}
        {"selection": {"kind": "stationboard", "lid": "A=1@L=..."}}
        {"selection": null}
    """

    model_config = ConfigDict(extra="forbid")
    selection: fanout.Selection | None = None

    @field_validator("selection")
    @classmethod
    def validate_selection(cls, v):
        if v is None:
            return None
        if isinstance(v, fanout.JourneySelection) and not JID_PATTERN.match(v.jid):
            raise ValueError("invalid jid")
        if isinstance(v, fanout.StationSelection) and not LID_PATTERN.match(v.lid):
            raise ValueError("invalid lid")
        return v


# Selection→fetcher dispatch table. Single source of truth for adding new
# selection types — register here + add the Pydantic model in fanout.py and
# the SSE loop picks it up via type(sel).
async def _fetch_for_selection(app: FastAPI, sel: fanout.Selection) -> tuple[str, dict]:
    """Run the right HAFAS fetch for `sel` and return (event_name, payload).
    On upstream error returns ("error", {...}) so the caller can emit a
    sanitized error event without leaking taxonomy."""
    if isinstance(sel, fanout.JourneySelection):
        result = await _fetch_journey_for_subscriber(app, sel.jid)
        if "error" in result:
            return ("error", {"reason": "upstream", "selection": "journey"})
        return ("journey", {"jid": sel.jid, "journey": result})
    if isinstance(sel, fanout.StationSelection):
        result = await _fetch_stationboard_for_subscriber(app, sel.lid, sel.board_type, sel.dur)
        if "error" in result:
            return ("error", {"reason": "upstream", "selection": "stationboard"})
        return (
            "stationboard",
            {"lid": sel.lid, "boardType": sel.board_type, "stationboard": result},
        )
    return (None, None)


_FOLLOW_RING_M = 3000  # ring radius for the REPORT_ONLY off-ring follow lookup
_FOLLOW_QUANTIZE = 5000  # ~0.005 deg grid for the follow-lookup cache key
_FOLLOW_GEOPOS_TTL = 8.0  # short TTL: real GPS updates ~30s; caps re-fetch + dedups followers


async def _real_pos_for_offring_follow(app, jid, detail_res, snap):
    """REPORT_ONLY follow: JourneyDetails only returns an INTERPOLATED position.
    When the followed bus is OUTSIDE the viewport ring (so its real GPS position
    isn't in `snap`, the viewport vehicles payload), do one small REPORT_ONLY
    JourneyGeoPos centered on the interpolated position and splice the bus's
    REAL position into the journey payload, so the client's follow-pan chases
    the real bus off-screen instead of the interpolated estimate.

    The lookup goes through `cached_singleflight` keyed on the QUANTIZED ring
    center, so concurrent followers of nearby off-ring buses collapse onto one
    upstream call and re-fetch is capped by the short TTL — the follow path must
    not escape the dedup the viewport/journey paths rely on.

    Returns detail_res unchanged (NO position splice) when the bus is already in
    `snap` (real position already delivered via vehicles), when there is no
    interpolated center to search around (journey ended / not started), or when
    the GeoPos lookup fails / the bus currently reports no GPS position. Never
    mutates the shared/cached journey dict — the real position is spliced into a
    shallow copy."""
    vehicles = snap.get("vehicles", []) if isinstance(snap, dict) else []
    if any(v.get("jid") == jid for v in vehicles):
        return detail_res  # in-ring: the real position already reached the client

    result = detail_res[1].get("journey") or {}
    jny = result.get("journey") or {}
    pos = jny.get("pos") or {}
    cx, cy = pos.get("x"), pos.get("y")
    if not cx or not cy:
        return detail_res  # no interpolated center (journey ended / not started)

    # Query the deterministic cell center so the cached result is valid for any
    # follower whose interpolated position quantizes to the same cell.
    qx = round(cx / _FOLLOW_QUANTIZE) * _FOLLOW_QUANTIZE
    qy = round(cy / _FOLLOW_QUANTIZE) * _FOLLOW_QUANTIZE

    import proxy as _proxy

    async def _fetch():
        return await _proxy._hafas_call_via_app(
            app,
            "JourneyGeoPos",
            {
                "ring": {"cCrd": {"x": qx, "y": qy}, "maxDist": _FOLLOW_RING_M},
                "perSize": 120,
                "perStep": 10,
                "jnyFltrL": [{"type": "PROD", "mode": "INC", "value": "32"}],
                "trainPosMode": "REPORT_ONLY",
            },
        )

    try:
        geo = await cached_singleflight(
            cache=_follow_geopos_cache,
            lock=_follow_geopos_lock,
            inflight=_inflight_follow_geopos,
            key=(qx, qy),
            ttl=_FOLLOW_GEOPOS_TTL,
            evict_at=200,
            evict_keep=100,
            fetch_fn=_fetch,
        )
    except Exception:
        return detail_res
    if not isinstance(geo, dict) or "error" in geo:
        return detail_res

    match = next((j for j in geo.get("jnyL", []) if j.get("jid") == jid), None)
    real = match.get("pos") if match else None
    if not real or not real.get("x") or not real.get("y"):
        return detail_res  # bus reports no GPS right now → keep the interpolated pos

    new_jny = dict(jny)
    new_jny["pos"] = {"x": real["x"], "y": real["y"]}
    new_result = dict(result)
    new_result["journey"] = new_jny
    return ("journey", {**detail_res[1], "journey": new_result})


def _report_only_should_emit(now_tick_push: int, last: int | None) -> bool:
    """REPORT_ONLY emit gate. Emit only when a tick-aligned push has happened
    since this subscriber's last emit (`now_tick_push != last`), or on the very
    first push for the subscriber (`last is None`). A non-tick-aligned push
    (CALC intra-cycle fire) or a viewport-POST wake (fire_tick) leaves
    `tick_push_seq` unchanged → `now == last` → skip. Extracted so the gate
    decision is unit-tested directly rather than mirrored in a test."""
    return last is None or now_tick_push != last


async def handle_sse_stream(request: Request, app_version: str):
    """SSE endpoint handler. Subscribers receive `vehicles` events whenever a
    HAFAS tick is detected, plus `connected` count updates and `:keepalive`
    comments. State changes (viewport, selection) come in via the sidecar
    POST endpoints, identified by an HttpOnly cookie set on this first
    GET response. Connection-id is never written to JS or to access_log.
    Last-Event-ID is deliberately ignored — every reconnect is a fresh
    subscriber with a fresh state. The browser auto-reconnects on drop."""

    # Cross-origin embeds (<img src>, <link rel=preload>, no-cors fetch) can
    # otherwise open a connection-slot from a victim's IP without the
    # attacker being able to read the body. SameSite=Strict doesn't help
    # here because we're SETTING the cookie on this response, not reading
    # one. Browsers send Sec-Fetch-Site on every request; legitimate
    # same-origin SSE has `same-origin`, attacker iframes have `cross-site`.
    fetch_site = request.headers.get("Sec-Fetch-Site")
    if fetch_site is not None and fetch_site not in ("same-origin", "none"):
        # `none` covers direct navigation / curl. `same-origin` is the
        # browser case. Anything else (cross-site, cross-origin, same-site)
        # is rejected; legitimate clients don't hit this branch.
        _audit("cross-origin-stream", _client_ip(request), fetch_site=fetch_site)
        return JSONResponse(status_code=403, content={"error": "cross_origin"})

    # Defense-in-depth: if Origin is present, it MUST be in the allow-list.
    # Missing Origin is OK (curl, direct nav, browsers omit it for top-level
    # GETs without referrer policy). This catches header-stripping intermediaries
    # that drop Sec-Fetch-Site but preserve Origin.
    origin = request.headers.get("Origin")
    if origin is not None and origin not in ALLOWED_ORIGINS:
        _audit("origin-mismatch", _client_ip(request), origin=origin)
        return JSONResponse(status_code=403, content={"error": "origin_mismatch"})

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
    # Tick calibrator drops to IDLE_CALIB_INTERVAL=30min when no client
    # activity is recorded. Mark this subscriber as active so the
    # calibrator keeps probing at the 5min rate — and crucially, keep
    # marking it active as long as the SSE stream is open, not just
    # while ticks are being detected (HAFAS sometimes goes minutes
    # without position changes; without this, the calibrator went idle
    # and stopped probing entirely, freezing the live view).
    client_activity.subscriber_joined()

    async def event_generator():
        try:
            # First event: client knows the stream is live + the app version
            # + the SSE protocol version (incremented on incompatible changes).
            yield _format_sse(
                "subscribe",
                {
                    "tickSeq": fanout.tick_seq,
                    "appVersion": app_version,
                    "protocol": SSE_PROTOCOL_VERSION,
                },
            )
            # Emit current connected count up front so the UI doesn't wait
            # up to 30s (one HAFAS tick) before showing it.
            yield _format_sse("connected", {"count": len(fanout.registry)})

            local_seq = fanout.tick_seq
            last_connected_count = len(fanout.registry)

            while True:
                # Wait either for a new tick or, in absence of one, for a
                # randomized keepalive interval. asyncio.wait_for raises
                # TimeoutError, which is the keepalive signal.
                keepalive = random.uniform(SSE_KEEPALIVE_MIN, SSE_KEEPALIVE_MAX)
                try:
                    async with fanout.tick_condition:
                        await asyncio.wait_for(
                            # B023: the lambda is consumed synchronously inside this
                            # iteration (before local_seq is reassigned below), so it
                            # captures the current value — no deferred-closure bug.
                            fanout.tick_condition.wait_for(lambda: fanout.tick_seq > local_seq),  # noqa: B023
                            timeout=keepalive,
                        )
                    local_seq = fanout.tick_seq
                    # Keep calibrator in ACTIVE_CALIB_INTERVAL (5min) mode.
                    client_activity.touch()
                except TimeoutError:
                    yield _format_keepalive()
                    continue

                # Connected-count is emitted on EVERY tick wake (~10s),
                # before the REPORT_ONLY skip below — otherwise in "Nur GPS"
                # mode the counter only refreshed on the 1-in-3 emitted tick
                # (~30s lag when someone joins/leaves). It's a tiny event and
                # only fires when the count actually changed.
                count = len(fanout.registry)
                if count != last_connected_count:
                    last_connected_count = count
                    yield _format_sse("connected", {"count": count})

                # REPORT_ONLY: emit only on a push that sse_push_loop aligned
                # to the HAFAS GPS tick. Real GPS refreshes every ~30 s, so a
                # 10 s push that isn't tick-aligned would re-send an identical
                # payload and spend HAFAS budget on nothing. Anchored to
                # fanout.tick_push_seq (bumped only by a tick-aligned
                # fire_push_tick, NOT by handle_viewport's fire_tick) — so the
                # emit lands right after the upstream refresh and other users'
                # viewport POSTs don't shift this sub's cadence.
                # last_emitted_tick_push_seq starts as None so the first tick
                # after subscribe (or after a posMode toggle) always emits.
                if sub.pos_mode == "REPORT_ONLY":
                    now_tick_push = fanout.tick_push_seq
                    if not _report_only_should_emit(now_tick_push, sub.last_emitted_tick_push_seq):
                        continue
                    sub.last_emitted_tick_push_seq = now_tick_push

                # New tick. Fetch vehicles + detail (if a selection is set)
                # in parallel so per-tick wall-clock is max(latencies), not
                # sum. asyncio.gather with return_exceptions keeps a detail
                # fetch failure from killing the vehicles emit and vice versa.
                sel = sub.selection
                sel_seq_at_start = sub.selection_seq

                tasks: list = []
                tasks.append(
                    _fetch_vehicles_for_viewport(request.app, sub.viewport, sub.pos_mode)
                    if sub.viewport
                    else _noop_async(None)
                )
                tasks.append(
                    _fetch_for_selection(request.app, sel) if sel is not None else _noop_async(None)
                )

                results = await asyncio.gather(*tasks, return_exceptions=True)
                snap, detail_res = results[0], results[1]

                # In REPORT_ONLY, splice the followed bus's REAL GPS position
                # into the journey payload when it is off the viewport ring
                # (one extra GeoPos, only in that case), so follow-bus tracks
                # the real position off-screen instead of the interpolated one.
                # Done here, BEFORE yield_start, so this upstream await isn't
                # charged to the slow-consumer backpressure window; the
                # selection-seq guard below then re-checks after the await.
                if (
                    sub.pos_mode == "REPORT_ONLY"
                    and isinstance(sel, fanout.JourneySelection)
                    and isinstance(detail_res, tuple)
                    and detail_res[0] == "journey"
                ):
                    detail_res = await _real_pos_for_offring_follow(
                        request.app, sel.jid, detail_res, snap
                    )

                # Wall-clock from here on measures the time the framework
                # spent flushing yields to the client. A blocked socket-send
                # under TCP zero-window pressure inflates this; ≥5 consecutive
                # slow batches kicks the subscriber off so the task can't be
                # pinned forever by a misbehaving consumer.
                yield_start = time.monotonic()

                # Emit vehicles first (the map updates fastest).
                if sub.viewport:
                    if isinstance(snap, Exception):
                        yield _format_sse(
                            "error",
                            {"reason": "upstream", "stale": True},
                        )
                    elif isinstance(snap, dict) and "error" in snap:
                        # Map all HAFAS-bucketed error codes to one opaque
                        # client-facing reason (SEC-236: don't leak internal
                        # state taxonomy via differential responses).
                        yield _format_sse(
                            "error",
                            {"reason": "upstream", "stale": True},
                        )
                    elif isinstance(snap, dict):
                        yield _format_sse("vehicles", snap)

                # Detail-panel push. Selection-seq guard discards stale fetch
                # results for a selection the user has already swapped away
                # from. Dispatch happens via _fetch_for_selection() which
                # returns (event_name, payload) or ("error", ...).
                if (
                    sel is not None
                    and sub.selection_seq == sel_seq_at_start
                    and sub.selection == sel
                ):
                    if isinstance(detail_res, Exception):
                        yield _format_sse(
                            "error", {"reason": "upstream", "selection": sel.event_name()}
                        )
                    elif isinstance(detail_res, tuple):
                        event_name, payload = detail_res
                        if event_name:
                            yield _format_sse(event_name, payload)

                # Always emit `connected` after a tick (coalesces with any
                # add/remove that happened during this loop iteration).
                # NOTE: the primary connected-count emit now happens before
                # the REPORT_ONLY skip above (so the counter isn't 30s-laggy
                # in "Nur GPS"). This second check catches a count change
                # that occurred between that emit and the end of this
                # (non-skipped) iteration — cheap and only fires on change.
                count = len(fanout.registry)
                if count != last_connected_count:
                    last_connected_count = count
                    yield _format_sse("connected", {"count": count})

                # Slow-consumer backpressure detection. If the batch of yields
                # above took longer than the threshold, the client TCP buffer
                # was likely full; count a drop. Resets on every successful
                # fast batch so transient blips don't accumulate.
                if (time.monotonic() - yield_start) > SSE_SLOW_YIELD_THRESHOLD_S:
                    sub.consecutive_drops += 1
                else:
                    sub.consecutive_drops = 0

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
            try:
                client_activity.subscriber_left()
            except Exception:
                log.exception("[sse] subscriber_left failed for cid")
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


async def handle_viewport(request: Request):
    """Update the viewport the subscriber's next tick should fetch."""
    raw = await _read_body_with_limit(request, SSE_BODY_LIMIT)
    if raw is None:
        _audit("body-too-large", _client_ip(request))
        return _err_response("body_too_large")

    sub, err = _lookup_subscriber(request)
    if err or sub is None:
        # sub is non-None whenever err is None; the extra check narrows for mypy.
        return _err_response(err or "unknown_connection")

    if not _rate_check_request(request, sub):
        return JSONResponse(
            status_code=429,
            content={"error": "rate_limit", "scope": "subscriber"},
            headers={"Retry-After": "1"},
        )

    try:
        payload = ViewportPayload.model_validate_json(raw)
    except Exception:
        return JSONResponse(status_code=422, content={"error": "invalid_payload"})

    new_bbox = (payload.swLat, payload.swLon, payload.neLat, payload.neLon)
    new_quantized = fanout.quantize_bbox(new_bbox)
    bbox_changed = sub.last_viewport_bbox != new_quantized
    posmode_changed = sub.pos_mode != payload.posMode
    sub.viewport = new_bbox
    if bbox_changed or posmode_changed:
        # Reset the REPORT_ONLY skip anchor so this explicit user action
        # (pan/zoom or mode switch) emits on the very next wake instead of
        # waiting for the next tick-aligned push. last_emitted_tick_push_seq
        # is anchored to the global tick_push_seq, which fire_tick() below does
        # NOT bump — so without this reset a pan in REPORT_ONLY woke the
        # loop but the skip gate (no tick_push_seq advance) suppressed the emit,
        # and the new viewport's buses only appeared on the next tick-aligned
        # push. None means "next wake always emits", then it re-anchors.
        sub.last_emitted_tick_push_seq = None
    sub.pos_mode = payload.posMode
    sub.last_viewport_bbox = new_quantized

    # Probe the viewport-cardinality inflection point. One-shot warning when
    # the registry holds enough distinct quantized bboxes that singleflight
    # cache collapsing stops being effective.
    fanout.registry.maybe_warn_viewport_inflection()

    # Only wake the loop if the user actually changed something we'd refetch
    # for. fire_tick() is a global broadcast — without this guard, every
    # redundant viewport POST (e.g. browser firing moveend at sub-quantize
    # precision) would wake every subscriber on the box. A posMode-only
    # change does NOT wake — the sub itself has already been re-anchored
    # via last_emitted_tick_push_seq=None above; the next natural push (≤10s)
    # will emit their new-mode data. Broadcasting on posMode toggle would
    # amplify one user's UI action into 500 subscriber wake-ups + fetches
    # (white-hat PIV finding).
    if bbox_changed:
        await fanout.fire_tick()
    return JSONResponse(content={"ok": True})


async def handle_select(request: Request):
    """Tag a subscriber with a current journey or stationboard. The SSE loop
    then ships journey/stationboard events on every tick alongside vehicles
    until the subscriber selects 'none' or disconnects."""
    raw = await _read_body_with_limit(request, SSE_BODY_LIMIT)
    if raw is None:
        _audit("body-too-large", _client_ip(request))
        return _err_response("body_too_large")

    sub, err = _lookup_subscriber(request)
    if err or sub is None:
        # sub is non-None whenever err is None; the extra check narrows for mypy.
        return _err_response(err or "unknown_connection")

    if not _rate_check_request(request, sub):
        return JSONResponse(
            status_code=429,
            content={"error": "rate_limit", "scope": "subscriber"},
            headers={"Retry-After": "1"},
        )

    try:
        payload = SelectPayload.model_validate_json(raw)
    except ValidationError as e:
        # Audit-tag by inspecting Pydantic's structured error locations.
        loc_fields = {str(loc) for err_dict in e.errors() for loc in err_dict.get("loc", ())}
        # Discriminated-union failure paths surface their tag in the loc.
        if any("journey" in loc or "jid" in loc for loc in loc_fields):
            _audit("invalid-jid", _client_ip(request))
        elif any("stationboard" in loc or "lid" in loc for loc in loc_fields):
            _audit("invalid-lid", _client_ip(request))
        return JSONResponse(status_code=422, content={"error": "invalid_payload"})
    except Exception:
        return JSONResponse(status_code=422, content={"error": "invalid_payload"})

    new_selection = payload.selection  # already a JourneySelection / StationSelection / None

    # Fast-path: identical re-selection (e.g. user clicked the same bus again)
    # changes nothing. Skip the seq bump so the SSE loop's staleness guard
    # doesn't discard the next tick's in-flight fetch.
    if sub.selection == new_selection:
        return JSONResponse(content={"ok": True})

    sub.selection = new_selection
    # Monotonic counter the SSE loop checks against to discard fetch results
    # that complete after the user has swapped selection. Simple += is safe
    # because there is no `await` between read and write in this handler.
    sub.selection_seq += 1
    # No fire_tick() — it's a global broadcast for one user's panel-toggle.
    # The next natural HAFAS tick (≤30s) ships the selection; the client's
    # one-off fetch on panel-open covers the immediate-feedback case.
    return JSONResponse(content={"ok": True})
