import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { state, settings, SETTINGS_KEY, getDelayClass, getDelayText, decodePolyline, applyI18n, t, extractHafasMessages, formatTime } from '../../static/state.js';
import { api, urlState } from '../../static/api.js';

describe('api.getStops', () => {
  var originalFetch;
  beforeEach(() => {
    originalFetch = window.fetch;
    window.fetch = vi.fn();
  });
  afterEach(() => {
    window.fetch = originalFetch;
  });

  it('calls fetch with lat/lon/radius', async () => {
    window.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ stops: [] }) });
    await api.getStops(49.342, 8.66, 5000);
    var url = window.fetch.mock.calls[0][0];
    expect(url).toContain('lat=49.34200');
    expect(url).toContain('lon=8.66000');
    expect(url).toContain('radius=5000');
  });

  it('throws on non-ok response', async () => {
    window.fetch.mockResolvedValue({ ok: false, status: 500 });
    await expect(api.getStops(49.342, 8.66, 5000)).rejects.toThrow('HTTP 500');
  });
});

describe('api.getJourney', () => {
  var originalFetch;
  beforeEach(() => {
    originalFetch = window.fetch;
    window.fetch = vi.fn();
  });
  afterEach(() => {
    window.fetch = originalFetch;
  });

  it('sends POST with jid in body', async () => {
    window.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ journey: {} }) });
    await api.getJourney('1|123|0|80|20260523');
    expect(window.fetch.mock.calls[0][0]).toContain('/api/journey');
    var opts = window.fetch.mock.calls[0][1];
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ jid: '1|123|0|80|20260523' });
  });

  it('aborts previous user-initiated request', async () => {
    window.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    await api.getJourney('jid1', { userInitiated: true });
    await api.getJourney('jid2', { userInitiated: true });
    expect(window.fetch).toHaveBeenCalledTimes(2);
    var firstSignal = window.fetch.mock.calls[0][1].signal;
    expect(firstSignal.aborted).toBe(true);
  });

  it('throws on non-ok response', async () => {
    window.fetch.mockResolvedValue({ ok: false, status: 500 });
    await expect(api.getJourney('jid-x')).rejects.toThrow('HTTP 500');
  });
});

describe('api.getStationBoard', () => {
  var originalFetch;
  beforeEach(() => {
    originalFetch = window.fetch;
    window.fetch = vi.fn();
  });
  afterEach(() => {
    window.fetch = originalFetch;
  });

  it('sends POST with lid, type, dur', async () => {
    window.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ jnyL: [] }) });
    await api.getStationBoard('A=1@L=6003411@', 'DEP', 120);
    var opts = window.fetch.mock.calls[0][1];
    expect(opts.method).toBe('POST');
    var body = JSON.parse(opts.body);
    expect(body.lid).toBe('A=1@L=6003411@');
    expect(body.type).toBe('DEP');
    expect(body.dur).toBe(120);
  });

  it('aborts previous DEP request on new DEP call', async () => {
    window.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    await api.getStationBoard('lid1', 'DEP', 60);
    await api.getStationBoard('lid2', 'DEP', 60);
    var firstSignal = window.fetch.mock.calls[0][1].signal;
    expect(firstSignal.aborted).toBe(true);
  });

  it('DEP and ARR use separate abort controllers', async () => {
    window.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    await api.getStationBoard('lid1', 'DEP', 60);
    await api.getStationBoard('lid2', 'ARR', 60);
    var depSignal = window.fetch.mock.calls[0][1].signal;
    expect(depSignal.aborted).toBe(false);
  });

  it('defaults to DEP type and 60 dur', async () => {
    window.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    await api.getStationBoard('lid1');
    var body = JSON.parse(window.fetch.mock.calls[0][1].body);
    expect(body.type).toBe('DEP');
    expect(body.dur).toBe(60);
  });

  it('throws on non-ok response', async () => {
    window.fetch.mockResolvedValue({ ok: false, status: 500 });
    await expect(api.getStationBoard('lid1', 'DEP', 60)).rejects.toThrow('HTTP 500');
  });
});

describe('api.selectStream (debounced)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.fetch = vi.fn();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete window.fetch;
  });

  it('coalesces rapid calls into a single POST with the last selection', async () => {
    window.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
    const p1 = api.selectStream('stationboard', 'A=1@L=1@', 'DEP', 60);
    const p2 = api.selectStream('stationboard', 'A=1@L=1@', 'DEP', 120);
    const p3 = api.selectStream('stationboard', 'A=1@L=1@', 'DEP', 300);
    // Before the debounce window elapses, no POST has gone out.
    expect(window.fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(260);
    // Exactly one POST, with the LAST selection's dur.
    expect(window.fetch).toHaveBeenCalledOnce();
    const body = JSON.parse(window.fetch.mock.calls[0][1].body);
    expect(body.selection.dur).toBe(300);
    // All three promises resolve (with the same response object).
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toEqual({ ok: true });
    expect(r2).toEqual({ ok: true });
    expect(r3).toEqual({ ok: true });
  });

  it('rejects all queued callers when the coalesced POST fails', async () => {
    window.fetch.mockResolvedValue({ ok: false, status: 500 });
    const p1 = api.selectStream('stationboard', 'A=1@L=1@', 'DEP', 60).catch(e => e);
    const p2 = api.selectStream('stationboard', 'A=1@L=1@', 'DEP', 120).catch(e => e);
    await vi.advanceTimersByTimeAsync(260);
    const [e1, e2] = await Promise.all([p1, p2]);
    expect(e1).toBeInstanceOf(Error);
    expect(e2).toBeInstanceOf(Error);
    expect(e1.message).toMatch(/HTTP 500/);
  });

  it('passes non-multiple-of-60 dur through unchanged so the server 422s', async () => {
    // No silent client-side clamp: a caller bug producing dur=75 must
    // surface as a server-side 422, not get rewritten to 60. The test
    // checks the wire payload, not the response (mock returns ok).
    window.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    api.selectStream('stationboard', 'A=1@L=1@', 'DEP', 75);
    await vi.advanceTimersByTimeAsync(260);
    const body = JSON.parse(window.fetch.mock.calls[0][1].body);
    expect(body.selection.dur).toBe(75);
  });

  it('still clamps NaN/undefined dur to 60 (legitimate defensive default)', async () => {
    window.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    api.selectStream('stationboard', 'A=1@L=1@', 'DEP', undefined);
    await vi.advanceTimersByTimeAsync(260);
    const body = JSON.parse(window.fetch.mock.calls[0][1].body);
    expect(body.selection.dur).toBe(60);
  });

  it('clamps above-1440 dur to 1440 (upper-bound defensive default)', async () => {
    window.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    api.selectStream('stationboard', 'A=1@L=1@', 'DEP', 9999);
    await vi.advanceTimersByTimeAsync(260);
    const body = JSON.parse(window.fetch.mock.calls[0][1].body);
    expect(body.selection.dur).toBe(1440);
  });

  it('caps the debounce queue at 64 by rejecting the oldest pending caller', async () => {
    // A tight-loop caller (compromised extension, DevTools script) keeps
    // resetting the 250ms timer so the flush never fires. Without a cap
    // the resolver/rejecter arrays grow unbounded (self-DoS in the
    // attacker's own tab, but memory pressure regardless). With the cap
    // in place the 65th call boots the 1st call out with a "superseded"
    // rejection; nothing goes to the wire yet.
    window.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    const promises = [];
    for (let i = 0; i < 65; i++) {
      // Each call schedules a new timer, so the flush stays deferred.
      promises.push(api.selectStream('stationboard', 'A=1@L=1@', 'DEP', 60).catch(e => e));
    }
    // The oldest promise (index 0) resolves-to-error immediately when
    // the 65th call pushes it out — awaiting it must not hang.
    const oldest = await promises[0];
    expect(oldest).toBeInstanceOf(Error);
    expect(oldest.message).toMatch(/superseded/i);
    // No fetch yet; timer still hasn't fired.
    expect(window.fetch).not.toHaveBeenCalled();
    // Let the trailing edge fire so the remaining 64 waiters resolve
    // and pytest doesn't complain about unhandled rejections.
    await vi.advanceTimersByTimeAsync(260);
    expect(window.fetch).toHaveBeenCalledOnce();
  });
});

describe('urlState.saveMapPosition', () => {
  beforeEach(() => {
    state.map = {
      getCenter: () => ({ lat: 49.342, lng: 8.66 }),
      getZoom: () => 15,
    };
  });
  afterEach(() => {
    state.map = null;
  });

  it('calls replaceState with lat/lon/z', () => {
    var spy = vi.spyOn(window.history, 'replaceState');
    urlState.saveMapPosition();
    expect(spy).toHaveBeenCalledOnce();
    var hash = spy.mock.calls[0][2];
    expect(hash).toContain('lat=49.34200');
    expect(hash).toContain('lon=8.66000');
    expect(hash).toContain('z=15');
    spy.mockRestore();
  });
});

describe('settings', () => {
  beforeEach(() => {
    localStorage.clear();
    settings.current = null;
    settings._saveTimer = null;
    settings._userInterpolation = true;
  });

  describe('_loadAndValidate', () => {
    it('returns empty object when nothing stored', () => {
      expect(settings._loadAndValidate()).toEqual({});
    });

    it('returns empty on corrupt JSON', () => {
      localStorage.setItem(SETTINGS_KEY, 'not json{{{');
      expect(settings._loadAndValidate()).toEqual({});
    });

    it('validates refreshInterval', () => {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ refreshInterval: 20000 }));
      expect(settings._loadAndValidate().refreshInterval).toBe(20000);
    });

    it('rejects invalid refreshInterval', () => {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ refreshInterval: 5000 }));
      expect(settings._loadAndValidate().refreshInterval).toBeUndefined();
    });

    it('validates theme', () => {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ theme: 'light' }));
      expect(settings._loadAndValidate().theme).toBe('light');
    });

    it('rejects invalid theme', () => {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ theme: 'neon' }));
      expect(settings._loadAndValidate().theme).toBeUndefined();
    });

    it('validates interpolation as boolean', () => {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ interpolation: false }));
      expect(settings._loadAndValidate().interpolation).toBe(false);
    });

    it('rejects non-boolean interpolation', () => {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ interpolation: 'yes' }));
      expect(settings._loadAndValidate().interpolation).toBeUndefined();
    });

    it('validates posMode', () => {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ posMode: 'REPORT_ONLY' }));
      expect(settings._loadAndValidate().posMode).toBe('REPORT_ONLY');
    });

    it('validates lang', () => {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ lang: 'en' }));
      expect(settings._loadAndValidate().lang).toBe('en');
    });

    it('rejects invalid lang', () => {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ lang: 'fr' }));
      expect(settings._loadAndValidate().lang).toBeUndefined();
    });

    it('validates showLocation', () => {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ showLocation: true }));
      expect(settings._loadAndValidate().showLocation).toBe(true);
    });
  });

  describe('_save', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      settings.current = { refreshInterval: 10000, theme: 'dark', interpolation: true, posMode: 'CALC', lang: 'de', showLocation: false };
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('debounces and writes to localStorage after 300ms', () => {
      settings._save();
      expect(localStorage.getItem(SETTINGS_KEY)).toBeNull();
      vi.advanceTimersByTime(300);
      var stored = JSON.parse(localStorage.getItem(SETTINGS_KEY));
      expect(stored.theme).toBe('dark');
      expect(stored.refreshInterval).toBe(10000);
    });

    it('_flushSave writes immediately', () => {
      settings._save();
      settings._flushSave();
      var stored = JSON.parse(localStorage.getItem(SETTINGS_KEY));
      expect(stored.theme).toBe('dark');
    });

    it('debounces multiple rapid calls into a single localStorage write', () => {
      var setSpy = vi.spyOn(localStorage, 'setItem');
      settings._save();
      settings._save();
      settings._save();
      vi.advanceTimersByTime(300);
      var calls = setSpy.mock.calls.filter(function(c) { return c[0] === SETTINGS_KEY; });
      expect(calls.length).toBe(1);
      setSpy.mockRestore();
    });

    it('swallows localStorage errors in debounced save', () => {
      var setSpy = vi.spyOn(localStorage, 'setItem').mockImplementation(function() {
        throw new Error('quota exceeded');
      });
      settings._save();
      expect(function() { vi.advanceTimersByTime(300); }).not.toThrow();
      setSpy.mockRestore();
    });
  });

  describe('_updateGroup', () => {
    beforeEach(() => {
      document.body.innerHTML =
        '<div id="test-group">' +
        '<button class="settings-opt" data-value="a" aria-checked="false"></button>' +
        '<button class="settings-opt" data-value="b" aria-checked="false"></button>' +
        '</div>';
    });

    it('activates the matching option', () => {
      settings._updateGroup('test-group', 'a');
      var btns = document.querySelectorAll('#test-group .settings-opt');
      expect(btns[0].classList.contains('settings-opt--active')).toBe(true);
      expect(btns[0].getAttribute('aria-checked')).toBe('true');
      expect(btns[1].classList.contains('settings-opt--active')).toBe(false);
      expect(btns[1].getAttribute('aria-checked')).toBe('false');
    });

    it('deactivates all when no match', () => {
      settings._updateGroup('test-group', 'nonexistent');
      var btns = document.querySelectorAll('#test-group .settings-opt');
      expect(btns[0].classList.contains('settings-opt--active')).toBe(false);
      expect(btns[1].classList.contains('settings-opt--active')).toBe(false);
    });
  });

  describe('_updateHint', () => {
    beforeEach(() => {
      settings.current = { refreshInterval: 10000, theme: 'dark', interpolation: true, posMode: 'CALC', lang: 'de', showLocation: false };
      document.body.innerHTML = '<div id="settings-hint" hidden></div>';
    });

    it('hides hint when no map', () => {
      state.map = null;
      settings._updateHint();
      expect(document.getElementById('settings-hint').hidden).toBe(true);
    });

    it('shows hint when zoom below threshold', () => {
      state.map = { getZoom: () => 9 };
      settings._updateHint();
      var hint = document.getElementById('settings-hint');
      expect(hint.hidden).toBe(false);
      expect(hint.textContent).toContain('⚠');
    });

    it('hides hint when zoom is high enough', () => {
      state.map = { getZoom: () => 16 };
      settings._updateHint();
      expect(document.getElementById('settings-hint').hidden).toBe(true);
    });
  });

  describe('_applyThemeAttr', () => {
    beforeEach(() => {
      settings.current = { refreshInterval: 10000, theme: 'dark', interpolation: true, posMode: 'CALC', lang: 'de', showLocation: false };
      document.documentElement.setAttribute('data-theme', '');
      var existing = document.getElementById('meta-theme-color');
      if (existing) existing.remove();
    });

    it('sets data-theme attribute and updates meta theme-color for dark', () => {
      var meta = document.createElement('meta');
      meta.id = 'meta-theme-color';
      meta.setAttribute('name', 'theme-color');
      meta.content = '';
      document.head.appendChild(meta);
      settings.current.theme = 'dark';
      settings._applyThemeAttr();
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
      expect(document.getElementById('meta-theme-color').content).toBe('#0a0e1a');
    });

    it('updates meta theme-color for light theme', () => {
      var meta = document.createElement('meta');
      meta.id = 'meta-theme-color';
      meta.setAttribute('name', 'theme-color');
      meta.content = '';
      document.head.appendChild(meta);
      settings.current.theme = 'light';
      settings._applyThemeAttr();
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
      expect(document.getElementById('meta-theme-color').content).toBe('#f5f6fa');
    });

    it('does not throw when meta-theme-color element is absent', () => {
      settings.current.theme = 'dark';
      expect(function() { settings._applyThemeAttr(); }).not.toThrow();
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });
  });

  describe('_applyPosModeConstraint', () => {
    beforeEach(() => {
      settings.current = { refreshInterval: 10000, theme: 'dark', interpolation: true, posMode: 'CALC', lang: 'de', showLocation: false };
      settings._userInterpolation = true;
      document.body.innerHTML =
        '<div id="setting-interpolation">' +
        '<button class="settings-opt" data-value="on"></button>' +
        '<button class="settings-opt" data-value="off"></button>' +
        '</div>' +
        '<div id="hint-animation-disabled" hidden></div>';
    });

    it('disables interpolation when posMode is REPORT_ONLY', () => {
      settings.current.posMode = 'REPORT_ONLY';
      settings._applyPosModeConstraint();
      expect(settings.current.interpolation).toBe(false);
      var group = document.getElementById('setting-interpolation');
      expect(group.getAttribute('aria-disabled')).toBe('true');
      var hint = document.getElementById('hint-animation-disabled');
      expect(hint.hidden).toBe(false);
    });

    it('enables interpolation when posMode is CALC', () => {
      settings.current.posMode = 'CALC';
      settings._applyPosModeConstraint();
      expect(settings.current.interpolation).toBe(true);
      var group = document.getElementById('setting-interpolation');
      expect(group.getAttribute('aria-disabled')).toBe('false');
    });

    it('cancels animation frames and snaps markers when REPORT_ONLY', () => {
      var cafSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(function() {});
      var snapped = null;
      var entryWithFrame = {
        _animFrame: 42,
        data: { lat: 49.34, lon: 8.66 },
        marker: { setLatLng: function(latLng) { snapped = latLng; } },
      };
      var entryWithoutFrame = {
        _animFrame: null,
        data: { lat: 49.35, lon: 8.67 },
        marker: { setLatLng: function() {} },
      };
      var entryNoData = {
        _animFrame: 7,
        data: null,
        marker: { setLatLng: function() { throw new Error('should not be called'); } },
      };
      state.vehicles.clear();
      state.vehicles.set('v1', entryWithFrame);
      state.vehicles.set('v2', entryWithoutFrame);
      state.vehicles.set('v3', entryNoData);

      settings.current.posMode = 'REPORT_ONLY';
      settings._applyPosModeConstraint();

      expect(cafSpy).toHaveBeenCalledWith(42);
      expect(cafSpy).toHaveBeenCalledWith(7);
      expect(entryWithFrame._animFrame).toBeNull();
      expect(entryNoData._animFrame).toBeNull();
      expect(snapped).toEqual([49.34, 8.66]);

      state.vehicles.clear();
      cafSpy.mockRestore();
    });
  });

  describe('applyTileLayers', () => {
    it('returns early when no map', () => {
      state.map = null;
      settings.current = { theme: 'dark' };
      settings.applyTileLayers();
    });

    it('adds new layer and schedules old removal', () => {
      vi.useFakeTimers();
      var added = false, removed = false;
      var mockLayer = { addTo: function() { added = true; }, once: function(ev, fn) { fn(); } };
      var oldLayer = {};
      state.map = { hasLayer: function(l) { return l === oldLayer; }, removeLayer: function() { removed = true; } };
      state.darkTileLayer = mockLayer;
      state.lightTileLayer = oldLayer;
      settings.current = { theme: 'dark' };
      settings.applyTileLayers();
      expect(added).toBe(true);
      expect(removed).toBe(true);
      vi.useRealTimers();
    });
  });

  describe('init', () => {
    beforeEach(() => {
      document.documentElement.setAttribute('data-theme', '');
      document.documentElement.lang = '';
    });

    it('initializes with defaults when nothing stored', () => {
      settings.init();
      expect(settings.current.refreshInterval).toBe(10000);
      expect(settings.current.posMode).toBe('CALC');
      expect(settings.current.interpolation).toBe(true);
    });

    it('detects browser language preference', () => {
      settings.init();
      var expected = (navigator.language || 'de').toLowerCase().startsWith('en') ? 'en' : 'de';
      expect(settings.current.lang).toBe(expected);
    });

    it('merges stored settings with defaults', () => {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ theme: 'light', lang: 'en' }));
      settings.init();
      expect(settings.current.theme).toBe('light');
      expect(settings.current.lang).toBe('en');
      expect(settings.current.refreshInterval).toBe(10000);
    });

    it('sets data-theme attribute on documentElement', () => {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ theme: 'dark' }));
      settings.init();
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    it('sets document lang from settings', () => {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ lang: 'de' }));
      settings.init();
      expect(document.documentElement.lang).toBe('de');
    });

    it('disables interpolation when prefers-reduced-motion matches and no stored value', () => {
      var origMM = window.matchMedia;
      window.matchMedia = function(q) {
        if (q === '(prefers-reduced-motion: reduce)') return { matches: true };
        return { matches: false };
      };
      try {
        settings.init();
        expect(settings.current.interpolation).toBe(false);
      } finally {
        window.matchMedia = origMM;
      }
    });

    it('honors stored interpolation over prefers-reduced-motion', () => {
      var origMM = window.matchMedia;
      window.matchMedia = function(q) {
        if (q === '(prefers-reduced-motion: reduce)') return { matches: true };
        return { matches: false };
      };
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({ interpolation: true }));
        settings.init();
        expect(settings.current.interpolation).toBe(true);
      } finally {
        window.matchMedia = origMM;
      }
    });

    it('falls back to light theme when prefers-color-scheme is light and nothing stored', () => {
      var origMM = window.matchMedia;
      window.matchMedia = function(q) {
        if (q === '(prefers-color-scheme: light)') return { matches: true };
        return { matches: false };
      };
      try {
        settings.init();
        expect(settings.current.theme).toBe('light');
      } finally {
        window.matchMedia = origMM;
      }
    });

    it('defaults lang to "de" when navigator.language is empty/missing', () => {
      var origNav = Object.getOwnPropertyDescriptor(navigator, 'language');
      try {
        Object.defineProperty(navigator, 'language', { value: '', configurable: true });
        settings.init();
        expect(settings.current.lang).toBe('de');
      } finally {
        if (origNav) {
          Object.defineProperty(navigator, 'language', origNav);
        }
      }
    });
  });

  describe('getDelayClass', () => {
    it('returns nodata for null/undefined', () => {
      expect(getDelayClass(null)).toBe('nodata');
      expect(getDelayClass(undefined)).toBe('nodata');
    });

    it('returns early for delay <= -3', () => {
      expect(getDelayClass(-3)).toBe('early');
      expect(getDelayClass(-10)).toBe('early');
    });

    it('returns ontime for delay between -2 and 2', () => {
      expect(getDelayClass(-2)).toBe('ontime');
      expect(getDelayClass(0)).toBe('ontime');
      expect(getDelayClass(2)).toBe('ontime');
    });

    it('returns delayed for delay between 3 and 5', () => {
      expect(getDelayClass(3)).toBe('delayed');
      expect(getDelayClass(5)).toBe('delayed');
    });

    it('returns major-delay for delay > 5', () => {
      expect(getDelayClass(6)).toBe('major-delay');
      expect(getDelayClass(60)).toBe('major-delay');
    });
  });

  describe('getDelayText', () => {
    beforeEach(() => {
      if (!settings.current) settings.init();
    });

    it('returns translation for null/undefined', () => {
      expect(typeof getDelayText(null)).toBe('string');
      expect(getDelayText(null).length).toBeGreaterThan(0);
      expect(typeof getDelayText(undefined)).toBe('string');
    });

    it('returns ±0 for zero delay', () => {
      expect(getDelayText(0)).toBe('±0');
    });

    it('formats positive delay with + prefix', () => {
      expect(getDelayText(3)).toBe('+3 min');
      expect(getDelayText(15)).toBe('+15 min');
    });

    it('formats negative delay without extra sign', () => {
      expect(getDelayText(-2)).toBe('-2 min');
    });
  });

  describe('decodePolyline', () => {
    it('decodes a simple polyline string', () => {
      // Encoded "_p~iF~ps|U_ulLnnqC_mqNvxq`@" — Google's standard example
      var pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
      expect(pts.length).toBe(3);
      expect(pts[0][0]).toBeCloseTo(38.5, 1);
      expect(pts[0][1]).toBeCloseTo(-120.2, 1);
    });

    it('returns empty array for empty input', () => {
      expect(decodePolyline('')).toEqual([]);
    });

    it('uses custom precision when provided', () => {
      var pts = decodePolyline('_p~iF~ps|U', 1e6);
      expect(pts.length).toBe(1);
      expect(pts[0][0]).toBeCloseTo(3.85, 1);
    });

    it('decodes negative lat with positive lng (odd-lat, even-lng branches)', () => {
      // "@C" -> dlat=-1, dlng=2 (positive lat-component negative; lng positive)
      var pts = decodePolyline('@C');
      expect(pts.length).toBe(1);
      expect(pts[0][0]).toBeCloseTo(-0.00001, 5);
      expect(pts[0][1]).toBeCloseTo(0.00002, 5);
    });
  });

  describe('applyI18n', () => {
    beforeEach(() => {
      if (!settings.current) settings.init();
    });

    it('applies textContent, placeholder, and aria-label translations', () => {
      var root = document.createElement('div');
      root.innerHTML =
        '<span data-i18n="no_realtime"></span>' +
        '<input data-i18n-placeholder="no_realtime" />' +
        '<button data-i18n-aria="no_realtime"></button>';
      document.body.appendChild(root);
      try {
        applyI18n(root);
        var span = root.querySelector('[data-i18n]');
        var input = root.querySelector('[data-i18n-placeholder]');
        var btn = root.querySelector('[data-i18n-aria]');
        expect(span.textContent.length).toBeGreaterThan(0);
        expect(input.placeholder.length).toBeGreaterThan(0);
        expect(btn.getAttribute('aria-label').length).toBeGreaterThan(0);
      } finally {
        root.remove();
      }
    });

    it('falls back to "de" lang when settings.current is unset', () => {
      var saved = settings.current;
      settings.current = null;
      try {
        var root = document.createElement('div');
        applyI18n(root);
        expect(document.documentElement.lang).toBe('de');
      } finally {
        settings.current = saved;
      }
    });
  });

  describe('settings._flushSave error handling', () => {
    beforeEach(() => {
      settings.current = { refreshInterval: 10000, theme: 'dark', interpolation: true, posMode: 'CALC', lang: 'de', showLocation: false };
      settings._userInterpolation = true;
    });

    it('swallows localStorage errors when flushing', () => {
      vi.useFakeTimers();
      try {
        settings._save();
        var setSpy = vi.spyOn(localStorage, 'setItem').mockImplementation(function() {
          throw new Error('quota exceeded');
        });
        expect(function() { settings._flushSave(); }).not.toThrow();
        setSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });

    it('is a no-op when there is no pending timer', () => {
      settings._saveTimer = null;
      var setSpy = vi.spyOn(localStorage, 'setItem');
      settings._flushSave();
      expect(setSpy).not.toHaveBeenCalled();
      setSpy.mockRestore();
    });
  });

  describe('applyTileLayers theme branches', () => {
    afterEach(() => {
      state.map = null;
      state.lightTileLayer = null;
      state.darkTileLayer = null;
    });

    it('adds light layer when theme is light', () => {
      vi.useFakeTimers();
      try {
        var added = false;
        var lightLayer = { addTo: function() { added = true; }, once: function() {} };
        var darkLayer = {};
        state.map = { hasLayer: function() { return false; }, removeLayer: function() {} };
        state.lightTileLayer = lightLayer;
        state.darkTileLayer = darkLayer;
        settings.current = { theme: 'light' };
        settings.applyTileLayers();
        expect(added).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('returns early when new layer is already present', () => {
      var lightLayer = { addTo: function() { throw new Error('should not be called'); }, once: function() {} };
      var darkLayer = {};
      state.map = { hasLayer: function(l) { return l === lightLayer; }, removeLayer: function() {} };
      state.lightTileLayer = lightLayer;
      state.darkTileLayer = darkLayer;
      settings.current = { theme: 'light' };
      expect(function() { settings.applyTileLayers(); }).not.toThrow();
    });
  });

  describe('t() i18n helper', () => {
    it('returns key when no translation table entry exists in fallback either', () => {
      if (!settings.current) settings.init();
      var origI18N = window.I18N;
      window.I18N = { de: {}, en: {} };
      try {
        expect(t('missing_key_xyz')).toBe('missing_key_xyz');
      } finally {
        window.I18N = origI18N;
      }
    });

    it('substitutes parameters into translation strings', () => {
      if (!settings.current) settings.init();
      var origI18N = window.I18N;
      window.I18N = { de: { greet: 'Hallo {name}!' }, en: { greet: 'Hello {name}!' } };
      try {
        var prevLang = settings.current.lang;
        settings.current.lang = 'de';
        try {
          expect(t('greet', { name: 'World' })).toBe('Hallo World!');
        } finally {
          settings.current.lang = prevLang;
        }
      } finally {
        window.I18N = origI18N;
      }
    });

    it('falls back to "de" lang when settings.current is missing', () => {
      var saved = settings.current;
      settings.current = null;
      try {
        // Should not throw
        var result = t('no_realtime');
        expect(typeof result).toBe('string');
      } finally {
        settings.current = saved;
      }
    });

    it('falls back to "de" table when requested lang has no entry', () => {
      if (!settings.current) settings.init();
      var origI18N = window.I18N;
      window.I18N = { de: { foo: 'bar-de' }, en: {} };
      try {
        var prevLang = settings.current.lang;
        settings.current.lang = 'en';
        try {
          // 'foo' missing in 'en' -> falls through to 'de' table
          expect(t('foo')).toBe('bar-de');
        } finally {
          settings.current.lang = prevLang;
        }
      } finally {
        window.I18N = origI18N;
      }
    });

    it('falls back to "de" when lang is missing from I18N entirely', () => {
      if (!settings.current) settings.init();
      var origI18N = window.I18N;
      window.I18N = { de: { foo: 'bar-de' } };
      try {
        var prevLang = settings.current.lang;
        settings.current.lang = 'zz';
        try {
          expect(t('foo')).toBe('bar-de');
        } finally {
          settings.current.lang = prevLang;
        }
      } finally {
        window.I18N = origI18N;
      }
    });
  });

  describe('extractHafasMessages misc branches', () => {
    it('skips messages with non-REM/HIM type', () => {
      var result = extractHafasMessages({ remL: [], himL: [] }, [{ type: 'OTHER' }], []);
      expect(result.journeyLevel).toEqual([]);
      expect(result.perStopByLocX).toEqual({});
    });

    it('returns empty when msgL is missing', () => {
      var result = extractHafasMessages({}, null, []);
      expect(result.journeyLevel).toEqual([]);
    });
  });

  describe('formatTime offset branches', () => {
    it('returns empty for non-numeric offset prefix', () => {
      expect(formatTime('XX134500')).toBe('');
    });

    it('returns empty for non-numeric hour after offset', () => {
      // 8 chars, offset='01', hh='XX'
      expect(formatTime('01XX0000')).toBe('');
    });
  });
});


// === Connected Clients header ===
// The X-Client-Id header was an artefact of the UUID-keyed connected-clients
// counter; both are gone since the polling-to-SSE switch. Counter is now
// derived from len(SubscriberRegistry) server-side.

