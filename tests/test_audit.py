"""Tests for audit.py — rate-limited audit logging with dict-size cap."""

from __future__ import annotations

import audit
from audit import AUDIT_LOG_MAX_KEYS, _audit


class TestAudit:
    def setup_method(self):
        # Isolate the module-level dedup dict per test.
        audit._audit_log_last.clear()

    def teardown_method(self):
        audit._audit_log_last.clear()

    def test_first_call_logs_and_records(self, caplog):
        with caplog.at_level("WARNING", logger="busradar"):
            _audit("bad_input", "1.2.3.4", detail="oops")
        assert any("bad_input" in r.message for r in caplog.records)
        # Exactly one dedup key stored.
        assert len(audit._audit_log_last) == 1

    def test_repeat_within_window_suppressed(self, caplog):
        _audit("bad_input", "1.2.3.4")
        with caplog.at_level("WARNING", logger="busradar"):
            caplog.clear()
            _audit("bad_input", "1.2.3.4")
        # Second call within _AUDIT_RATE is suppressed → no new record.
        assert not caplog.records

    def test_repeat_after_window_logs_again(self, caplog, monkeypatch):
        # First call at t=0.
        monkeypatch.setattr(audit.time, "monotonic", lambda: 0.0)
        _audit("bad_input", "1.2.3.4")
        # Second call well past _AUDIT_RATE → logs again.
        monkeypatch.setattr(audit.time, "monotonic", lambda: audit._AUDIT_RATE + 1)
        with caplog.at_level("WARNING", logger="busradar"):
            caplog.clear()
            _audit("bad_input", "1.2.3.4")
        assert any("bad_input" in r.message for r in caplog.records)

    def test_empty_ip_uses_noip_hash(self, caplog):
        with caplog.at_level("WARNING", logger="busradar"):
            _audit("no_ip_case", "")
        assert any("ip_hash=noip" in r.message for r in caplog.records)

    def test_extra_falsy_renders_empty_string(self, caplog):
        # `extra or ""` — with no kwargs, extra is an empty dict → falsy → "".
        # The record args carry "" for the %s, so the rendered message ends
        # with the trailing space and nothing after it.
        with caplog.at_level("WARNING", logger="busradar"):
            _audit("plain", "9.9.9.9")
        rec = next(r for r in caplog.records if "plain" in r.message)
        assert rec.message.endswith("plain ip_hash=1a22570d ")

    def test_dict_cap_drops_oldest_half(self, monkeypatch):
        # Fill the dict past the cap with distinct keys at increasing
        # timestamps. Once len reaches the cap, the next insert triggers the
        # drop-oldest-half branch (lines 32-34), so the dict never exceeds the
        # cap and stays deterministically bounded.
        t = [0.0]

        def fake_mono():
            # Step past _AUDIT_RATE each call so every distinct key inserts
            # (no early-return via the rate gate) and the dict actually fills.
            t[0] += audit._AUDIT_RATE + 1.0
            return t[0]

        monkeypatch.setattr(audit.time, "monotonic", fake_mono)
        for i in range(AUDIT_LOG_MAX_KEYS + 1):
            _audit(f"reason_{i}", "1.1.1.1")
        # The prune fired at least once (len hit the cap then dropped half).
        assert 0 < len(audit._audit_log_last) <= AUDIT_LOG_MAX_KEYS
        # Oldest key was evicted by the drop-oldest-half branch.
        assert "reason_0:f1412386" not in audit._audit_log_last
