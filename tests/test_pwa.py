"""PWA-installability checks — deterministic, Lighthouse-free.

The PWA-installable surface (manifest, icons, service-worker registration,
install meta) has been effectively frozen since v1.0.0 — manifest and icons
each have a single commit (the initial release), and the sw.js churn was all
caching/bundling, not registration. A scheduled Lighthouse audit would be
disproportionate to that ~zero change rate; Lighthouse 12 also dropped the PWA
category entirely. These assertions run in the gated suite on every commit and
catch the real regression modes instead: a broken manifest field, a removed or
renamed icon, or a dropped install-meta tag.
"""

import json

import pytest

# Fields a browser needs for an installable PWA (plus the ones we rely on).
REQUIRED_MANIFEST_FIELDS = (
    "name",
    "short_name",
    "start_url",
    "scope",
    "display",
    "theme_color",
    "background_color",
    "icons",
)


class TestPWAManifest:
    @pytest.mark.asyncio
    async def test_manifest_served_and_has_required_fields(self, client):
        resp = await client.get("/manifest.webmanifest")
        assert resp.status_code == 200
        manifest = json.loads(resp.text)
        for key in REQUIRED_MANIFEST_FIELDS:
            assert manifest.get(key), f"manifest missing/empty field: {key}"
        # Installability + our expectations.
        assert manifest["display"] == "standalone"
        assert manifest["start_url"] == "/"
        assert manifest["scope"] == "/"

    @pytest.mark.asyncio
    async def test_manifest_has_192_512_and_maskable_icons(self, client):
        icons = json.loads((await client.get("/manifest.webmanifest")).text)["icons"]
        sizes = {i.get("sizes") for i in icons}
        assert "192x192" in sizes, "missing 192x192 icon (install prompt requirement)"
        assert "512x512" in sizes, "missing 512x512 icon (splash-screen requirement)"
        purposes = " ".join(i.get("purpose", "") for i in icons)
        assert "maskable" in purposes, "no maskable icon → degraded Android install icon"

    @pytest.mark.asyncio
    async def test_manifest_icons_are_actually_served(self, client):
        icons = json.loads((await client.get("/manifest.webmanifest")).text)["icons"]
        for icon in icons:
            resp = await client.get(icon["src"])
            assert resp.status_code == 200, f"manifest icon 404: {icon['src']}"
            assert resp.headers["content-type"].startswith("image/"), icon["src"]

    @pytest.mark.asyncio
    async def test_apple_touch_icon_served(self, client):
        resp = await client.get("/icons/apple-touch-icon.png")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("image/")


class TestPWAInstallMeta:
    @pytest.mark.asyncio
    async def test_index_carries_manifest_link_and_install_meta(self, client):
        html = (await client.get("/")).text
        assert '<link rel="manifest" href="/manifest.webmanifest">' in html
        assert 'name="theme-color"' in html
        assert 'rel="apple-touch-icon"' in html
        assert 'name="mobile-web-app-capable"' in html
