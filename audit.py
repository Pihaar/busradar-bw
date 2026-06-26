"""
Busradar BW — Rate-limited audit logging.

Suppresses repeat warnings for the same (reason, ip-hash) tuple within
AUDIT_RATE seconds, and caps the dict size to keep a scanner rotating IPs
from leaking memory forever.
"""

from __future__ import annotations

import hashlib
import logging
import time


log = logging.getLogger("busradar")


AUDIT_LOG_MAX_KEYS = 4096  # cap audit-log dict size against slow-leak via scanner

_audit_log_last: dict[str, float] = {}
_AUDIT_RATE = 60.0


def _audit(reason: str, ip: str, **extra) -> None:
    """Rate-limit audit-warnings to 1/min per (reason, ip-hash)."""
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
