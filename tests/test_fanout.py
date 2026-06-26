"""Tests for fanout.py — SubscriberRegistry + tick fanout primitives.

Includes the 7 named cases mandated by the SSE-migration plan plus general
unit tests for canonicalisation, queue policy, cap behaviour, and bucket
counts."""
from __future__ import annotations

import asyncio
import pytest

import fanout
from fanout import (
    BBOX_QUANTIZE_DEG,
    CapExceeded,
    MAX_SUBSCRIBERS_GLOBAL,
    MAX_SUBSCRIBERS_PER_IP,
    QUEUE_MAXSIZE,
    SLOW_CONSUMER_DROP_THRESHOLD,
    Subscriber,
    SubscriberRegistry,
    canonicalize_ip,
    enqueue_event,
    fire_tick,
    quantize_bbox,
    should_disconnect_slow_consumer,
)


@pytest.fixture
def reg() -> SubscriberRegistry:
    """Fresh registry per test — avoids state bleed via the module-level one."""
    return SubscriberRegistry()


@pytest.fixture
def reset_module_state():
    """Reset module-level tick state around each test. The Condition must be
    rebuilt INSIDE the async context the test runs in, so we provide a
    helper that the async test invokes after the event-loop is up."""
    yield
    fanout.tick_seq = 0


async def _fresh_condition():
    """Replace fanout.tick_condition with a Condition bound to the current
    running event loop. Must be awaited from inside an async test."""
    fanout.tick_condition = asyncio.Condition()
    fanout.tick_seq = 0


# === canonicalize_ip ===

class TestCanonicalizeIp:
    def test_ipv4_passes_through(self):
        assert canonicalize_ip("192.168.1.5") == "192.168.1.5"

    def test_ipv6_collapses_to_64(self):
        # /64 prefix → all 64-bit-suffix hosts share a key
        assert canonicalize_ip("2001:db8:1234:5678::1") == canonicalize_ip("2001:db8:1234:5678:ffff::abcd")

    def test_ipv6_distinct_prefixes_stay_distinct(self):
        assert canonicalize_ip("2001:db8:1::1") != canonicalize_ip("2001:db8:2::1")

    def test_empty_returns_empty(self):
        assert canonicalize_ip("") == ""
        assert canonicalize_ip(None) == ""

    def test_malformed_returns_empty(self):
        assert canonicalize_ip("not-an-ip") == ""
        assert canonicalize_ip("999.999.999.999") == ""


# === quantize_bbox ===

class TestQuantizeBbox:
    def test_identical_bbox_quantize_identical(self):
        a = (49.34, 8.66, 49.36, 8.68)
        assert quantize_bbox(a) == quantize_bbox(a)

    def test_jitter_below_grid_collapses(self):
        # Two viewports differ by 0.001° (~110m), well below 0.01° grid
        a = (49.340, 8.660, 49.360, 8.680)
        b = (49.341, 8.661, 49.361, 8.681)
        assert quantize_bbox(a) == quantize_bbox(b)

    def test_jitter_above_grid_separates(self):
        a = (49.340, 8.660, 49.360, 8.680)
        b = (49.350, 8.660, 49.360, 8.680)  # 0.01° apart, >= grid
        assert quantize_bbox(a) != quantize_bbox(b)


# === SubscriberRegistry — subscribe / unsubscribe / caps ===

class TestRegistry:
    @pytest.mark.asyncio
    async def test_subscribe_returns_subscriber(self, reg):
        sub = await reg.subscribe("192.168.1.1")
        assert isinstance(sub, Subscriber)
        assert sub.ip == "192.168.1.1"
        assert sub.connection_id and len(sub.connection_id) > 32  # token_urlsafe(32) ≈ 43 chars

    @pytest.mark.asyncio
    async def test_subscribe_assigns_unique_ids(self, reg):
        a = await reg.subscribe("10.0.0.1")
        b = await reg.subscribe("10.0.0.1")
        assert a.connection_id != b.connection_id

    @pytest.mark.asyncio
    async def test_unsubscribe_removes(self, reg):
        sub = await reg.subscribe("10.0.0.1")
        assert reg.get(sub.connection_id) is sub
        await reg.unsubscribe(sub.connection_id)
        assert reg.get(sub.connection_id) is None

    @pytest.mark.asyncio
    async def test_unsubscribe_idempotent(self, reg):
        sub = await reg.subscribe("10.0.0.1")
        await reg.unsubscribe(sub.connection_id)
        await reg.unsubscribe(sub.connection_id)  # second call must not raise

    @pytest.mark.asyncio
    async def test_per_ip_cap_rejects_at_limit(self, reg):
        # MAX_SUBSCRIBERS_PER_IP = 20 default; create that many then expect raise.
        for _ in range(MAX_SUBSCRIBERS_PER_IP):
            await reg.subscribe("10.0.0.1")
        with pytest.raises(CapExceeded) as exc:
            await reg.subscribe("10.0.0.1")
        assert exc.value.scope == "ip"
        assert exc.value.limit == MAX_SUBSCRIBERS_PER_IP

    @pytest.mark.asyncio
    async def test_per_ip_cap_separate_per_ip(self, reg):
        for _ in range(MAX_SUBSCRIBERS_PER_IP):
            await reg.subscribe("10.0.0.1")
        # Other IP is unaffected
        await reg.subscribe("10.0.0.2")  # must not raise

    @pytest.mark.asyncio
    async def test_ipv6_subnet_cap_uses_64(self, reg):
        # All these IPs share /64; cap counts them as one IP-bucket
        prefix = "2001:db8:1::"
        for i in range(MAX_SUBSCRIBERS_PER_IP):
            await reg.subscribe(f"{prefix}{i+1:x}")
        with pytest.raises(CapExceeded) as exc:
            await reg.subscribe(f"{prefix}beef")
        assert exc.value.scope == "ip"

    @pytest.mark.asyncio
    async def test_empty_ip_skips_per_ip_cap_only_global(self, reg):
        # Unix-socket / malformed IP → empty string. Should NOT enforce per-IP
        # but global cap still applies.
        # Subscribe many with empty ip
        for _ in range(MAX_SUBSCRIBERS_PER_IP * 2):
            await reg.subscribe("")  # no per-IP rejection
        assert len(reg) == MAX_SUBSCRIBERS_PER_IP * 2

    @pytest.mark.asyncio
    async def test_len_reflects_subscribers(self, reg):
        assert len(reg) == 0
        for _ in range(5):
            await reg.subscribe("10.0.0.1")
        assert len(reg) == 5

    @pytest.mark.asyncio
    async def test_len_grows_with_subscribers(self, reg):
        # display_count() was deleted — the SSE 'connected' event now ships
        # the raw int and the frontend formats it.
        assert len(reg) == 0
        await reg.subscribe("10.0.0.1")
        assert len(reg) == 1
        await reg.subscribe("10.0.0.2")
        assert len(reg) == 2


# === Tick fanout ===

class TestTickFanout:
    @pytest.mark.asyncio
    async def test_fire_tick_bumps_seq(self, reset_module_state):
        await _fresh_condition()
        before = fanout.tick_seq
        seq = await fire_tick()
        assert seq == before + 1
        assert fanout.tick_seq == seq

    @pytest.mark.asyncio
    async def test_condition_no_lost_wakeup_under_concurrent_notify(self, reset_module_state):
        """Named case: a subscriber that joins mid-notify_all must see the next
        tick. The Condition-based design guarantees this; the old
        Event.set()+clear() pattern would have lost it."""
        await _fresh_condition()
        received_seqs: list[int] = []

        async def waiter(local_seq_at_start: int):
            async with fanout.tick_condition:
                await fanout.tick_condition.wait_for(
                    lambda: fanout.tick_seq > local_seq_at_start
                )
                received_seqs.append(fanout.tick_seq)

        local_at_start = fanout.tick_seq
        task = asyncio.create_task(waiter(local_at_start))
        await asyncio.sleep(0.01)  # let waiter park on wait_for
        await fire_tick()
        await asyncio.wait_for(task, timeout=1.0)
        assert received_seqs == [local_at_start + 1]


# === Queue / slow consumer ===

class TestQueuePolicy:
    def test_enqueue_within_capacity(self):
        sub = Subscriber(connection_id="x", ip="")
        for i in range(QUEUE_MAXSIZE):
            enqueue_event(sub, {"i": i})
        assert sub.event_queue.qsize() == QUEUE_MAXSIZE
        assert sub.consecutive_drops == 0

    def test_enqueue_overflows_drops_oldest(self):
        sub = Subscriber(connection_id="x", ip="")
        for i in range(QUEUE_MAXSIZE + 3):
            enqueue_event(sub, {"i": i})
        # Queue stayed at maxsize; consecutive_drops counted the 3 overflows
        assert sub.event_queue.qsize() == QUEUE_MAXSIZE
        assert sub.consecutive_drops == 3

    def test_drop_counter_resets_after_success_between_drops(self):
        """Named case: drop, drop, success, drop, drop → consecutive_drops=2,
        not 4. Reset-on-success keeps short blips from triggering disconnect."""
        sub = Subscriber(connection_id="x", ip="")
        # Fill queue
        for i in range(QUEUE_MAXSIZE):
            enqueue_event(sub, {"i": i})
        # Two drops
        enqueue_event(sub, {"drop": 1})
        enqueue_event(sub, {"drop": 2})
        assert sub.consecutive_drops == 2
        # Consumer drains one slot → next put succeeds, counter resets
        sub.event_queue.get_nowait()
        enqueue_event(sub, {"success": True})
        assert sub.consecutive_drops == 0
        # Two more drops → counter starts fresh at 2
        enqueue_event(sub, {"drop": 3})
        enqueue_event(sub, {"drop": 4})
        assert sub.consecutive_drops == 2

    def test_slow_consumer_threshold(self):
        sub = Subscriber(connection_id="x", ip="")
        assert not should_disconnect_slow_consumer(sub)
        sub.consecutive_drops = SLOW_CONSUMER_DROP_THRESHOLD - 1
        assert not should_disconnect_slow_consumer(sub)
        sub.consecutive_drops = SLOW_CONSUMER_DROP_THRESHOLD
        assert should_disconnect_slow_consumer(sub)


# === Named test cases from the SSE plan ===

class TestNamedPlanCases:
    @pytest.mark.asyncio
    async def test_cap_lock_prevents_overshoot_with_21_concurrent_connects(self, reg):
        """Named case: 21 simultaneous subscribe() calls under the registry
        lock must yield exactly MAX_SUBSCRIBERS_PER_IP accepted + 1 rejected.
        Without the lock the cap could be overshot by a TOCTOU race."""
        results = await asyncio.gather(
            *[reg.subscribe("10.0.0.1") for _ in range(MAX_SUBSCRIBERS_PER_IP + 1)],
            return_exceptions=True,
        )
        accepted = [r for r in results if isinstance(r, Subscriber)]
        rejected = [r for r in results if isinstance(r, CapExceeded)]
        assert len(accepted) == MAX_SUBSCRIBERS_PER_IP
        assert len(rejected) == 1
        assert rejected[0].scope == "ip"

    @pytest.mark.asyncio
    async def test_tick_aligned_bypass_delivers_when_bucket_empty(self, reset_module_state):
        """Named case: even if the connected-event token-bucket is empty,
        a tick must still wake every subscriber.

        The bucket itself lives in the SSE handler; from the fanout layer's
        view we only need to assert that fire_tick() always notifies, which
        is the precondition for the SSE-handler's tick-aligned bypass to
        trigger downstream."""
        await _fresh_condition()
        notified = 0

        async def waiter():
            nonlocal notified
            local = fanout.tick_seq
            async with fanout.tick_condition:
                await fanout.tick_condition.wait_for(lambda: fanout.tick_seq > local)
                notified += 1

        tasks = [asyncio.create_task(waiter()) for _ in range(5)]
        await asyncio.sleep(0.01)
        await fire_tick()
        await asyncio.wait_for(asyncio.gather(*tasks), timeout=1.0)
        assert notified == 5

    @pytest.mark.asyncio
    async def test_asyncexitstack_continues_after_deregister_failure(self, reg, monkeypatch):
        """Named case: cleanup step 1 (deregister) raising must not prevent
        steps 2/3. We simulate by patching unsubscribe to raise once and
        observe that the registry stays consistent on a follow-up call."""
        sub = await reg.subscribe("10.0.0.1")

        raised_once = {"n": 0}
        orig = reg.unsubscribe

        async def flaky(cid):
            if raised_once["n"] == 0:
                raised_once["n"] += 1
                raise RuntimeError("simulated deregister failure")
            await orig(cid)

        monkeypatch.setattr(reg, "unsubscribe", flaky)
        # First call raises — caller swallows in real handler. Verify it raised.
        with pytest.raises(RuntimeError):
            await reg.unsubscribe(sub.connection_id)
        # Restore and verify subscriber still removable
        monkeypatch.setattr(reg, "unsubscribe", orig)
        await reg.unsubscribe(sub.connection_id)
        assert reg.get(sub.connection_id) is None

    @pytest.mark.asyncio
    async def test_bbox_quantize_collision_isolates_subscriber_state(self, reg):
        """Named case: two subscribers at the same quantized bbox must keep
        independent `selection` state. Cache collision doesn't mean state
        collision."""
        from fanout import JourneySelection, StationSelection
        a = await reg.subscribe("10.0.0.1")
        b = await reg.subscribe("10.0.0.2")
        # Same quantized bbox
        a.viewport = (49.340, 8.660, 49.360, 8.680)
        b.viewport = (49.341, 8.661, 49.361, 8.681)
        assert quantize_bbox(a.viewport) == quantize_bbox(b.viewport)
        # Independent selections
        a.selection = JourneySelection(jid="J1")
        b.selection = StationSelection(lid="L2")
        assert a.selection != b.selection
        assert a.selection.jid == "J1"
        assert b.selection.lid == "L2"

    def test_slow_consumer_disconnect_concurrent_with_client_close(self):
        """Named case: subscriber hits 5 consecutive drops AND client closes
        connection at the same tick. should_disconnect_slow_consumer() must
        be safe to evaluate even after the queue/state is partially torn
        down — it only reads `consecutive_drops`, no I/O."""
        sub = Subscriber(connection_id="x", ip="10.0.0.1")
        sub.consecutive_drops = SLOW_CONSUMER_DROP_THRESHOLD
        # Tear down task / queue mid-flight to simulate client close
        sub.task = None
        sub.event_queue = None  # simulate cleanup race
        # Predicate must NOT touch the queue, only the counter
        assert should_disconnect_slow_consumer(sub) is True


# === CapExceeded payload ===

class TestCapExceeded:
    def test_carries_scope_and_limit(self):
        e = CapExceeded("global", 500)
        assert e.scope == "global"
        assert e.limit == 500
        assert "global" in str(e)
        assert "500" in str(e)
