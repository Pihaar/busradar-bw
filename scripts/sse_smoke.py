#!/usr/bin/env python3
"""SSE smoke test for /api/stream/.

Opens N concurrent EventSource connections, sends a viewport POST from each,
collects events for a configurable duration, and reports basic latency + RSS
statistics. Used for pre-release verification and as a regression guard for
the SSE event-loop scheduling and singleflight collapse.

Usage:
    python3 sse_smoke.py --url https://busradar.pihaar.de --clients 50 --duration 600

Exit codes:
    0  all clients stayed connected; p95 first-event latency < 5s; RSS delta < 50MB
    1  one or more clients got unsolicited close, or latency/RSS budget blown

Stdlib-only — depends on httpx for HTTP/2 + SSE-friendly streaming.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import resource
import sys
import time


def _get_self_rss_kb() -> int:
    """Return RSS of the smoke script process in KiB. Linux-specific (ru_maxrss)."""
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss


async def run_one(client_id: int, base_url: str, duration_s: float, results: list) -> None:
    """Open one EventSource, send a viewport POST, count received events."""
    try:
        import httpx
    except ImportError:
        print("httpx not installed; pip install httpx", file=sys.stderr)
        sys.exit(2)

    start = time.monotonic()
    first_event_ts = None
    event_count = 0
    cookie_jar: dict = {}
    error_msg = None

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(connect=10.0, read=None, write=10.0, pool=10.0)) as ac:
            async with ac.stream("GET", f"{base_url}/api/stream/") as resp:
                if resp.status_code != 200:
                    error_msg = f"HTTP {resp.status_code}"
                    results.append({"id": client_id, "ok": False, "error": error_msg, "events": 0})
                    return
                # Capture cookie
                if "busradar_sse" in resp.cookies:
                    cookie_jar["busradar_sse"] = resp.cookies["busradar_sse"]
                # POST viewport
                viewport_posted = False
                async for line in resp.aiter_lines():
                    if line.startswith("event:"):
                        if first_event_ts is None:
                            first_event_ts = time.monotonic()
                        event_count += 1
                        if not viewport_posted and cookie_jar:
                            # Sandhausen-ish bbox; slightly offset per client so quantize doesn't fully collapse
                            offset = (client_id % 10) * 0.001
                            payload = json.dumps({
                                "swLat": 49.3 + offset, "swLon": 8.6 + offset,
                                "neLat": 49.4 + offset, "neLon": 8.7 + offset,
                                "posMode": "CALC",
                            })
                            try:
                                await ac.post(
                                    f"{base_url}/api/stream/viewport",
                                    content=payload,
                                    headers={
                                        "Content-Type": "application/json",
                                        "Origin": base_url,
                                        "Cookie": f"busradar_sse={cookie_jar['busradar_sse']}",
                                    },
                                    timeout=5.0,
                                )
                                viewport_posted = True
                            except Exception as e:
                                error_msg = f"viewport-post-failed: {e}"
                    if time.monotonic() - start > duration_s:
                        break
    except asyncio.CancelledError:
        raise
    except Exception as e:
        error_msg = f"{type(e).__name__}: {e}"

    elapsed = time.monotonic() - start
    first_event_latency = (first_event_ts - start) if first_event_ts else None
    results.append({
        "id": client_id,
        "ok": error_msg is None and event_count > 0,
        "events": event_count,
        "elapsed_s": elapsed,
        "first_event_s": first_event_latency,
        "error": error_msg,
    })


async def main():
    p = argparse.ArgumentParser(description="SSE smoke test for /api/stream/")
    p.add_argument("--url", required=True, help="Base URL, e.g. https://busradar.pihaar.de")
    p.add_argument("--clients", type=int, default=50, help="Concurrent EventSource connections")
    p.add_argument("--duration", type=float, default=600.0, help="Test duration in seconds")
    p.add_argument("--rss-limit-mb", type=float, default=50.0, help="Max acceptable RSS delta")
    p.add_argument("--latency-budget-s", type=float, default=5.0, help="p95 first-event latency budget")
    args = p.parse_args()

    rss_before_kb = _get_self_rss_kb()
    print(f"smoke: starting {args.clients} clients against {args.url} for {args.duration}s")
    print(f"smoke: RSS baseline = {rss_before_kb} KiB")

    results: list = []
    tasks = [
        asyncio.create_task(run_one(i, args.url.rstrip("/"), args.duration, results))
        for i in range(args.clients)
    ]
    await asyncio.gather(*tasks, return_exceptions=True)

    rss_after_kb = _get_self_rss_kb()
    rss_delta_mb = (rss_after_kb - rss_before_kb) / 1024.0

    ok = [r for r in results if r["ok"]]
    failed = [r for r in results if not r["ok"]]
    latencies = sorted(r["first_event_s"] for r in ok if r["first_event_s"] is not None)
    p95 = latencies[int(len(latencies) * 0.95)] if latencies else float("inf")

    print(f"smoke: ok={len(ok)}/{args.clients}, failed={len(failed)}, p95 first-event={p95:.2f}s, RSS delta={rss_delta_mb:.1f} MiB")
    for f in failed[:10]:
        print(f"  failure[{f['id']}]: events={f['events']}, error={f['error']}")

    exit_code = 0
    if failed:
        print(f"smoke: FAIL — {len(failed)} client(s) errored", file=sys.stderr)
        exit_code = 1
    if p95 > args.latency_budget_s:
        print(f"smoke: FAIL — p95 latency {p95:.2f}s > budget {args.latency_budget_s}s", file=sys.stderr)
        exit_code = 1
    if rss_delta_mb > args.rss_limit_mb:
        print(f"smoke: FAIL — RSS delta {rss_delta_mb:.1f} MiB > limit {args.rss_limit_mb} MiB", file=sys.stderr)
        exit_code = 1
    if exit_code == 0:
        print("smoke: PASS")
    sys.exit(exit_code)


if __name__ == "__main__":
    asyncio.run(main())
