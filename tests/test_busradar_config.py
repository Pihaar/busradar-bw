"""Tests for busradar_config — env-driven CARTO key + HAFAS sources loader."""

from __future__ import annotations

import json

import busradar_config as cfg

_VALID_SOURCE = {
    "id": "bw",
    "endpoint": "https://hafas.example/bin/mgate.exe",
    "aid": "AID1",
    "client": {"type": "AND", "id": "DB-REGIO", "v": "3000000", "name": "X"},
    "ext": "DB.REGIO.1",
    "ver": "1.39",
}


def _set(monkeypatch, *, carto=None, sources=None):
    """Set (or clear) the two env vars and reset the memo so load() re-reads."""
    if carto is None:
        monkeypatch.delenv("BUSRADAR_CARTO_KEY", raising=False)
    else:
        monkeypatch.setenv("BUSRADAR_CARTO_KEY", carto)
    if sources is None:
        monkeypatch.delenv("BUSRADAR_HAFAS_SOURCES", raising=False)
    else:
        monkeypatch.setenv("BUSRADAR_HAFAS_SOURCES", sources)
    cfg.reset()


class TestSanitizeCartoKey:
    def test_keeps_key_charset(self, monkeypatch):
        _set(monkeypatch, carto="cb1_2h1v_1-abcXYZ")
        assert cfg.carto_key() == "cb1_2h1v_1-abcXYZ"

    def test_strips_out_of_charset_chars(self, monkeypatch):
        _set(monkeypatch, carto='ab"><script>c d!')
        assert cfg.carto_key() == "abscriptcd"

    def test_missing_key_is_empty(self, monkeypatch):
        _set(monkeypatch, carto=None)
        assert cfg.carto_key() == ""


class TestIsValidEndpoint:
    def test_https_with_host_ok(self):
        assert cfg.is_valid_endpoint("https://h.example/x") is True

    def test_http_rejected(self):
        assert cfg.is_valid_endpoint("http://h.example/x") is False

    def test_non_string_rejected(self):
        assert cfg.is_valid_endpoint(None) is False
        assert cfg.is_valid_endpoint(123) is False

    def test_https_without_netloc_rejected(self):
        assert cfg.is_valid_endpoint("https:///path") is False

    def test_malformed_url_valueerror_rejected(self):
        # urlparse raises ValueError on a malformed IPv6 literal → caught → False.
        assert cfg.is_valid_endpoint("https://[") is False


class TestParseSources:
    def test_empty_and_whitespace(self, monkeypatch):
        _set(monkeypatch, sources="   ")
        assert cfg.hafas_sources() == []

    def test_missing_env(self, monkeypatch):
        _set(monkeypatch, sources=None)
        assert cfg.hafas_sources() == []

    def test_invalid_json(self, monkeypatch):
        _set(monkeypatch, sources="{not json")
        assert cfg.hafas_sources() == []

    def test_json_not_a_list(self, monkeypatch):
        _set(monkeypatch, sources='{"id":"bw"}')
        assert cfg.hafas_sources() == []

    def test_non_dict_item_skipped(self, monkeypatch):
        _set(monkeypatch, sources=json.dumps(["nope", _VALID_SOURCE]))
        srcs = cfg.hafas_sources()
        assert [s["id"] for s in srcs] == ["bw"]

    def test_missing_required_field_skipped(self, monkeypatch):
        bad = {"id": "x", "endpoint": "https://h.example/m"}  # no aid
        _set(monkeypatch, sources=json.dumps([bad, _VALID_SOURCE]))
        assert [s["id"] for s in cfg.hafas_sources()] == ["bw"]

    def test_non_https_endpoint_skipped(self, monkeypatch):
        evil = {"id": "e", "endpoint": "http://169.254.169.254/", "aid": "A"}
        _set(monkeypatch, sources=json.dumps([evil, _VALID_SOURCE]))
        assert [s["id"] for s in cfg.hafas_sources()] == ["bw"]

    def test_valid_source_included(self, monkeypatch):
        _set(monkeypatch, sources=json.dumps([_VALID_SOURCE]))
        assert cfg.hafas_sources() == [_VALID_SOURCE]


class TestPrimarySource:
    def test_none_when_empty(self, monkeypatch):
        _set(monkeypatch, sources="[]")
        assert cfg.primary_source() is None

    def test_prefers_bw_id(self, monkeypatch):
        other = {"id": "nrw", "endpoint": "https://h.example/n", "aid": "N"}
        _set(monkeypatch, sources=json.dumps([other, _VALID_SOURCE]))
        assert cfg.primary_source()["id"] == "bw"

    def test_falls_back_to_first_when_no_bw(self, monkeypatch):
        a = {"id": "nrw", "endpoint": "https://h.example/n", "aid": "N"}
        b = {"id": "rlp", "endpoint": "https://h.example/r", "aid": "R"}
        _set(monkeypatch, sources=json.dumps([a, b]))
        assert cfg.primary_source()["id"] == "nrw"


class TestLoadMemoization:
    def test_memoized_until_reset(self, monkeypatch):
        _set(monkeypatch, carto="first")
        assert cfg.carto_key() == "first"
        # Change env WITHOUT reset → memoized value persists.
        monkeypatch.setenv("BUSRADAR_CARTO_KEY", "second")
        assert cfg.carto_key() == "first"
        cfg.reset()
        assert cfg.carto_key() == "second"

    def test_empty_sources_logs_warning(self, monkeypatch, caplog):
        import logging

        _set(monkeypatch, sources="[]")
        with caplog.at_level(logging.WARNING, logger="busradar"):
            cfg.load()
        assert any("no usable HAFAS sources" in r.message for r in caplog.records)
