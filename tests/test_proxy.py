"""Tests for proxy endpoints — input validation, error handling, CSP hash."""

import hashlib
import base64
import re
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from proxy import app, breaker


@pytest.fixture(autouse=True)
def reset_breaker():
    """Reset circuit breaker state between tests."""
    breaker.failures = 0
    breaker.last_failure_time = 0.0
    yield
    breaker.failures = 0
    breaker.last_failure_time = 0.0


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


class TestHealth:
    @pytest.mark.asyncio
    async def test_health_ok(self, client):
        resp = await client.get("/api/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert data["circuit_breaker"] == "closed"

    @pytest.mark.asyncio
    async def test_health_breaker_open(self, client):
        import time
        breaker.failures = 3
        breaker.last_failure_time = time.time()
        resp = await client.get("/api/health")
        data = resp.json()
        assert data["circuit_breaker"] == "open"

    @pytest.mark.asyncio
    async def test_health_version_present(self, client):
        import re
        resp = await client.get("/api/health")
        data = resp.json()
        assert "version" in data
        assert isinstance(data["version"], str)
        assert re.match(r"^[A-Za-z0-9._+\-]{1,64}$", data["version"])


class TestReadVersion:
    def test_version_from_file(self, tmp_path, monkeypatch):
        from proxy import _read_version
        import proxy
        vfile = tmp_path / "VERSION"
        vfile.write_text("v9.9.9\n")
        monkeypatch.setattr(proxy, "__file__", str(tmp_path / "proxy.py"))
        assert _read_version() == "v9.9.9"

    def test_version_file_empty_falls_through(self, tmp_path, monkeypatch):
        from proxy import _read_version
        import proxy
        (tmp_path / "VERSION").write_text("   \n")
        monkeypatch.setattr(proxy, "__file__", str(tmp_path / "proxy.py"))
        # Falls through to git or "unknown"; just assert not the empty/whitespace value
        result = _read_version()
        assert result != ""
        assert result.strip() == result

    def test_version_file_oversize_truncated(self, tmp_path, monkeypatch):
        from proxy import _read_version
        import proxy
        (tmp_path / "VERSION").write_text("v" + "a" * 10000)
        monkeypatch.setattr(proxy, "__file__", str(tmp_path / "proxy.py"))
        # 10001 chars, regex caps at 64 → rejected, falls through
        result = _read_version()
        assert len(result) <= 64

    def test_version_file_rejects_control_chars(self, tmp_path, monkeypatch):
        from proxy import _read_version
        import proxy
        (tmp_path / "VERSION").write_text("v1.0.0\x00; rm -rf /")
        monkeypatch.setattr(proxy, "__file__", str(tmp_path / "proxy.py"))
        result = _read_version()
        # Control chars + injection attempt rejected by regex, falls through
        assert "\x00" not in result
        assert ";" not in result

    def test_version_file_rejects_html(self, tmp_path, monkeypatch):
        from proxy import _read_version
        import proxy
        (tmp_path / "VERSION").write_text("<script>alert(1)</script>")
        monkeypatch.setattr(proxy, "__file__", str(tmp_path / "proxy.py"))
        result = _read_version()
        assert "<" not in result and ">" not in result

    def test_version_invalid_utf8_does_not_crash(self, tmp_path, monkeypatch):
        from proxy import _read_version
        import proxy
        (tmp_path / "VERSION").write_bytes(b"\xff\xfev1.0.0")
        monkeypatch.setattr(proxy, "__file__", str(tmp_path / "proxy.py"))
        result = _read_version()
        # Either falls through to "unknown" or rejected version, but no crash
        assert isinstance(result, str)

    def test_sanitize_accepts_valid(self):
        from proxy import _sanitize_version
        assert _sanitize_version("v1.0.0") == "v1.0.0"
        assert _sanitize_version("v1.0.4-3-geccfaa3-dirty") == "v1.0.4-3-geccfaa3-dirty"
        assert _sanitize_version("1.0+build.42") == "1.0+build.42"

    def test_sanitize_rejects_invalid(self):
        from proxy import _sanitize_version
        assert _sanitize_version("") is None
        assert _sanitize_version("   ") is None
        assert _sanitize_version("v1.0; rm -rf") is None
        assert _sanitize_version("v" * 65) is None
        assert _sanitize_version("v1.0\nINJECTION") is None
        assert _sanitize_version("hä") is None

    def test_git_missing_falls_through_to_unknown(self, tmp_path, monkeypatch):
        import proxy
        from proxy import _read_version
        monkeypatch.setattr(proxy, "__file__", str(tmp_path / "proxy.py"))
        monkeypatch.setattr(proxy.shutil, "which", lambda _: None)
        assert _read_version() == "unknown"

    def test_git_timeout_falls_through_to_unknown(self, tmp_path, monkeypatch):
        import proxy
        from proxy import _read_version
        monkeypatch.setattr(proxy, "__file__", str(tmp_path / "proxy.py"))
        monkeypatch.setattr(proxy.shutil, "which", lambda _: "/usr/bin/git")
        def raise_timeout(*a, **kw):
            raise proxy.subprocess.TimeoutExpired(cmd="git", timeout=2)
        monkeypatch.setattr(proxy.subprocess, "run", raise_timeout)
        assert _read_version() == "unknown"

    def test_git_nonzero_returncode_falls_through(self, tmp_path, monkeypatch):
        import proxy
        from proxy import _read_version
        monkeypatch.setattr(proxy, "__file__", str(tmp_path / "proxy.py"))
        monkeypatch.setattr(proxy.shutil, "which", lambda _: "/usr/bin/git")
        class FakeResult:
            returncode = 128
            stdout = b""
        monkeypatch.setattr(proxy.subprocess, "run", lambda *a, **kw: FakeResult())
        assert _read_version() == "unknown"

    def test_git_success_invalid_output_falls_through(self, tmp_path, monkeypatch):
        import proxy
        from proxy import _read_version
        monkeypatch.setattr(proxy, "__file__", str(tmp_path / "proxy.py"))
        monkeypatch.setattr(proxy.shutil, "which", lambda _: "/usr/bin/git")
        class FakeResult:
            returncode = 0
            stdout = b"<script>alert(1)</script>"
        monkeypatch.setattr(proxy.subprocess, "run", lambda *a, **kw: FakeResult())
        assert _read_version() == "unknown"

    def test_git_success_valid_output(self, tmp_path, monkeypatch):
        import proxy
        from proxy import _read_version
        monkeypatch.setattr(proxy, "__file__", str(tmp_path / "proxy.py"))
        monkeypatch.setattr(proxy.shutil, "which", lambda _: "/usr/bin/git")
        class FakeResult:
            returncode = 0
            stdout = b"v2.3.4-dirty\n"
        monkeypatch.setattr(proxy.subprocess, "run", lambda *a, **kw: FakeResult())
        assert _read_version() == "v2.3.4-dirty"


class TestInputValidation:
    @pytest.mark.asyncio
    async def test_vehicles_inverted_bounds(self, client):
        resp = await client.get("/api/vehicles?swLat=50&neLat=49&swLon=8&neLon=9")
        assert resp.status_code == 400
        assert resp.json()["error"] == "invalid_request"

    @pytest.mark.asyncio
    async def test_vehicles_out_of_range(self, client):
        resp = await client.get("/api/vehicles?swLat=44&neLat=49&swLon=8&neLon=9")
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_journey_invalid_jid(self, client):
        resp = await client.post("/api/journey", json={"jid": "<script>alert(1)</script>"})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_journey_jid_too_long(self, client):
        resp = await client.post("/api/journey", json={"jid": "A" * 301})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_journey_valid_jid_format(self, client):
        resp = await client.post("/api/journey", json={"jid": "1|12345|0|80|22052026"})
        assert resp.status_code in (200, 502)

    @pytest.mark.asyncio
    async def test_stationboard_invalid_lid(self, client):
        resp = await client.post("/api/stationboard", json={"lid": "invalid", "type": "DEP"})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_stationboard_valid_lid(self, client):
        resp = await client.post("/api/stationboard", json={"lid": "A=1@L=6003411@", "type": "DEP", "dur": 60})
        assert resp.status_code in (200, 502)

    @pytest.mark.asyncio
    async def test_stationboard_invalid_type(self, client):
        resp = await client.post("/api/stationboard", json={"lid": "A=1@L=6003411@", "type": "INVALID"})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_search_too_short(self, client):
        resp = await client.get("/api/search?q=a")
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_search_valid(self, client):
        resp = await client.get("/api/search?q=Sandhausen")
        assert resp.status_code in (200, 502)


class TestSecurityHeaders:
    @pytest.mark.asyncio
    async def test_csp_present(self, client):
        resp = await client.get("/api/health")
        csp = resp.headers.get("content-security-policy")
        assert csp is not None
        assert "default-src 'self'" in csp
        assert "script-src 'self'" in csp
        assert "frame-ancestors 'none'" in csp

    @pytest.mark.asyncio
    async def test_security_headers(self, client):
        resp = await client.get("/api/health")
        assert resp.headers.get("x-content-type-options") == "nosniff"
        assert resp.headers.get("x-frame-options") == "DENY"
        assert "strict-origin" in resp.headers.get("referrer-policy", "")


class TestCSPHash:
    def test_csp_hash_matches_inline_script(self):
        """Verify CSP sha256 hash matches the actual inline script in index.html."""
        index_path = Path(__file__).parent.parent / "static" / "index.html"
        content = index_path.read_text()

        match = re.search(r'<script>(.*?)</script>', content)
        assert match, "No inline script found in index.html"
        script_body = match.group(1)

        computed_hash = base64.b64encode(
            hashlib.sha256(script_body.encode('utf-8')).digest()
        ).decode('ascii')

        proxy_path = Path(__file__).parent.parent / "proxy.py"
        proxy_content = proxy_path.read_text()
        csp_match = re.search(r"'sha256-([^']+)'", proxy_content)
        assert csp_match, "No sha256 hash found in proxy.py CSP"
        stored_hash = csp_match.group(1)

        assert computed_hash == stored_hash, (
            f"CSP hash mismatch!\n"
            f"  Computed from index.html: sha256-{computed_hash}\n"
            f"  Stored in proxy.py:       sha256-{stored_hash}\n"
            f"  Update proxy.py CSP header after changing the inline script."
        )


class TestSearchEndpoint:
    """Tests for /api/search with injected stops_data."""

    SAMPLE_STOPS = [
        {"name": "Heidelberg Hbf", "lid": "A=1@L=8000156@", "lat": 49.4044, "lon": 8.6753, "extId": "8000156", "platform": ""},
        {"name": "Heidelberg Bismarckplatz", "lid": "A=1@L=6002500@", "lat": 49.4098, "lon": 8.6847, "extId": "6002500", "platform": ""},
        {"name": "Sandhausen Altes Rathaus", "lid": "A=1@L=6003411@", "lat": 49.3420, "lon": 8.6598, "extId": "6003411", "platform": ""},
        {"name": "Sandhausen Neues Rathaus", "lid": "A=1@L=6003466@", "lat": 49.3435, "lon": 8.6590, "extId": "6003466", "platform": ""},
        {"name": "St. Leon-Rot See", "lid": "A=1@L=6004111@", "lat": 49.2650, "lon": 8.6200, "extId": "6004111", "platform": ""},
        {"name": "St. Leon-Rot See", "lid": "A=1@L=6004112@", "lat": 49.2650, "lon": 8.6200, "extId": "6004112", "platform": ""},
    ]

    @pytest.fixture(autouse=True)
    def inject_stops(self):
        app.state.stops_data = {"stops": self.SAMPLE_STOPS}
        yield
        app.state.stops_data = {"stops": []}

    @pytest.mark.asyncio
    async def test_word_and_matching(self, client):
        resp = await client.get("/api/search?q=Heidelberg Hbf")
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] == 1
        assert data["results"][0]["name"] == "Heidelberg Hbf"

    @pytest.mark.asyncio
    async def test_case_insensitive(self, client):
        resp = await client.get("/api/search?q=heidelberg hbf")
        assert resp.status_code == 200
        assert resp.json()["count"] == 1

    @pytest.mark.asyncio
    async def test_partial_word_match(self, client):
        resp = await client.get("/api/search?q=Sandhausen")
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] == 2

    @pytest.mark.asyncio
    async def test_coord_key_dedup(self, client):
        """St. Leon-Rot See appears twice with same name+lat+lon → deduped to 1."""
        resp = await client.get("/api/search?q=St. Leon-Rot See")
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] == 1

    @pytest.mark.asyncio
    async def test_distance_sort(self, client):
        """With lat/lon near Sandhausen, Sandhausen stops come first."""
        resp = await client.get("/api/search?q=Rathaus&lat=49.342&lon=8.66")
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] == 2
        # Sandhausen is closer to given coords than any other "Rathaus"
        assert "Sandhausen" in data["results"][0]["name"]

    @pytest.mark.asyncio
    async def test_no_sort_without_both_coords(self, client):
        """lat without lon → no distance sort, still returns results."""
        resp = await client.get("/api/search?q=Heidelberg&lat=49.4")
        assert resp.status_code == 200
        assert resp.json()["count"] == 2

    @pytest.mark.asyncio
    async def test_result_cap_at_50(self, client):
        """Inject >50 matching stops, verify cap."""
        many_stops = [
            {"name": f"TestStop {i}", "lid": f"A=1@L={i}@", "lat": 49.0 + i * 0.001, "lon": 8.0 + i * 0.001, "extId": str(i), "platform": ""}
            for i in range(100)
        ]
        app.state.stops_data = {"stops": many_stops}
        resp = await client.get("/api/search?q=TestStop")
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] == 50
        assert len(data["results"]) == 50

    @pytest.mark.asyncio
    async def test_q_too_short_422(self, client):
        resp = await client.get("/api/search?q=a")
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_empty_stops_data(self, client):
        app.state.stops_data = {"stops": []}
        resp = await client.get("/api/search?q=Heidelberg")
        assert resp.status_code == 200
        assert resp.json()["count"] == 0

    @pytest.mark.asyncio
    async def test_no_match_returns_empty(self, client):
        resp = await client.get("/api/search?q=Xyznonexistent")
        assert resp.status_code == 200
        assert resp.json()["count"] == 0
