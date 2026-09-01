"""Runtime configuration loader for Busradar.

Reads secrets and HAFAS connection data from the process environment (set in
production via a systemd EnvironmentFile at /etc/busradar/busradar.env, kept
out of git and the RPM). Nothing here is hardcoded — a checkout/package ships
without the CARTO key or any HAFAS AID; those must be supplied at deploy time.

Design notes:
- Lazy + memoized: values are read on first access, not at import, so tests can
  set the environment first and there is no import-order coupling. Call reset()
  in tests to re-read after changing the environment.
- Fail-closed: a missing/empty/invalid configuration never raises. Missing HAFAS
  sources yield an empty list (the app degrades to "no vehicles" rather than
  crashing); a missing CARTO key yields "" (the map falls back / shows the
  watermark but still works).
- Light parsing, not a schema validator: the config is local operator input, a
  weak trust boundary. A source object missing a required field is skipped with
  a log line; we do not exhaustively validate every field.
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any
from urllib.parse import urlparse

log = logging.getLogger("busradar")

# Minimal fields a HAFAS source must carry to be usable at all.
_REQUIRED_SOURCE_FIELDS = ("endpoint", "aid")

# The CARTO key is substituted into an HTML attribute (meta[name=carto-key]).
# It is operator-controlled, but stripping to the known key charset closes the
# HTML-attribute-injection surface (SEC-100) cheaply. Real CARTO keys match this.
_CARTO_KEY_RE = re.compile(r"[^A-Za-z0-9_\-]")

_cache: dict[str, Any] | None = None


def _sanitize_carto_key(raw: str) -> str:
    """Strip everything outside the CARTO key charset so the value cannot break
    out of the meta-tag attribute it is embedded in."""
    return _CARTO_KEY_RE.sub("", raw or "")


def is_valid_endpoint(url: Any) -> bool:
    """The endpoint is used for an outbound POST, so validate it at this trust
    boundary (config parse) AND assert it at each outbound sink: require a
    well-formed https:// URL. Defence-in-depth against a misconfigured source
    pointing at a plaintext or internal target (SSRF / SEC-375, encrypted
    transport / SEC-218). All real HAFAS mgate endpoints are https."""
    if not isinstance(url, str):
        return False
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    return parsed.scheme == "https" and bool(parsed.netloc)


def _parse_sources(raw: str | None) -> list[dict[str, Any]]:
    """Parse BUSRADAR_HAFAS_SOURCES (a JSON array string) into a list of source
    dicts. Returns [] on any structural problem (never raises)."""
    raw = (raw or "").strip()
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        log.warning("[config] BUSRADAR_HAFAS_SOURCES is not valid JSON — ignoring")
        return []
    if not isinstance(data, list):
        log.warning("[config] BUSRADAR_HAFAS_SOURCES must be a JSON array — ignoring")
        return []
    out: list[dict[str, Any]] = []
    for i, src in enumerate(data):
        if not isinstance(src, dict):
            log.warning("[config] HAFAS source #%d is not an object — skipped", i)
            continue
        missing = [k for k in _REQUIRED_SOURCE_FIELDS if not src.get(k)]
        if missing:
            log.warning("[config] HAFAS source #%d missing %s — skipped", i, missing)
            continue
        if not is_valid_endpoint(src.get("endpoint")):
            log.warning("[config] HAFAS source #%d endpoint is not an https URL — skipped", i)
            continue
        out.append(src)
    return out


def load() -> dict[str, Any]:
    """Return the memoized config dict, reading the environment on first call."""
    global _cache
    if _cache is None:
        sources = _parse_sources(os.environ.get("BUSRADAR_HAFAS_SOURCES"))
        _cache = {
            "carto_key": _sanitize_carto_key(os.environ.get("BUSRADAR_CARTO_KEY", "")),
            "hafas_sources": sources,
        }
        if not sources:
            log.warning("[config] no usable HAFAS sources configured — vehicle data disabled")
    return _cache


def reset() -> None:
    """Drop the memoized config so the next load() re-reads the environment.
    Test-only helper."""
    global _cache
    _cache = None


def carto_key() -> str:
    """The (sanitized) CARTO Basemaps API key, or "" when unconfigured."""
    return str(load()["carto_key"])


def hafas_sources() -> list[dict[str, Any]]:
    """All configured HAFAS sources (may be empty)."""
    return list(load()["hafas_sources"])


def primary_source() -> dict[str, Any] | None:
    """The source used by the current single-source runtime: the one tagged
    id=="bw" if present, else the first. None when nothing is configured."""
    sources = hafas_sources()
    if not sources:
        return None
    for src in sources:
        if src.get("id") == "bw":
            return src
    return sources[0]
