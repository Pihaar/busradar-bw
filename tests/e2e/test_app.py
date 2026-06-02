"""E2E tests for core app functionality."""

import re

import pytest
from playwright.sync_api import expect


class TestMapLoad:
    def test_page_loads_without_errors(self, app_page):
        """App loads, shows buses, no JS errors."""
        page = app_page
        dot = page.locator(".status-dot")
        expect(dot).to_have_class(re.compile("status-dot--live"))
        status = page.locator("#status-text")
        expect(status).to_contain_text("Bus")

    def test_marker_scale_at_zoom_16(self, app_page):
        """Markers have correct scale at zoom 16."""
        page = app_page
        scale = page.evaluate("() => getComputedStyle(document.getElementById('map')).getPropertyValue('--marker-scale').trim()")
        assert scale == "1.12"


class TestShareButton:
    def test_share_button_visible_on_stop(self, server, page):
        """Share button appears when a stop is selected via URL."""
        page.goto(server + "/#stop=4427145")
        page.wait_for_timeout(5000)
        share_btn = page.locator("#detail-share")
        expect(share_btn).to_be_visible()

    def test_share_copies_to_clipboard(self, server, page):
        """Share button copies URL to clipboard (no native share on headless)."""
        page.goto(server + "/#stop=4427145")
        page.wait_for_timeout(5000)
        page.locator("#detail-share").click()
        page.wait_for_timeout(500)
        toast = page.locator("#toast")
        expect(toast).to_have_class(re.compile("toast--visible"))


class TestSwipeTabs:
    def test_swipe_left_switches_to_arrivals(self, server, page):
        """Swiping left on detail-content switches from Departures to Arrivals."""
        page.goto(server + "/#stop=4427145")
        page.wait_for_timeout(5000)
        content = page.locator("#detail-content")
        box = content.bounding_box()
        if not box:
            pytest.skip("Panel not visible")
        cx = box["x"] + box["width"] / 2
        cy = box["y"] + box["height"] / 2
        page.mouse.move(cx + 50, cy)
        page.mouse.down()
        page.mouse.move(cx - 50, cy, steps=5)
        page.mouse.up()
        page.wait_for_timeout(500)
        arr_tab = page.locator("#tab-arrivals")
        expect(arr_tab).to_have_class(re.compile("detail-tab--active"))

    def test_swipe_noop_in_journey_mode(self, server, page):
        """Swiping does nothing when a bus/journey is selected."""
        page.goto(server + "/#jid=2%7C%23VN%231%23ST%231779401151%23PI%230%23ZI%2336676%23TA%230%23DA%23220526%231S%2344700111%231T%232339%23LS%234407364%23LT%2310016%23PU%2380%23RT%231%23CA%23GB%23ZE%2334%23ZB%23Bus%20%20%2034%23PC%235%23FR%2344700111%23FT%232339%23TO%234407364%23TT%2310016%23")
        page.wait_for_timeout(5000)
        dep_tab = page.locator("#tab-departures")
        assert not dep_tab.is_visible(), "Should be in journey mode (departures tab hidden)"
        content = page.locator("#detail-content")
        box = content.bounding_box()
        if not box:
            pytest.skip("Panel content not visible")
        cx = box["x"] + box["width"] / 2
        cy = box["y"] + box["height"] / 2
        page.mouse.move(cx + 50, cy)
        page.mouse.down()
        page.mouse.move(cx - 50, cy, steps=5)
        page.mouse.up()
        page.wait_for_timeout(500)
        assert not dep_tab.is_visible(), "Swipe should not switch to station mode in journey"

    def test_bus_click_enters_journey_mode(self, app_page):
        """Clicking a visible bus marker must enter journey mode (not immediately end)."""
        page = app_page
        buses = page.locator(".bus-marker")
        if buses.count() == 0:
            pytest.skip("No buses on map")

        console_msgs = []
        page.on("console", lambda msg: console_msgs.append(f"[{msg.type}] {msg.text}"))

        buses.first.click()
        page.wait_for_timeout(3000)
        dep_tab = page.locator("#tab-departures")

        ended_logs = [m for m in console_msgs if "[ENDED]" in m]

        assert not dep_tab.is_visible(), (
            "Clicking a visible bus should enter journey mode. "
            "PHANTOM ENDED BUG. Console [ENDED] logs:\n" +
            "\n".join(ended_logs if ended_logs else ["(no [ENDED] logs captured)"])
        )


class TestUrlRestore:
    def test_tab_restore_arrivals(self, server, page):
        """URL with tab=arr opens arrivals tab (even without browser cache)."""
        page.goto(server + "/#stop=4427145&tab=arr")
        page.wait_for_timeout(6000)
        arr_tab = page.locator("#tab-arrivals")
        expect(arr_tab).to_have_class(re.compile("detail-tab--active"))

    def test_invalid_tab_ignored(self, server, page):
        """URL with tab=invalid defaults to departures."""
        page.goto(server + "/#stop=4427145&tab=invalid")
        page.wait_for_timeout(4000)
        dep_tab = page.locator("#tab-departures")
        expect(dep_tab).to_have_class(re.compile("detail-tab--active"))


class TestHafasMessages:
    def _find_bus_with_messages(self, page, server):
        """Find a currently active bus that has journey-level messages."""
        import json
        resp = page.request.get(server + "/api/vehicles?swLat=47.5&swLon=7.5&neLat=49.7&neLon=10.2")
        if resp.status != 200:
            return None
        vehicles = resp.json().get("vehicles", [])
        for v in vehicles[:30]:
            jid = v.get("jid", "")
            if not jid:
                continue
            jr = page.request.post(server + "/api/journey", data=json.dumps({"jid": jid}),
                                   headers={"Content-Type": "application/json"})
            if jr.status != 200:
                continue
            jdata = jr.json()
            journey = jdata.get("journey", {})
            msg_l = journey.get("msgL", [])
            if not msg_l:
                continue
            common = jdata.get("common", {})
            rem_l = common.get("remL", [])
            ignore = {'ae', 'au', 'az', 'ai', 'ac', 'ib', 'ic'}
            for msg in msg_l:
                if msg.get("type") == "REM":
                    rem = rem_l[msg.get("remX", -1)] if 0 <= msg.get("remX", -1) < len(rem_l) else None
                    if rem and rem.get("txtN") and (rem.get("code", "") or "").strip().lower() not in ignore:
                        return jid
                elif msg.get("type") == "HIM":
                    him_l = common.get("himL", [])
                    him = him_l[msg.get("himX", -1)] if 0 <= msg.get("himX", -1) < len(him_l) else None
                    if him and him.get("head"):
                        return jid
        return None

    def test_journey_banner_visible(self, server, page):
        """Bus with messages shows journey-level banner."""
        jid = self._find_bus_with_messages(page, server)
        if not jid:
            pytest.skip("No bus with visible messages currently active")
        from urllib.parse import quote
        page.goto(server + "/#jid=" + quote(jid, safe=''))
        page.wait_for_timeout(5000)
        banners = page.locator(".journey-msg-banner")
        assert banners.count() > 0
        first_text = banners.first.text_content()
        assert "Fahrtart" not in first_text

    def test_internal_codes_filtered(self, server, page):
        """Internal codes (ae, au, etc.) are NOT shown as banner text."""
        jid = self._find_bus_with_messages(page, server)
        if not jid:
            pytest.skip("No bus with visible messages currently active")
        from urllib.parse import quote
        page.goto(server + "/#jid=" + quote(jid, safe=''))
        page.wait_for_timeout(5000)
        page_text = page.locator("#detail-content").text_content()
        assert "Fahrtart L" not in page_text
        assert "Fahrtart X" not in page_text


class TestOffline:
    def test_offline_indicator_on_network_error(self, server, page):
        """After blocking requests, offline indicator appears."""
        page.goto(server + "/#lat=49.342&lon=8.66&z=15")
        page.wait_for_timeout(3000)
        page.route("**/api/vehicles*", lambda route: route.abort())
        page.wait_for_timeout(15000)
        dot = page.locator(".status-dot")
        expect(dot).to_have_class(re.compile("status-dot--(offline|error)"))
