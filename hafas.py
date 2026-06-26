"""
Busradar BW — HAFAS upstream client.

Owns the HAFAS endpoint constants, envelope builder, circuit breaker,
and the single async entry point `_hafas_call_via_app` that every other
module funnels through. Also exports the validated JID/LID patterns.

Direction: this module has no app-internal imports — caches, sse_handler,
and proxy all depend on it.
"""

from __future__ import annotations

import logging
import re
import time

import httpx
from fastapi import FastAPI


HAFAS_ENDPOINT = "https://db-regio.hafas.de/bin/mgate.exe"
AUTH_AID = "FiBa5ytjCvR0J47P"
CLIENT_ID = "DB-REGIO"
CLIENT_VERSION = "3000000"
CLIENT_NAME = "DB Busradar BW"
EXT = "DB.REGIO.1"
VER = "1.39"

UPSTREAM_TIMEOUT = 10.0
MAX_CONSECUTIVE_FAILURES = 3
CIRCUIT_BREAKER_COOLDOWN = 30.0


# JID/LID patterns:
# - Use [0-9] explicitly NOT \d, because Python 3 `re` defaults to Unicode
#   mode where \d matches Arabic-Indic / Devanagari digits — that's the
#   cache-key-fabrication primitive we want to block.
# - Stay loose on the alphabet: real HAFAS jids carry hash-structured
#   payloads like "2|#VN#1#ST#1782426904#PI#0#…#ZB#Bus  721#…" (embedded
#   spaces, # separators, mixed-case alpha). An earlier tightening tried
#   to constrain the shape to "<num>|<alnum>|<num>|<num>|<date>" — that's
#   the documented EXAMPLE format, not the actual production wire format.
# - End-anchored + length-bounded (Pydantic max_length=300) keeps the
#   cache-key surface bounded.
JID_PATTERN = re.compile(r"^[0-9|#A-Za-z@:_\-. ]+$")
# LID format: real-world looks like `A=1@O=Sandhausen Altes Rathaus@L=6003411@`
# or with German umlauts in stop names. Keep the prefix tight (`A=<num>@`),
# end-anchor, but accept the wider alphabet observed in the wild. Length cap
# (Pydantic max_length=300) bounds the cache-key surface.
LID_PATTERN = re.compile(r"^A=[0-9]+@[\w#|=.\-: @äöüÄÖÜß×]*$")


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


breaker = _CircuitBreaker()


async def _hafas_call_via_app(app: FastAPI, method: str, req: dict) -> dict:
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

    payload = _build_hafas_envelope(method, req)
    try:
        resp = await app.state.client.post(HAFAS_ENDPOINT, json=payload)
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
        # Internal-proxy bug, not upstream issue — don't trip the breaker
        # for our own bugs (would cause cascading outage from a typo).
        log.exception("[hafas] unexpected_error method=%s", method)
        return {"error": "internal_error", "detail": "Internal proxy error"}
