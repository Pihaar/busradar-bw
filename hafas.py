"""
Busradar BW — HAFAS upstream client.

Owns the HAFAS envelope builder, circuit breaker, and the single async entry
point `_hafas_call_via_app` that every other module funnels through. The HAFAS
connection values themselves come from busradar_config (env), not from this
module. Also exports the validated JID/LID patterns.

Direction: this module's only app-internal import is busradar_config (a leaf
config module with no app imports); caches, sse_handler, and proxy depend on it.
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any, cast

import httpx
from fastapi import FastAPI

import busradar_config

# HAFAS connection values (endpoint, AID, client, ext, ver) are NOT hardcoded
# here — they come from busradar_config (env / systemd EnvironmentFile) so a
# checkout/package ships without them. The former module-level names remain
# available as lazy attributes via __getattr__ for backward compatibility with
# importers (proxy re-exports them; tests read hafas.AUTH_AID).
_CONFIG_ATTRS: dict[str, tuple[str, ...]] = {
    "HAFAS_ENDPOINT": ("endpoint",),
    "AUTH_AID": ("aid",),
    "CLIENT_ID": ("client", "id"),
    "CLIENT_VERSION": ("client", "v"),
    "CLIENT_NAME": ("client", "name"),
    "EXT": ("ext",),
    "VER": ("ver",),
}


def __getattr__(name: str) -> Any:
    # PEP 562 lazy module attributes: resolve HAFAS connection values from the
    # primary configured source at access time (never at import), returning ""
    # when unconfigured. Only the keys in _CONFIG_ATTRS are handled.
    path = _CONFIG_ATTRS.get(name)
    if path is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    node: Any = busradar_config.primary_source() or {}
    for key in path:
        node = node.get(key, {}) if isinstance(node, dict) else {}
    return node if isinstance(node, str) else ""


UPSTREAM_TIMEOUT = 10.0
MAX_CONSECUTIVE_FAILURES = 3
CIRCUIT_BREAKER_COOLDOWN = 30.0


# JID/LID patterns:
# - Use [0-9] explicitly NOT \d, because Python 3 `re` defaults to Unicode
#   mode where \d matches Arabic-Indic / Devanagari digits — that's the
#   cache-key-fabrication primitive we want to block.
# - End-anchored with \Z (NOT $) — in Python `$` matches before a trailing
#   newline, so `A=1@L=6003411@\n` would slip through and reach HAFAS.
# - Stay loose on the alphabet: real HAFAS jids carry hash-structured
#   payloads like "2|#VN#1#ST#1782426904#PI#0#…#ZB#Bus  721#…" (embedded
#   spaces, # separators, mixed-case alpha). An earlier tightening tried
#   to constrain the shape to "<num>|<alnum>|<num>|<num>|<date>" — that's
#   the documented EXAMPLE format, not the actual production wire format.
# - End-anchored + length-bounded (Pydantic max_length=300) keeps the
#   cache-key surface bounded.
JID_PATTERN = re.compile(r"\A[0-9|#A-Za-z@:_\-. ]+\Z")
# LID format: real-world looks like `A=1@L=44278341@` or fully qualified
# `A=1@O=Wiesloch-Walldorf Bahnhof@X=8664801@Y=49291306@U=80@L=44278341@i=A×de:08226:4252:1:A,b×BRN_304521@`.  # noqa: E501
# Keep the prefix tight (`A=<num>@`), end-anchor, accept the wider alphabet
# observed in the wild: comma in the `i=` provider metadata, parens for
# station names like "Köln(Hbf)" or "Frankfurt(Main)Hbf", slash for the
# occasional "Bahnhof/ZOB". Spell out the ASCII letter/digit/underscore
# class — `\w` in Python 3 default mode matches Unicode-category Nd digits
# and would re-open the cache-key fabrication primitive we explicitly
# close on JID_PATTERN above.
LID_PATTERN = re.compile(r"\AA=[0-9]+@[A-Za-z0-9_#|=.\-,:/(): @äöüÄÖÜß×]*\Z")


def extract_platform(gid_l: list[str]) -> str:
    """Extract the platform/Steig designator from a HAFAS location's gidL.

    The Steig sits in the A×-prefixed GID as the 5th colon-separated field
    (e.g. 'A×de:08226:4025:1:A' → 'A'). Scans A× GIDs until one yields a
    non-empty platform; returns '' when none do.

    Consolidates three previously duplicated copies (stops_builder
    _discover_platforms + _parse_stop, proxy _flatten_vehicles). Note:
    the two stops_builder copies only inspected the FIRST A× GID and gave
    up; this shared helper adopts the proxy behaviour of scanning further
    A× GIDs until one carries a platform. That is strictly more complete
    (it never loses a platform, and only ever gains one in the rare case
    where the first A× GID lacks the 5th field but a later one has it).
    """
    for gid in gid_l:
        if gid.startswith("A×"):
            parts = gid.split(":")
            if len(parts) >= 5 and parts[4]:
                return parts[4]
    return ""


def lid_is_safe(lid: str) -> bool:
    """LID_PATTERN charset gate PLUS defense-in-depth against a smuggled
    second `L=` field. A HAFAS extId like '6003411@L=9999' would build
    'A=1@L=6003411@L=9999@' and, passing the permissive charset pattern,
    query a FOREIGN station under the opened stop's name. Real lids carry at
    most one `@L=` field, so reject anything with more. The count is
    case-insensitive so a lowercase `@l=` can't slip a second field past the
    guard if HAFAS parses field names case-insensitively."""
    return bool(LID_PATTERN.match(lid)) and lid.lower().count("@l=") <= 1


log = logging.getLogger("busradar")


def _build_hafas_envelope(method: str, req: dict[str, Any]) -> dict[str, Any]:
    src = busradar_config.primary_source() or {}
    client = src.get("client", {}) if isinstance(src.get("client"), dict) else {}
    return {
        "auth": {"type": "AID", "aid": src.get("aid", "")},
        "client": {
            "type": client.get("type", "AND"),
            "id": client.get("id", ""),
            "v": client.get("v", ""),
            "name": client.get("name", ""),
        },
        "ext": src.get("ext", ""),
        "ver": src.get("ver", ""),
        "lang": "de",
        "svcReqL": [{"meth": method, "req": req}],
    }


class _CircuitBreaker:
    def __init__(self) -> None:
        self.failures = 0
        self.last_failure_time = 0.0

    def record_failure(self) -> None:
        self.failures += 1
        self.last_failure_time = time.time()
        if self.failures == MAX_CONSECUTIVE_FAILURES:
            log.warning("[circuit_breaker] OPEN after %d failures", self.failures)

    def record_success(self) -> None:
        if self.failures >= MAX_CONSECUTIVE_FAILURES:
            log.info("[circuit_breaker] CLOSED, upstream recovered")
        self.failures = 0

    @property
    def is_open(self) -> bool:
        if self.failures >= MAX_CONSECUTIVE_FAILURES:
            elapsed = time.time() - self.last_failure_time
            return elapsed < CIRCUIT_BREAKER_COOLDOWN
        return False


breaker = _CircuitBreaker()


async def _hafas_call_via_app(app: FastAPI, method: str, req: dict[str, Any]) -> dict[str, Any]:
    """Call HAFAS using the app-state httpx client. The primary entry point —
    used by all SSE-side helpers that don't have a per-request object.

    Distinguishes two failure classes:
      - "upstream-unhealthy" (network, timeout, 5xx): counts toward the
        circuit breaker so a sick HAFAS doesn't get spammed.
      - "request-rejected" (HAFAS replied 200 OK with `err != "OK"`): the
        caller's input was bad-but-well-formed; HAFAS itself is fine.
        Does NOT count toward the breaker — otherwise an attacker can trip
        global outage with 3 syntactically-valid but semantically-bad LIDs.
    """
    if breaker.is_open:
        return {"error": "upstream_unavailable", "detail": "Service temporarily unavailable"}

    src = busradar_config.primary_source()
    if src is None or not busradar_config.is_valid_endpoint(src.get("endpoint")):
        # Fail closed: no valid HAFAS source configured (missing env /
        # EnvironmentFile, or a non-https endpoint rejected at config parse).
        # Callers treat this like an upstream miss and render no vehicles.
        return {"error": "not_configured", "detail": "No HAFAS source configured"}
    endpoint = src["endpoint"]

    payload = _build_hafas_envelope(method, req)
    try:
        resp = await app.state.client.post(endpoint, json=payload)
        resp.raise_for_status()
        data = resp.json()

        # HAFAS responded 200 OK. Even if err != "OK", the upstream is
        # healthy — only the caller's request was rejected. Don't trip
        # the breaker on caller-error.
        if data.get("err") != "OK":
            log.warning("[hafas] api_error method=%s err=%s", method, data.get("err"))
            breaker.record_success()  # upstream is reachable; reset failure streak
            return {"error": "upstream_error", "detail": "HAFAS error"}

        svc_res = data.get("svcResL", [{}])[0]
        if svc_res.get("err") != "OK":
            log.warning("[hafas] svc_error method=%s err=%s", method, svc_res.get("err"))
            breaker.record_success()
            return {"error": "upstream_error", "detail": "HAFAS service error"}

        breaker.record_success()
        return cast("dict[str, Any]", svc_res.get("res", {}))

    except httpx.PoolTimeout:
        # Pool exhaustion is a LOCAL capacity signal (all connections busy), not an
        # upstream-health signal — do NOT trip the breaker, or transient local
        # contention would cause a global outage. Must precede the TimeoutException
        # handler (PoolTimeout is a subclass). Real HAFAS slowness surfaces as
        # Read/ConnectTimeout below and still trips the breaker.
        log.warning("[hafas] pool_exhausted method=%s", method)
        return {"error": "pool_exhausted", "detail": "Connection pool exhausted"}
    except httpx.TimeoutException:
        breaker.record_failure()
        log.warning("[hafas] timeout method=%s", method)
        return {"error": "upstream_timeout", "detail": "HAFAS did not respond in time"}
    except httpx.HTTPError as e:
        breaker.record_failure()
        log.error("[hafas] http_error method=%s type=%s", method, type(e).__name__)
        return {"error": "upstream_error", "detail": "Upstream HTTP error"}
    except Exception:
        # Internal-proxy bug, not upstream issue — don't trip the breaker
        # for our own bugs (would cause cascading outage from a typo).
        log.exception("[hafas] unexpected_error method=%s", method)
        return {"error": "internal_error", "detail": "Internal proxy error"}
