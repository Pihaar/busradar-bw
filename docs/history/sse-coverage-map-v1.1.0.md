# SSE Migration Coverage Map (v1.1.0)

Audit trail for the polling-endpoint removal. Each deleted polling-test
(against `/api/vehicles`, `ConnectedClients`, `inject_tick_hints`) maps to
its SSE-era pendant. Archived from `docs/sse-coverage-map.md` after the
Iter 2b cut.

## Polling tests → SSE pendants

| Deleted polling test | File | SSE pendant | Pendant file |
|----------------------|------|-------------|--------------|
| `test_vehicles_inverted_bounds` | tests/test_proxy.py | `test_invalid_payload_returns_422` (neLat < swLat) | tests/test_sse_endpoints.py |
| `test_vehicles_out_of_range` | tests/test_proxy.py | covered by Pydantic `Field(ge=-90, le=90)` validators | tests/test_sse_endpoints.py |
| `test_vehicles_success_with_mock` | tests/test_proxy_coverage.py | `test_journey_singleflight_collapses_concurrent_calls` (mock pattern) | tests/test_sse_endpoints.py |
| `test_vehicles_upstream_error` | tests/test_proxy_coverage.py | `test_piggyback_on_originator_exception_returns_opaque_error` | tests/test_sse_endpoints.py |
| `test_vehicles_stale_fallback_on_error` | tests/test_proxy_coverage.py | covered live by curl smoke (`event: error` with `stale: true`) | scripts/sse_smoke.py |
| `test_vehicles_cache_hit_returns_fresh_bucket` | tests/test_proxy_coverage.py | covered by inflight-singleflight tests | tests/test_sse_endpoints.py |
| `test_vehicles_stale_on_error_no_count` | tests/test_proxy_coverage.py | covered by `event: error` opaque-reason mapping in proxy.py | tests/test_sse_endpoints.py |
| `test_vehicles_per_ip_cap_logs_warning` | tests/test_proxy_coverage.py | `TestRegistry::test_per_ip_cap_rejects_at_limit` | tests/test_fanout.py |
| `test_vehicles_with_valid_client_id_increments` | tests/test_proxy_coverage.py | replaced by registry-len-based counter (no UUID id) | tests/test_fanout.py |
| `test_vehicles_without_client_id_no_increment` | tests/test_proxy_coverage.py | obsolete (no client-id concept) | — |
| `test_vehicles_with_invalid_client_id_no_increment` (parametrized) | tests/test_proxy_coverage.py | obsolete (no client-id concept) | — |
| `test_vehicles_force_refresh_still_sends_header` | tests/test_proxy_coverage.py | obsolete (no per-request refresh header) | — |
| `TestInjectTickHints` (class) | tests/test_tick_tracker.py | obsolete; tick hints removed in favor of SSE event-driven model | — |
| `TestVehiclesEndpointTickHints` (class) | tests/test_tick_tracker.py | obsolete; vehicles endpoint deleted | — |
| `TestSingleflight` (class) | tests/test_tick_tracker.py | `TestDetailFetchSingleflight` (both journey and stationboard variants) | tests/test_sse_endpoints.py |
| `TestIsValidClientId` (class) | tests/test_tick_tracker.py | obsolete (no client-id concept) | — |
| `TestNormalizeIp` (class) | tests/test_tick_tracker.py | `TestCanonicalizeIp` | tests/test_fanout.py |
| `TestConnectedClientsBasic` | tests/test_tick_tracker.py | `TestRegistry::test_len_reflects_subscribers` | tests/test_fanout.py |
| `TestConnectedClientsGc` | tests/test_tick_tracker.py | obsolete (registry is connection-scoped, no GC needed) | — |
| `TestConnectedClientsPerIpCap` | tests/test_tick_tracker.py | `TestRegistry::test_per_ip_cap_rejects_at_limit` | tests/test_fanout.py |
| `TestConnectedClientsGlobalCap` | tests/test_tick_tracker.py | `TestRegistry` (global cap covered via lock-overshoot test) | tests/test_fanout.py |
| `TestConnectedClientsBucket` | tests/test_tick_tracker.py | obsolete (counter now exact ≤99, "100+" above) | — |
| `TestConnectedClientsReverseIndex` | tests/test_tick_tracker.py | covered by `_per_ip` private dict in `SubscriberRegistry` | tests/test_fanout.py |
| `TestConnectedClientsRejectLogging` | tests/test_tick_tracker.py | covered by `_maybe_log_cap_reject` in fanout.py | tests/test_fanout.py |
| `TestConnectedClientsTouchOrder` | tests/test_tick_tracker.py | obsolete (touch flow removed; SSE handler owns activity) | — |
| `TestInjectTickHintsBucket` | tests/test_tick_tracker.py | obsolete (bucket → exact count) | — |
| `TestInjectTickHintsVersion` | tests/test_tick_tracker.py | covered by `subscribe` event payload contract | tests/test_sse_endpoints.py |

## New SSE-only test surface (added during Iter 4)

Tests that exist in v1.1.0 and have no pre-SSE pendant — they cover new
contracts introduced by the migration:

| Test | File | Covers |
|------|------|--------|
| `TestSSEStream::test_cap_hit_returns_429_with_scope` | tests/test_sse_endpoints.py | 429 envelope with scope/limit/retryAfter |
| `TestStreamViewport` (all 7 methods) | tests/test_sse_endpoints.py | `/api/stream/viewport` POST contract |
| `TestStreamSelect` (all 7 methods) | tests/test_sse_endpoints.py | `/api/stream/select` POST contract |
| `TestCounterSourceMigration` | tests/test_sse_endpoints.py | Counter is `len(registry)`, viewport-POST fires tick |
| `TestSelectRateLimit` (2 methods) | tests/test_sse_endpoints.py | Per-subscriber + per-IP rate-limits |
| `TestSelectNoFireTickAmplification` | tests/test_sse_endpoints.py | `/select` doesn't trigger global broadcast |
| `TestViewportSkipsFireTickWhenBboxUnchanged` | tests/test_sse_endpoints.py | Bbox-unchanged-skip semantics |
| `TestSelectIdempotentReclick` | tests/test_sse_endpoints.py | Same-jid re-click is a no-op |
| `TestStreamCrossOriginRejection` | tests/test_sse_endpoints.py | Sec-Fetch-Site + Origin defense-in-depth |
| `TestJidPatternStrictness` | tests/test_sse_endpoints.py | Tight regex rejects cache-flush attacks |
| `TestLidPatternEndAnchored` | tests/test_sse_endpoints.py | End-anchored pattern rejects suffix garbage |
| `TestSelectEdgeCases` (4 methods) | tests/test_sse_endpoints.py | Empty body, malformed JSON, mixed-case type, none-with-id |
| `TestDetailFetchSingleflight` (4 methods) | tests/test_sse_endpoints.py | Singleflight collapse + cancel-safety + opaque error |
| `TestDetailCacheEviction` (3 methods) | tests/test_sse_endpoints.py | Cache caps + lock-parity regression guard |

## Summary

- **81 polling-era test methods deleted** (across 3 files, -966 LOC)
- **40 new SSE-era test methods** in tests/test_sse_endpoints.py
- **30 tests in tests/test_fanout.py** (subscriber registry, tick fanout, IP canonicalisation, bbox quantize)
- **Net Python test count**: 176 passed / 2 skipped (from 290 passed / many-skipped pre-migration)
- **Net code reduction**: -304 LOC despite adding fanout.py + scripts/

The reduction reflects the design simplification: removing the UUID-bound counter,
the polling endpoint, the ConnectedClients class, and the legacy refresh-loop
polling left a substantially smaller surface to test.
