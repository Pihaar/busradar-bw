#!/usr/bin/env bash
# HTTP/3 (QUIC) smoke test for /api/stream/.
#
# Requires curl built with HTTP/3 support (curl 7.66+ with --http3-only flag).
# Opens an SSE connection over HTTP/3 and asserts that at least one keepalive
# comment line (`: keepalive`) arrives within KEEPALIVE_BUDGET_S seconds.
#
# Usage:
#   scripts/sse_quic_check.sh https://busradar.pihaar.de
#
# Exit codes:
#   0 — HTTP/3 negotiated, SSE stream open, keepalive seen
#   1 — anything else (no HTTP/3, no keepalive within budget, etc.)
set -euo pipefail

URL="${1:-https://busradar.pihaar.de}"
KEEPALIVE_BUDGET_S="${KEEPALIVE_BUDGET_S:-20}"

if ! command -v curl >/dev/null 2>&1; then
    echo "curl not found" >&2
    exit 1
fi

# Verify curl has HTTP/3 capability.
if ! curl --version 2>&1 | grep -q "HTTP3"; then
    echo "curl does not advertise HTTP3 in --version output. Need curl built with QUIC support." >&2
    exit 1
fi

echo "quic-check: target $URL, budget ${KEEPALIVE_BUDGET_S}s"

# Use --http3-only to fail if HTTP/3 isn't negotiated (vs --http3 which falls back).
# -N disables output buffering so we see SSE frames as they arrive.
# Pipe to a small awk that exits 0 on the first ': keepalive' line and 1 on EOF/timeout.
TMP_OUT="$(mktemp)"
trap 'rm -f "$TMP_OUT"' EXIT

timeout "${KEEPALIVE_BUDGET_S}" curl -sN --http3-only --max-time "${KEEPALIVE_BUDGET_S}" "$URL/api/stream/" >"$TMP_OUT" 2>&1 || true

if grep -q "^: keepalive" "$TMP_OUT"; then
    echo "quic-check: PASS (saw ': keepalive' on HTTP/3 stream)"
    exit 0
fi

# Diagnostic: did we even reach the server?
if grep -qE "^event: (subscribe|connected)" "$TMP_OUT"; then
    echo "quic-check: FAIL — subscribe event seen but no keepalive within ${KEEPALIVE_BUDGET_S}s" >&2
    echo "  (server alive but heartbeat not arriving — check SSE_KEEPALIVE_MIN/MAX in proxy.py)" >&2
    exit 1
fi

echo "quic-check: FAIL — no SSE events received on HTTP/3 stream within ${KEEPALIVE_BUDGET_S}s" >&2
echo "  curl output (first 500 chars):" >&2
head -c 500 "$TMP_OUT" >&2
echo >&2
exit 1
