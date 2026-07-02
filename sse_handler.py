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
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

import fanout
from audit import _audit
from caches import (
    _inflight,
    _inflight_journey,
    _inflight_stationboard,
    _journey_cache,
    _journey_cache_lock,
    _stationboard_cache,
    _stationboard_cache_lock,
    _JOURNEY_CACHE_TTL,
    _STATIONBOARD_CACHE_TTL,
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
    o.strip() for o in os.environ.get(
        "BUSRADAR_ALLOWED_ORIGINS",
        "https://busradar.pihaar.de,http://localhost:8000,http://127.0.0.1:8000",
    ).split(",") if o.strip()
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


def _lookup_subscriber(request: Request) -> tuple[Optional[fanout.Subscriber], Optional[str]]:
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


# Token-bucket for /api/stream POST endpoints. Two-layer protection:
# - per-Subscriber: 1/s refill, burst 3. Stops a single connection from
#   spamming its own session.
# - per-IP: 1/s refill, burst 10. Closes the cookie-rotation bypass where
#   one IP opens N subscribers (up to MAX_SUBSCRIBERS_PER_IP=20) and each
#   gets a fresh per-subscriber bucket (would otherwise allow 60 POSTs/s).
_post_rate_per_ip: dict[str, tuple[float, float]] = {}  # ip → (tokens, last_refill)
# Burst sized to absorb a legitimate "open stop, watch auto-expand walk to
# 24h" pulse without 429ing the user — the auto-expand on a quiet stop can
# fire ~24 cascading POSTs in a couple of seconds against /api/stationboard.
# Refill stays at 1 token/s so sustained rate is unchanged; the burst just
# pushes the cliff out far enough that the cascade fits.
# Env override (BUSRADAR_POST_RATE_BURST) is for the E2E suite, which
# replays ~20 pages from the same 127.0.0.1 in two minutes and would
# otherwise leave subsequent tests competing for an exhausted bucket.
_POST_RATE_PER_IP_BURST = float(os.environ.get("BUSRADAR_POST_RATE_BURST", "30"))
_POST_RATE_PER_IP_MAX_KEYS = 4096


def _post_rate_check(sub) -> bool:
    """Returns True if a POST is allowed. State is per-Subscriber so two
    different IPs / cookies have independent buckets."""
    now = time.monotonic()
    tokens = min(3.0, sub.post_rate_tokens + (now - sub.post_rate_last_refill))
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
    tokens = min(_POST_RATE_PER_IP_BURST, tokens + (now - last_refill))
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
    if sub is not None and not _post_rate_check(sub):
        return False
    return True


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
        fetch_fn=lambda: _proxy._hafas_call_via_app(app, "JourneyDetails", {"jid": jid, "getPolyline": True}),
    )


async def _fetch_stationboard_for_subscriber(app: FastAPI, lid: str, board_type: str = "DEP", dur: int = 60) -> dict:
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
        fetch_fn=lambda: _proxy._hafas_call_via_app(app, "StationBoard", {
            "stbLoc": {"lid": lid},
            "type": board_type,
            "dur": dur,
            "jnyFltrL": [{"type": "PROD", "mode": "INC", "value": "32"}],
        }),
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
    selection: Optional[fanout.Selection] = None

    @field_validator("selection")
    @classmethod
    def validate_selection(cls, v):
        if v is None:
            return None
        if isinstance(v, fanout.JourneySelection):
            if not JID_PATTERN.match(v.jid):
                raise ValueError("invalid jid")
        elif isinstance(v, fanout.StationSelection):
            if not LID_PATTERN.match(v.lid):
                raise ValueError("invalid lid")
        return v


# Selection→fetcher dispatch table. Single source of truth for adding new
# selection types — register here + add the Pydantic model in fanout.py and
# the SSE loop picks it up via type(sel).
async def _fetch_for_selection(app: FastAPI, sel: "fanout.Selection") -> tuple[str, dict]:
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
        return ("stationboard", {"lid": sel.lid, "boardType": sel.board_type, "stationboard": result})
    return (None, None)


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
                            fanout.tick_condition.wait_for(
                                lambda: fanout.tick_seq > local_seq
                            ),
                            timeout=keepalive,
                        )
                    local_seq = fanout.tick_seq
                    # Keep calibrator in ACTIVE_CALIB_INTERVAL (5min) mode.
                    client_activity.touch()
                except TimeoutError:
                    yield _format_keepalive()
                    continue

                # REPORT_ONLY: skip 2 of every 3 push cycles. HAFAS's real
                # GPS position only refreshes every ~30 s, so emitting on
                # every 10 s SSE push would re-send identical payloads and
                # spend HAFAS budget on nothing. Anchored to fanout.push_seq
                # (only incremented by sse_push_loop's fire_push_tick, not
                # by handle_viewport's fire_tick) — this keeps the 3:1 skip
                # pattern deterministic even when other users' viewport
                # POSTs wake the stream in between pushes. last_emitted_push_seq
                # starts as None so the first tick after subscribe (or after
                # a posMode toggle) always emits.
                if sub.pos_mode == "REPORT_ONLY":
                    now_push = fanout.push_seq
                    last = sub.last_emitted_push_seq
                    if last is not None and (now_push - last) < 3:
                        continue
                    sub.last_emitted_push_seq = now_push

                # New tick. Fetch vehicles + detail (if a selection is set)
                # in parallel so per-tick wall-clock is max(latencies), not
                # sum. asyncio.gather with return_exceptions keeps a detail
                # fetch failure from killing the vehicles emit and vice versa.
                sel = sub.selection
                sel_seq_at_start = sub.selection_seq

                tasks: list = []
                tasks.append(
                    _fetch_vehicles_for_viewport(request.app, sub.viewport, sub.pos_mode)
                    if sub.viewport else _noop_async(None)
                )
                tasks.append(
                    _fetch_for_selection(request.app, sel)
                    if sel is not None else _noop_async(None)
                )

                results = await asyncio.gather(*tasks, return_exceptions=True)
                snap, detail_res = results[0], results[1]

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
                if sel is not None and sub.selection_seq == sel_seq_at_start and sub.selection == sel:
                    if isinstance(detail_res, Exception):
                        yield _format_sse("error", {"reason": "upstream", "selection": sel.event_name()})
                    elif isinstance(detail_res, tuple):
                        event_name, payload = detail_res
                        if event_name:
                            yield _format_sse(event_name, payload)

                # Always emit `connected` after a tick (coalesces with any
                # add/remove that happened during this loop iteration).
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
    if err:
        return _err_response(err)

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
    if posmode_changed:
        # Reset the REPORT_ONLY skip anchor so a mode switch (either
        # direction) surfaces immediately: last_emitted_push_seq=None means
        # "next push always emits", regardless of where the global push_seq
        # sits. The skip pattern re-anchors from that emit.
        sub.last_emitted_push_seq = None
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
    # via last_emitted_push_seq=None above; the next natural push (≤10s)
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
    if err:
        return _err_response(err)

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
