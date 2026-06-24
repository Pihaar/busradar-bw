import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { state, settings, SETTINGS_KEY, BACKOFF_BASE, getDelayClass, getDelayText, decodePolyline, applyI18n, t, extractHafasMessages, formatTime } from '../../static/state.js';
import { api, urlState } from '../../static/api.js';

describe.skip('api.getVehicles — removed in iter 2a (SSE migration)', () => {
  var originalFetch;
  beforeEach(() => {
    if (!settings.current) settings.init();
    originalFetch = window.fetch;
    window.fetch = vi.fn();
  });
  afterEach(() => {
    window.fetch = originalFetch;
  });

  it('calls fetch with correct params and returns json', async () => {
    var mockData = { vehicles: [{ jid: 'J1', lat: 49.3, lon: 8.6 }] };
    window.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(mockData) });

    var result = await api.getVehicles(49.0, 8.0, 49.5, 9.0);
    expect(window.fetch).toHaveBeenCalledOnce();
    var url = window.fetch.mock.calls[0][0];
    expect(url).toContain('/api/vehicles?');
    expect(url).toContain('swLat=49.00000');
    expect(url).toContain('neLat=49.50000');
    expect(url).toContain('posMode=');
    expect(result).toEqual(mockData);
  });

  it('throws on non-ok response', async () => {
    window.fetch.mockResolvedValue({ ok: false, status: 502 });
    await expect(api.getVehicles(49, 8, 50, 9)).rejects.toThrow('HTTP 502');
  });
});

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

describe('state._nextFreshDataIn (tick hint)', () => {
  it('is initialized to null', () => {
    expect(state._nextFreshDataIn).toBe(null);
  });

  it('accepts valid number >= 0', () => {
    state._nextFreshDataIn = 12.5;
    expect(state._nextFreshDataIn).toBe(12.5);
    state._nextFreshDataIn = 0;
    expect(state._nextFreshDataIn).toBe(0);
    state._nextFreshDataIn = null;
  });
});


// === Connected Clients header ===

describe.skip('api.getVehicles X-Client-Id header — removed in iter 2a (SSE migration)', () => {
  var originalFetch;
  beforeEach(() => {
    if (!settings.current) settings.init();
    originalFetch = window.fetch;
    window.fetch = vi.fn();
  });
  afterEach(() => {
    window.fetch = originalFetch;
    state._clientId = null;
  });

  it('adds X-Client-Id header when state._clientId is set', async () => {
    state._clientId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    window.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

    await api.getVehicles(49.0, 8.0, 49.5, 9.0);
    var opts = window.fetch.mock.calls[0][1];
    expect(opts).toBeDefined();
    expect(opts.headers).toEqual({ 'X-Client-Id': 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' });
  });

  it('omits header when state._clientId is null', async () => {
    state._clientId = null;
    window.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

    await api.getVehicles(49.0, 8.0, 49.5, 9.0);
    var opts = window.fetch.mock.calls[0][1];
    expect(opts).toBeUndefined();
  });

  it('still sends header with forceRefresh', async () => {
    state._clientId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
    window.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

    await api.getVehicles(49.0, 8.0, 49.5, 9.0, true);
    var url = window.fetch.mock.calls[0][0];
    var opts = window.fetch.mock.calls[0][1];
    expect(url).toContain('_t=');
    expect(opts.headers).toEqual({ 'X-Client-Id': 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb' });
  });
});
