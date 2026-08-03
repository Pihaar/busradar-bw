/**
 * Tests for the stopsLayer module: init (zoomend show/hide + loadFromCache),
 * localStorage cache load/save (fresh / stale / malformed), addStopMarker
 * (dedupe, tooltip label with/without platform, click → showStationBoard),
 * loadAll (zoom gate, dedupe key throttle, api resolve/reject), and
 * update(vehicles) (stop harvesting + skip rules).
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

const savedL = globalThis.L;

function makeLayerMock() {
  return {
    addTo: vi.fn(function () {
      return this;
    }),
  };
}

function makeCircleMarkerMock() {
  const m = {
    _clickCbs: [],
    bindTooltip: vi.fn(function () {
      return m;
    }),
    on: vi.fn(function (evt, cb) {
      if (evt === 'click') m._clickCbs.push(cb);
      return m;
    }),
    addTo: vi.fn(function () {
      return m;
    }),
  };
  return m;
}

globalThis.L = {
  layerGroup: vi.fn(() => makeLayerMock()),
  circleMarker: vi.fn(() => makeCircleMarkerMock()),
  marker: vi.fn(() => ({
    addTo: vi.fn(function () {
      return this;
    }),
  })),
  divIcon: vi.fn(() => ({})),
  latLng: (lat, lon) => ({ lat, lng: lon }),
};

const getStops = vi.fn();
vi.mock('../../static/api.js', () => ({
  trackedFetch: (...a) => window.fetch(...a),
  api: { subscribeBoard: () => Promise.resolve({}), getStops: (...a) => getStops(...a) },
}));
vi.mock('../../static/ui.js', () => ({ ui: { showStationBoard: vi.fn() } }));

const { stopsLayer } = await import('../../static/map.js');
const { state, settings } = await import('../../static/state.js');
const { ui } = await import('../../static/ui.js');

const CACHE_KEY = 'busradar_stops_v2';

function makeMapMock(zoom) {
  const handlers = {};
  return {
    _handlers: handlers,
    getZoom: vi.fn(() => zoom),
    getCenter: vi.fn(() => ({ lat: 49.34, lng: 8.66, distanceTo: () => 1000 })),
    getBounds: vi.fn(() => ({ getNorthEast: () => ({ lat: 49.4, lng: 8.7 }) })),
    on: vi.fn((evt, cb) => {
      (handlers[evt] = handlers[evt] || []).push(cb);
    }),
    addLayer: vi.fn(),
    removeLayer: vi.fn(),
    hasLayer: vi.fn(() => false),
  };
}

beforeEach(() => {
  state.allStops = new Map();
  state.map = makeMapMock(15);
  state.stopLayer = null;
  settings.current = { lang: 'de' };
  localStorage.clear();
  getStops.mockReset();
  ui.showStationBoard.mockClear();
  L.circleMarker.mockClear();
  L.layerGroup.mockClear();
  // Reset throttle memo left over between tests
  stopsLayer._lastKey = undefined;
  stopsLayer._lastFetch = undefined;
});

afterEach(() => {
  vi.useRealTimers();
  state.map = null;
});

afterAll(() => {
  globalThis.L = savedL;
});

describe('stopsLayer.addStopMarker', () => {
  beforeEach(() => {
    state.stopLayer = makeLayerMock();
  });

  it('adds a circleMarker, binds a platform-suffixed tooltip, and tracks it', () => {
    stopsLayer.addStopMarker({ lid: 'x1', name: 'Rathaus', lat: 49.34, lon: 8.66, platform: '2' });
    expect(L.circleMarker).toHaveBeenCalledOnce();
    const m = L.circleMarker.mock.results[0].value;
    // Tooltip is a DOM node (textContent), not a string — XSS-safe.
    const tip = m.bindTooltip.mock.calls[0][0];
    expect(tip).toBeInstanceOf(HTMLElement);
    expect(tip.textContent).toBe('Rathaus (Steig 2)');
    expect(state.allStops.has('x1')).toBe(true);
  });

  it('binds a plain tooltip without platform suffix', () => {
    stopsLayer.addStopMarker({ lid: 'x2', name: 'Bahnhof', lat: 49.34, lon: 8.66 });
    const m = L.circleMarker.mock.results[0].value;
    const tip = m.bindTooltip.mock.calls[0][0];
    expect(tip).toBeInstanceOf(HTMLElement);
    expect(tip.textContent).toBe('Bahnhof');
  });

  it('renders a malicious HAFAS stop name as text, not HTML (XSS-safe tooltip)', () => {
    stopsLayer.addStopMarker({
      lid: 'x3',
      name: '<img src=x onerror=alert(1)>',
      lat: 49.3,
      lon: 8.6,
    });
    const m = L.circleMarker.mock.results[0].value;
    const tip = m.bindTooltip.mock.calls[0][0];
    expect(tip.querySelector('img')).toBeNull(); // no HTML parsed
    expect(tip.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('does not add a duplicate marker for an already-tracked stop', () => {
    state.allStops.set('dup', { marker: {}, data: {} });
    stopsLayer.addStopMarker({ lid: 'dup', name: 'X', lat: 49, lon: 8 });
    expect(L.circleMarker).not.toHaveBeenCalled();
  });

  it('click on a stop marker bumps the interaction seq and opens the station board', () => {
    state._userInteractionSeq = 0;
    const stop = { lid: 'c1', name: 'Halt', lat: 49.34, lon: 8.66 };
    stopsLayer.addStopMarker(stop);
    const m = L.circleMarker.mock.results[0].value;
    m._clickCbs[0]();
    expect(state._userInteractionSeq).toBe(1);
    expect(ui.showStationBoard).toHaveBeenCalledWith(stop);
  });
});

describe('stopsLayer.loadFromCache', () => {
  it('does nothing when the cache is empty', () => {
    stopsLayer.loadFromCache();
    expect(L.circleMarker).not.toHaveBeenCalled();
  });

  it('adds cached stops that are not already tracked', () => {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        ts: Date.now(),
        stops: [
          { lid: 'a', name: 'A', lat: 49.34, lon: 8.66 },
          { lid: 'b', name: 'B', lat: 49.35, lon: 8.67 },
        ],
      }),
    );
    state.stopLayer = makeLayerMock();
    stopsLayer.loadFromCache();
    expect(L.circleMarker).toHaveBeenCalledTimes(2);
  });

  it('skips cached stops already present in state.allStops', () => {
    state.allStops.set('a', { marker: {}, data: {} });
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ ts: Date.now(), stops: [{ lid: 'a', name: 'A', lat: 49, lon: 8 }] }),
    );
    state.stopLayer = makeLayerMock();
    stopsLayer.loadFromCache();
    expect(L.circleMarker).not.toHaveBeenCalled();
  });

  it('evicts and ignores an expired cache entry', () => {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ ts: Date.now() - 25 * 60 * 60 * 1000, stops: [{ lid: 'a', name: 'A' }] }),
    );
    stopsLayer.loadFromCache();
    expect(localStorage.getItem(CACHE_KEY)).toBeNull();
    expect(L.circleMarker).not.toHaveBeenCalled();
  });

  it('tolerates malformed JSON (catch → no throw, no markers)', () => {
    localStorage.setItem(CACHE_KEY, '{not json');
    expect(() => stopsLayer.loadFromCache()).not.toThrow();
    expect(L.circleMarker).not.toHaveBeenCalled();
  });

  it('handles a cache object missing the stops array (defaults to empty)', () => {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now() }));
    state.stopLayer = makeLayerMock();
    expect(() => stopsLayer.loadFromCache()).not.toThrow();
    expect(L.circleMarker).not.toHaveBeenCalled();
  });
});

describe('stopsLayer.saveToCache', () => {
  it('serialises all tracked stops into localStorage', () => {
    state.allStops.set('a', { marker: {}, data: { lid: 'a', name: 'A' } });
    state.allStops.set('b', { marker: {}, data: { lid: 'b', name: 'B' } });
    stopsLayer.saveToCache();
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY));
    expect(raw.stops).toHaveLength(2);
    expect(raw.stops.map((s) => s.lid).sort()).toEqual(['a', 'b']);
  });

  it('swallows a localStorage write failure (quota / disabled)', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    state.allStops.set('a', { marker: {}, data: { lid: 'a' } });
    expect(() => stopsLayer.saveToCache()).not.toThrow();
    spy.mockRestore();
  });
});

describe('stopsLayer.init', () => {
  it('creates the layer group, wires zoomend, and loads the cache', () => {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ ts: Date.now(), stops: [{ lid: 'a', name: 'A', lat: 49, lon: 8 }] }),
    );
    stopsLayer.init();
    expect(L.layerGroup).toHaveBeenCalledOnce();
    expect(state.map.on).toHaveBeenCalledWith('zoomend', expect.any(Function));
    // loadFromCache ran during init
    expect(L.circleMarker).toHaveBeenCalledTimes(1);
  });

  it('on zoomend ≥ minZoom shows the layer and loads stops in range', () => {
    getStops.mockResolvedValue({ stops: [] });
    stopsLayer.init();
    const zoomend = state.map._handlers.zoomend[0];
    state.map.getZoom.mockReturnValue(16);
    zoomend();
    expect(state.stopLayer.addTo).toHaveBeenCalled();
    expect(getStops).toHaveBeenCalled();
  });

  it('on zoomend < minZoom removes the layer', () => {
    stopsLayer.init();
    const zoomend = state.map._handlers.zoomend[0];
    state.map.getZoom.mockReturnValue(10);
    zoomend();
    expect(state.map.removeLayer).toHaveBeenCalledWith(state.stopLayer);
  });
});

describe('stopsLayer.loadAll', () => {
  it('returns immediately when zoom is below minZoom', () => {
    state.map.getZoom.mockReturnValue(10);
    stopsLayer.loadAll(49.34, 8.66, 5000);
    expect(getStops).not.toHaveBeenCalled();
  });

  it('fetches stops and adds new ones, then persists to cache', async () => {
    getStops.mockResolvedValue({
      stops: [
        { lid: 'n1', name: 'N1', lat: 49.34, lon: 8.66 },
        { lid: 'n2', name: 'N2', lat: 49.35, lon: 8.67 },
      ],
    });
    const saveSpy = vi.spyOn(stopsLayer, 'saveToCache');
    stopsLayer.loadAll(49.34, 8.66, 5000);
    await vi.waitFor(() => expect(L.circleMarker).toHaveBeenCalledTimes(2));
    expect(saveSpy).toHaveBeenCalled();
    saveSpy.mockRestore();
  });

  it('does not persist when the fetch returns only already-known stops', async () => {
    state.allStops.set('known', { marker: {}, data: {} });
    getStops.mockResolvedValue({ stops: [{ lid: 'known', name: 'K', lat: 49, lon: 8 }] });
    const saveSpy = vi.spyOn(stopsLayer, 'saveToCache');
    stopsLayer.loadAll(49.34, 8.66, 5000);
    await vi.waitFor(() => expect(getStops).toHaveBeenCalled());
    await Promise.resolve();
    expect(saveSpy).not.toHaveBeenCalled();
    saveSpy.mockRestore();
  });

  it('defaults the radius to 5000 when none is given', async () => {
    getStops.mockResolvedValue({ stops: [] });
    stopsLayer.loadAll(49.34, 8.66);
    await vi.waitFor(() => expect(getStops).toHaveBeenCalledWith(49.34, 8.66, 5000));
  });

  it('handles a payload with no stops array (defaults to empty, no throw)', async () => {
    getStops.mockResolvedValue({});
    stopsLayer.loadAll(49.34, 8.66, 5000);
    await vi.waitFor(() => expect(getStops).toHaveBeenCalled());
    await Promise.resolve();
    expect(L.circleMarker).not.toHaveBeenCalled();
  });

  it('swallows a rejected getStops (network error)', async () => {
    getStops.mockRejectedValue(new Error('network'));
    expect(() => stopsLayer.loadAll(49.34, 8.66, 5000)).not.toThrow();
    await vi.waitFor(() => expect(getStops).toHaveBeenCalled());
  });

  it('throttles a repeated identical key within 30s', async () => {
    getStops.mockResolvedValue({ stops: [] });
    stopsLayer.loadAll(49.34, 8.66, 5000);
    await vi.waitFor(() => expect(getStops).toHaveBeenCalledTimes(1));
    stopsLayer.loadAll(49.34, 8.66, 5000); // same key, within window → skipped
    expect(getStops).toHaveBeenCalledTimes(1);
  });

  it('re-fetches once the 30s throttle window has elapsed', async () => {
    getStops.mockResolvedValue({ stops: [] });
    stopsLayer.loadAll(49.34, 8.66, 5000);
    await vi.waitFor(() => expect(getStops).toHaveBeenCalledTimes(1));
    stopsLayer._lastFetch = Date.now() - 31000; // age the memo past the window
    stopsLayer.loadAll(49.34, 8.66, 5000);
    expect(getStops).toHaveBeenCalledTimes(2);
  });
});

describe('stopsLayer.update', () => {
  it('harvests valid stops from vehicles and persists', () => {
    const saveSpy = vi.spyOn(stopsLayer, 'saveToCache');
    stopsLayer.update([
      {
        stops: [
          { lid: 's1', name: 'S1', lat: 49.34, lon: 8.66 },
          { lid: 's2', name: 'S2', lat: 49.35, lon: 8.67 },
        ],
      },
    ]);
    expect(L.circleMarker).toHaveBeenCalledTimes(2);
    expect(saveSpy).toHaveBeenCalledOnce();
    saveSpy.mockRestore();
  });

  it('skips vehicles without a stops array', () => {
    const saveSpy = vi.spyOn(stopsLayer, 'saveToCache');
    stopsLayer.update([{ jid: 'x' }]); // no .stops
    expect(L.circleMarker).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
    saveSpy.mockRestore();
  });

  it('skips stops with missing lid or zeroed coordinates and already-known stops', () => {
    state.allStops.set('known', { marker: {}, data: {} });
    stopsLayer.update([
      {
        stops: [
          { lid: '', lat: 49.34, lon: 8.66 }, // no lid
          { lid: 'z', lat: 0, lon: 8.66 }, // lat 0
          { lid: 'z2', lat: 49.34, lon: 0 }, // lon 0
          { lid: 'known', lat: 49.34, lon: 8.66 }, // already tracked
        ],
      },
    ]);
    expect(L.circleMarker).not.toHaveBeenCalled();
  });
});
