"""E2E tests for special stop edge cases (from memory/test-cases-special-stops.md)."""



class TestStLeonRotSee:
    def test_only_once_in_search(self, server, page):
        """St. Leon-Rot See: only 1x in search results (dedup by coords)."""
        page.goto(server + "/#lat=49.28&lon=8.58&z=15")
        page.wait_for_timeout(3000)
        results = page.evaluate("""() =>
            fetch('/api/search?q=St.+Leon-Rot+See&lat=49.28&lon=8.58')
                .then(r => r.json())
                .then(d => d.results.filter(s => s.name === 'St. Leon-Rot See').length)
        """)
        assert results == 1


class TestSAPDeutschland:
    def test_direction_filter_4427111(self, server, page):
        """Stop 4427111 shows only Heidelberg-bound departures, never St. Leon-Rot."""
        page.goto(server + "/#lat=49.295&lon=8.639&z=17")
        page.wait_for_timeout(2000)
        data = page.evaluate("""() =>
            fetch('/api/stationboard', {method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({lid:'A=1@L=4427111@', type:'DEP', dur:120})})
                .then(r => r.json())
                .then(d => {
                    const locL = (d.common || {}).locL || [];
                    const jnyL = d.jnyL || [];
                    return jnyL.map(j => {
                        const stb = j.stbStop || {};
                        const loc = locL[stb.locX] || {};
                        return {extId: loc.extId, dir: j.dirTxt};
                    }).filter(e => e.extId === '4427111');
                })
        """)
        for dep in data:
            assert "St. Leon" not in dep["dir"], f"4427111 should not have St. Leon-Rot direction: {dep['dir']}"

    def test_direction_filter_4407111(self, server, page):
        """Stop 4407111 shows only St. Leon-Rot-bound departures, never Heidelberg."""
        page.goto(server + "/#lat=49.295&lon=8.639&z=17")
        page.wait_for_timeout(2000)
        data = page.evaluate("""() =>
            fetch('/api/stationboard', {method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({lid:'A=1@L=4407111@', type:'DEP', dur:120})})
                .then(r => r.json())
                .then(d => {
                    const locL = (d.common || {}).locL || [];
                    const jnyL = d.jnyL || [];
                    return jnyL.map(j => {
                        const stb = j.stbStop || {};
                        const loc = locL[stb.locX] || {};
                        return {extId: loc.extId, dir: j.dirTxt};
                    }).filter(e => e.extId === '4407111');
                })
        """)
        for dep in data:
            assert "Heidelberg" not in dep["dir"], f"4407111 should not have Heidelberg direction: {dep['dir']}"


class TestWieslochWalldorf:
    def test_steig_a_no_line_721(self, server, page):
        """Steig A (44278341) should NOT have line 721 departures."""
        page.goto(server + "/#lat=49.3&lon=8.65&z=15")
        page.wait_for_timeout(2000)
        data = page.evaluate("""() =>
            fetch('/api/stationboard', {method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({lid:'A=1@L=44278341@', type:'DEP', dur:1440})})
                .then(r => r.json())
                .then(d => {
                    const locL = (d.common || {}).locL || [];
                    const prodL = (d.common || {}).prodL || [];
                    const jnyL = d.jnyL || [];
                    return jnyL.filter(j => {
                        const loc = locL[(j.stbStop || {}).locX] || {};
                        const prod = prodL[j.prodX] || {};
                        return loc.extId === '44278341' && (prod.nameS === '721' || prod.name === 'Bus  721');
                    }).length;
                })
        """)
        assert data == 0, f"Steig A should have 0 line 721 departures, got {data}"

    def test_steig_a_plus1d_badge_on_wrap(self, server, page):
        """Steig A (44278341): +1d badge appears when departure times wrap past midnight."""
        page.goto(server + "/#stop=44278341")
        # Wait for auto-expand to load enough departures (up to 30s)
        page.wait_for_timeout(3000)
        # Check raw data for wrap existence
        result = page.evaluate("""() =>
            fetch('/api/stationboard', {method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({lid:'A=1@L=44278341@', type:'DEP', dur:1440})})
                .then(r => r.json())
                .then(d => {
                    const locL = (d.common || {}).locL || [];
                    const jnyL = d.jnyL || [];
                    let prevHour = -1;
                    let hasWrap = false;
                    let hasOffsetPrefix = false;
                    const filtered = jnyL.filter(j => {
                        const loc = locL[(j.stbStop || {}).locX] || {};
                        return loc.extId === '44278341';
                    });
                    for (const j of filtered) {
                        const stb = j.stbStop || {};
                        const t = stb.dTimeS || stb.dTimeR || '';
                        if (t.length > 6) hasOffsetPrefix = true;
                        if (t.length >= 4) {
                            const h = parseInt(t.length > 6 ? t.slice(t.length-6, t.length-4) : t.slice(0,2));
                            if (prevHour > 20 && h < 6) hasWrap = true;
                            prevHour = h;
                        }
                    }
                    return {total: filtered.length, hasWrap, hasOffsetPrefix};
                })
        """)
        if result["total"] == 0:
            return  # No departures — pass
        if not result["hasWrap"] and not result["hasOffsetPrefix"]:
            return  # No midnight wrap in data — nothing to test
        # Wait for auto-expand to reach the midnight departures (click load more)
        for _ in range(10):
            btn = page.locator("#departure-list .load-more-btn")
            if btn.count() > 0 and btn.is_visible():
                btn.click()
                page.wait_for_timeout(2000)
            else:
                break
        # Now check for badges
        badges = page.locator(".departure-day-badge")
        assert badges.count() > 0, f"Expected +1d badge on midnight wrap. Data: {result}"

    def test_steig_west1_no_departures(self, server, page):
        """Steig West1 (44278342) should have no departures."""
        page.goto(server + "/#lat=49.3&lon=8.65&z=15")
        page.wait_for_timeout(2000)
        data = page.evaluate("""() =>
            fetch('/api/stationboard', {method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({lid:'A=1@L=44278342@', type:'DEP', dur:1440})})
                .then(r => r.json())
                .then(d => {
                    const locL = (d.common || {}).locL || [];
                    const jnyL = d.jnyL || [];
                    return jnyL.filter(j => {
                        const loc = locL[(j.stbStop || {}).locX] || {};
                        return loc.extId === '44278342';
                    }).length;
                })
        """)
        assert data == 0, f"Steig West1 should have 0 departures, got {data}"

    def test_steig_west2_no_arrivals(self, server, page):
        """Steig West2 (44278343) should have no arrivals."""
        page.goto(server + "/#lat=49.3&lon=8.65&z=15")
        page.wait_for_timeout(2000)
        data = page.evaluate("""() =>
            fetch('/api/stationboard', {method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({lid:'A=1@L=44278343@', type:'ARR', dur:1440})})
                .then(r => r.json())
                .then(d => {
                    const locL = (d.common || {}).locL || [];
                    const jnyL = d.jnyL || [];
                    return jnyL.filter(j => {
                        const loc = locL[(j.stbStop || {}).locX] || {};
                        return loc.extId === '44278343';
                    }).length;
                })
        """)
        assert data == 0, f"Steig West2 should have 0 arrivals, got {data}"


class TestAlbbruckBad:
    def test_two_separate_stops_on_map(self, server, page):
        """Albbruck Bad (3004042/3494042): MUST be 2 separate stops on map."""
        page.goto(server + "/#lat=47.596&lon=8.139&z=16")
        page.wait_for_timeout(2000)
        data = page.evaluate("""() =>
            fetch('/api/stops?lat=47.596&lon=8.139&radius=500')
                .then(r => r.json())
                .then(d => d.stops.filter(s => s.name.includes('Albbruck') && s.name.includes('Bad')))
        """)
        ext_ids = [s["extId"] for s in data]
        assert "3004042" in ext_ids, f"3004042 missing from map stops: {ext_ids}"
        assert "3494042" in ext_ids, f"3494042 missing from map stops: {ext_ids}"
        assert len(data) == 2, f"Expected exactly 2 Albbruck Bad stops, got {len(data)}"


class TestHeidelbergHbfWest:
    def test_not_searchable(self, server, page):
        """Heidelberg Hauptbahnhof West: MUST NOT be searchable (ghost entry)."""
        page.goto(server + "/#lat=49.4&lon=8.67&z=15")
        page.wait_for_timeout(2000)
        data = page.evaluate("""() =>
            fetch('/api/search?q=Heidelberg+Hauptbahnhof+West&lat=49.4&lon=8.67')
                .then(r => r.json())
                .then(d => d.results.filter(s => s.name === 'Heidelberg Hauptbahnhof West'))
        """)
        assert len(data) == 0, f"Heidelberg Hbf West should NOT be searchable, got: {data}"

    def test_not_on_map(self, server, page):
        """Heidelberg Hauptbahnhof West: MUST NOT appear in stops layer on map."""
        page.goto(server + "/#lat=49.404&lon=8.675&z=16")
        page.wait_for_timeout(3000)
        data = page.evaluate("""() =>
            fetch('/api/stops?lat=49.404&lon=8.675&radius=2000')
                .then(r => r.json())
                .then(d => d.stops.filter(s => s.name === 'Heidelberg Hauptbahnhof West'))
        """)
        assert len(data) == 0, f"Heidelberg Hbf West should NOT be on map, got: {data}"
