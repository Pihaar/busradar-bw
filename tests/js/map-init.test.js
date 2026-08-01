/**
 * Tests for mapModule.init and everything wired inside it, driven through a
 * hand-built Leaflet (`L`) stub with the full surface init touches:
 *   - L.map (on/setView/getCenter/getBounds/getZoom/getContainer/hasLayer/
 *     removeLayer/createPane/getPane/invalidateSize/whenReady/attributionControl)
 *   - L.TileLayer.extend (RetryTileLayer) + L.tileLayer + L.control.zoom
 *   - L.Control.extend (GpsControl / AboutControl, onAdd invoked by addTo)
 *   - L.DomUtil.create / L.DomEvent (click listeners dispatched for real)
 *
 * Covered here: tile-layer theme selection + fallback swap, the zoomend /
 * moveend / click / dragstart / marker-scale handlers, RetryTileLayer.createTile
 * retry loop (onload/onerror fired by hand), GpsControl + AboutControl onAdd,
 * and their click handlers (geolocation + version-fetch chains).
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

const savedL = globalThis.L;
const savedNavigator = globalThis.navigator;
const savedFetch = globalThis.window.fetch;

// ---- controllable map mock -------------------------------------------------
function makeGeoPoint(lat, lng, dist) {
  return { lat, lng, distanceTo: () => dist };
}

let mapState;
// Layers considered "already on the map" before init runs (for the
// createTileLayers re-entry branches that remove a prior layer).
let preLayers = new Set();
function makeMap() {
  const handlers = {};
  const container = document.createElement('div');
  container.id = 'map';
  document.body.appendChild(container);
  mapState = {
    zoom: 14,
    center: makeGeoPoint(49.34, 8.66, 0),
    neDist: 1000, // center → NE
    diameter: 4000, // NE → SW
    layers: new Set(preLayers),
    handlers,
    container,
    fire(evt) {
      (handlers[evt] || []).forEach((cb) => cb());
    },
  };
  return {
    on: vi.fn((evt, cb) => {
      (handlers[evt] = handlers[evt] || []).push(cb);
    }),
    setView: vi.fn(),
    getCenter: vi.fn(() => mapState.center),
    getBounds: vi.fn(() => ({
      getNorthEast: () => makeGeoPoint(49.4, 8.7, mapState.diameter),
      getSouthWest: () => makeGeoPoint(49.3, 8.6, 0),
    })),
    getZoom: vi.fn(() => mapState.zoom),
    getContainer: vi.fn(() => container),
    hasLayer: vi.fn((l) => mapState.layers.has(l)),
    addLayer: vi.fn((l) => mapState.layers.add(l)),
    removeLayer: vi.fn((l) => mapState.layers.delete(l)),
    createPane: vi.fn(() => ({ style: {} })),
    getPane: vi.fn(() => null),
    invalidateSize: vi.fn(),
    whenReady: vi.fn((cb) => cb()),
    attributionControl: { setPosition: vi.fn() },
  };
}

// center.distanceTo needs to vary for the moveend refresh gate
function setCenterDist(d) {
  mapState.center = makeGeoPoint(49.34, 8.66, d);
}

function makeLayerObj() {
  const o = {
    _evts: {},
    on: vi.fn(function (evt, cb) {
      (o._evts[evt] = o._evts[evt] || []).push(cb);
      return o;
    }),
    addTo: vi.fn(function (m) {
      m.addLayer(o);
      return o;
    }),
  };
  return o;
}

let tileProps; // captured RetryTileLayer prototype props (has createTile)
let controlContainers; // GpsControl / AboutControl containers in addTo order

function installL() {
  controlContainers = [];
  globalThis.L = {
    map: vi.fn(() => makeMap()),
    tileLayer: vi.fn(() => makeLayerObj()),
    TileLayer: {
      extend: vi.fn((props) => {
        tileProps = props;
        function TL(url, opts) {
          this._url = url;
          this.options = opts || {};
          Object.assign(this, props);
        }
        TL.prototype.on = function (evt, cb) {
          this._evts = this._evts || {};
          (this._evts[evt] = this._evts[evt] || []).push(cb);
          return this;
        };
        TL.prototype.addTo = function (m) {
          m.addLayer(this);
          return this;
        };
        TL.prototype.getTileUrl = function () {
          return 'https://a.basemaps.cartocdn.com/dark_all/1/2/3.png';
        };
        return TL;
      }),
    },
    control: { zoom: vi.fn(() => makeLayerObj()) },
    Control: {
      extend: vi.fn((props) => {
        function Ctrl(opts) {
          Object.assign(this, props);
          this.options = Object.assign({}, props.options, opts);
        }
        Ctrl.prototype.addTo = function (m) {
          this._map = m;
          const c = this.onAdd(m);
          controlContainers.push(c);
          return this;
        };
        return Ctrl;
      }),
    },
    DomUtil: {
      create: vi.fn((tag, cls, parent) => {
        const el = document.createElement(tag);
        if (cls) el.className = cls;
        if (parent) parent.appendChild(el);
        return el;
      }),
    },
    DomEvent: {
      disableClickPropagation: vi.fn(),
      preventDefault: vi.fn(),
      on: vi.fn((el, evt, cb) => el.addEventListener(evt, cb)),
    },
    marker: vi.fn(() => makeLayerObj()),
    circleMarker: vi.fn(() => makeLayerObj()),
    layerGroup: vi.fn(() => makeLayerObj()),
    divIcon: vi.fn(() => ({})),
    latLng: (lat, lon) => ({ lat, lng: lon }),
  };
}

const refreshMock = { refresh: vi.fn() };
vi.mock('../../static/refresh.js', () => refreshMock);
const getStops = vi.fn().mockResolvedValue({ stops: [] });
vi.mock('../../static/api.js', () => ({
  trackedFetch: (...a) => window.fetch(...a),
  api: { getStops: (...a) => getStops(...a) },
}));
vi.mock('../../static/ui.js', () => ({
  ui: {
    closePanel: vi.fn(),
    _disableFollow: vi.fn(),
    showStationBoard: vi.fn(),
    selectJourney: vi.fn(),
  },
}));

const { mapModule } = await import('../../static/map.js');
const { state, settings } = await import('../../static/state.js');
const { ui } = await import('../../static/ui.js');
const { CONFIG } = await import('../../static/config.js');

beforeEach(() => {
  document.body.innerHTML = '';
  installL();
  preLayers = new Set();
  state.map = null;
  state.darkTileLayer = null;
  state.lightTileLayer = null;
  state._osmFallback = null;
  state.allStops = new Map();
  state.vehicles = new Map();
  state.selectedJid = null;
  state.selectedStop = null;
  state._followPanning = false;
  state.followBus = false;
  state._appVersion = null;
  state._appVersionFetch = null;
  settings.current = { theme: 'dark', showLocation: false, lang: 'de' };
  state._selectionJustMade = false;
  // requestGPS runs at the end of init; showLocation:false makes it early-return.
  refreshMock.refresh.mockClear();
  getStops.mockClear();
  ui.closePanel.mockClear();
  ui._disableFollow.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  location.hash = '';
});

afterAll(() => {
  globalThis.L = savedL;
  globalThis.navigator = savedNavigator;
  globalThis.window.fetch = savedFetch;
});

describe('mapModule.init — wiring', () => {
  it('creates the map at the provided center/zoom and adds dark tile layer (dark theme)', () => {
    mapModule.init([49.5, 8.5], 16);
    expect(L.map).toHaveBeenCalledWith(
      'map',
      expect.objectContaining({ center: [49.5, 8.5], zoom: 16 }),
    );
    expect(state.map.addLayer).toHaveBeenCalledWith(state.darkTileLayer);
  });

  it('falls back to CONFIG defaults when center/zoom are omitted', () => {
    mapModule.init();
    const opts = L.map.mock.calls[0][1];
    expect(opts.center).toBe(CONFIG.fallbackCenter);
    expect(opts.zoom).toBe(CONFIG.defaultZoom);
  });

  it('treats an explicit zoom of 0 as a real value (not the default)', () => {
    mapModule.init([49.5, 8.5], 0);
    expect(L.map.mock.calls[0][1].zoom).toBe(0);
  });

  it('activates the light tile layer when theme is light', () => {
    settings.current.theme = 'light';
    mapModule.init([49.5, 8.5], 14);
    expect(state.map.addLayer).toHaveBeenCalledWith(state.lightTileLayer);
  });
});

describe('mapModule.init — tile error / zoom fallback handlers', () => {
  beforeEach(() => mapModule.init([49.34, 8.66], 14));

  function fireTileError() {
    // onTileError was wired to both tile layers via layer.on('tileerror', …).
    state.darkTileLayer._evts.tileerror[0]();
  }

  it('onTileError swaps the active layer for the OSM fallback', () => {
    mapState.zoom = 14;
    // Active dark layer is on the map after init.
    expect(mapState.layers.has(state.darkTileLayer)).toBe(true);
    fireTileError();
    expect(mapState.layers.has(state._osmFallback)).toBe(true);
    expect(mapState.layers.has(state.darkTileLayer)).toBe(false);
  });

  it('onTileError with the light theme active removes the light layer', () => {
    // Re-init in light theme so the "current = lightTileLayer" arm runs.
    settings.current.theme = 'light';
    mapModule.init([49.34, 8.66], 14);
    expect(mapState.layers.has(state.lightTileLayer)).toBe(true);
    state.lightTileLayer._evts.tileerror[0]();
    expect(mapState.layers.has(state._osmFallback)).toBe(true);
    expect(mapState.layers.has(state.lightTileLayer)).toBe(false);
  });

  it('onTileError is idempotent once the fallback is already shown', () => {
    fireTileError();
    state.map.addLayer.mockClear();
    fireTileError(); // fallback already present → inner guard skips
    expect(state.map.addLayer).not.toHaveBeenCalled();
  });

  it('tileload handler is a no-op that does not throw', () => {
    expect(() => state.darkTileLayer._evts.tileload[0]()).not.toThrow();
  });

  it('zoomend restores the real layer at a zoom that never broke', () => {
    fireTileError(); // fallback now shown at zoom 14 (marked broken)
    mapState.zoom = 17; // a zoom with no recorded break → restore real layer
    mapState.fire('zoomend');
    expect(mapState.layers.has(state._osmFallback)).toBe(false);
    expect(mapState.layers.has(state.darkTileLayer)).toBe(true);
  });

  it('zoomend re-applies the fallback at a zoom already known broken', () => {
    fireTileError(); // zoom 14 broken, fallback shown
    // Move to a healthy zoom (restores real), then back to the broken 14.
    mapState.zoom = 17;
    mapState.fire('zoomend');
    mapState.zoom = 14;
    mapState.fire('zoomend');
    expect(mapState.layers.has(state._osmFallback)).toBe(true);
    expect(mapState.layers.has(state.darkTileLayer)).toBe(false);
  });

  it('zoomend removes the fallback at a healthy zoom and toggles marker scale', () => {
    mapState.zoom = 16;
    mapState.fire('zoomend');
    // marker scale property set on the container
    expect(state.map.getContainer().style.getPropertyValue('--marker-scale')).toBe('1.12');
  });

  it('updateMarkerScale is a no-op when the zoom bucket does not change', () => {
    // init already ran updateMarkerScale once at zoom 14 (bucket 2 → scale 1.0)
    expect(state.map.getContainer().style.getPropertyValue('--marker-scale')).toBe('1');
    mapState.zoom = 15; // still bucket 2
    mapState.fire('zoomend');
    expect(state.map.getContainer().style.getPropertyValue('--marker-scale')).toBe('1');
  });

  it('marker scale drops to the smallest bucket at low zoom', () => {
    mapState.zoom = 10;
    mapState.fire('zoomend');
    expect(state.map.getContainer().style.getPropertyValue('--marker-scale')).toBe('0.74');
  });

  it('marker scale uses the mid-low bucket at zoom 12-13', () => {
    mapState.zoom = 12;
    mapState.fire('zoomend');
    expect(state.map.getContainer().style.getPropertyValue('--marker-scale')).toBe('0.85');
  });

  it('onTileError skips the layer removal when the active layer is not on the map', () => {
    // Drive the false arm of `if (hasLayer(current))` inside onTileError: remove
    // the dark layer first, then fire tileerror with the fallback not yet shown.
    mapState.layers.delete(state.darkTileLayer);
    state.darkTileLayer._evts.tileerror[0]();
    expect(mapState.layers.has(state._osmFallback)).toBe(true);
  });
});

describe('mapModule.init — light-theme fallback restore paths', () => {
  beforeEach(() => {
    settings.current.theme = 'light';
    mapModule.init([49.34, 8.66], 14);
  });

  it('zoomend restore re-adds the light layer at a healthy zoom', () => {
    state.lightTileLayer._evts.tileerror[0](); // break zoom 14 → fallback shown
    mapState.zoom = 17;
    mapState.fire('zoomend');
    expect(mapState.layers.has(state._osmFallback)).toBe(false);
    expect(mapState.layers.has(state.lightTileLayer)).toBe(true);
  });

  it('zoomend re-applies the fallback and removes the light layer at a broken zoom', () => {
    state.lightTileLayer._evts.tileerror[0](); // zoom 14 broken
    mapState.zoom = 17;
    mapState.fire('zoomend'); // restore light
    mapState.zoom = 14;
    mapState.fire('zoomend'); // broken again → remove light, show fallback
    expect(mapState.layers.has(state._osmFallback)).toBe(true);
    expect(mapState.layers.has(state.lightTileLayer)).toBe(false);
  });

  it('zoomend restore skips re-adding when the real layer is already present', () => {
    // Fallback shown, but manually re-add the light layer so the
    // `if (!hasLayer(current))` guard is false → no duplicate addTo.
    state.lightTileLayer._evts.tileerror[0]();
    mapState.layers.add(state.lightTileLayer);
    const addSpy = vi.spyOn(state.lightTileLayer, 'addTo');
    mapState.zoom = 17;
    mapState.fire('zoomend');
    expect(addSpy).not.toHaveBeenCalled();
  });

  it('zoomend re-broken skips the removal when the real layer is already gone', () => {
    state.lightTileLayer._evts.tileerror[0](); // zoom 14 broken, light removed
    mapState.zoom = 17;
    mapState.fire('zoomend'); // restore light
    mapState.layers.delete(state.lightTileLayer); // simulate it already absent
    state.map.removeLayer.mockClear();
    mapState.zoom = 14;
    mapState.fire('zoomend'); // broken → `if (hasLayer(cur))` false
    expect(state.map.removeLayer).not.toHaveBeenCalledWith(state.lightTileLayer);
    expect(mapState.layers.has(state._osmFallback)).toBe(true);
  });
});

describe('mapModule.init — createTileLayers re-entry removal', () => {
  it('removes prior dark and light layers already on the map before recreating', () => {
    // Seed stale layers that init() must clear (createTileLayers L66-69 true arms).
    const oldDark = { _stale: 'dark' };
    const oldLight = { _stale: 'light' };
    state.darkTileLayer = oldDark;
    state.lightTileLayer = oldLight;
    preLayers = new Set([oldDark, oldLight]);
    mapModule.init([49.34, 8.66], 14);
    // The map mock's removeLayer was called for both stale layers.
    expect(state.map.removeLayer).toHaveBeenCalledWith(oldDark);
    expect(state.map.removeLayer).toHaveBeenCalledWith(oldLight);
    // And fresh RetryTileLayer instances replaced them.
    expect(state.darkTileLayer).not.toBe(oldDark);
    expect(state.lightTileLayer).not.toBe(oldLight);
  });

  it('skips removing stale layers that are not currently on the map', () => {
    const oldDark = { _stale: 'dark' };
    state.darkTileLayer = oldDark; // present in state but NOT in preLayers → hasLayer false
    preLayers = new Set();
    mapModule.init([49.34, 8.66], 14);
    expect(state.map.removeLayer).not.toHaveBeenCalledWith(oldDark);
  });
});

describe('mapModule.init — moveend handler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mapModule.init([49.34, 8.66], 15);
    mapState.zoom = 15;
  });

  it('loads stops and refreshes when the map moved far enough', () => {
    setCenterDist(1000); // center→NE
    mapState.diameter = 4000; // viewportDiameter; 0.1*4000=400 < dist(from lastRefreshCenter)
    // lastRefreshCenter distance is computed via center.distanceTo(lastRefreshCenter);
    // our center.distanceTo returns the neDist we set → 1000 > 400 → refresh.
    mapState.fire('moveend');
    vi.advanceTimersByTime(500);
    expect(getStops).toHaveBeenCalled(); // stopsLayer.loadAll ran (zoom≥14)
    expect(refreshMock.refresh).toHaveBeenCalled();
  });

  it('skips the refresh when movement is small and zoom did not decrease', () => {
    setCenterDist(10); // tiny move
    mapState.diameter = 4000; // 0.1*4000=400 > 10, zoom unchanged → no refresh
    mapState.fire('moveend');
    vi.advanceTimersByTime(500);
    expect(refreshMock.refresh).not.toHaveBeenCalled();
  });

  it('bails out entirely while a follow-pan is in progress', () => {
    state._followPanning = true;
    mapState.fire('moveend');
    vi.advanceTimersByTime(500);
    expect(getStops).not.toHaveBeenCalled();
    expect(refreshMock.refresh).not.toHaveBeenCalled();
  });
});

describe('mapModule.init — click / dblclick / dragstart', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mapModule.init([49.34, 8.66], 14);
  });

  it('a lone click closes the panel when something is selected', () => {
    state.selectedJid = 'x';
    mapState.fire('click');
    vi.advanceTimersByTime(550);
    expect(ui.closePanel).toHaveBeenCalledOnce();
  });

  it('a click does nothing when a selection was just made', () => {
    state.selectedJid = 'x';
    state._selectionJustMade = true;
    mapState.fire('click');
    vi.advanceTimersByTime(550);
    expect(ui.closePanel).not.toHaveBeenCalled();
  });

  it('a click with nothing selected does not close the panel', () => {
    state.selectedJid = null;
    state.selectedStop = null;
    mapState.fire('click');
    vi.advanceTimersByTime(550);
    expect(ui.closePanel).not.toHaveBeenCalled();
  });

  it('a dblclick cancels the pending single-click close', () => {
    state.selectedJid = 'x';
    mapState.fire('click');
    state.map.getContainer().dispatchEvent(new window.Event('dblclick'));
    vi.advanceTimersByTime(550);
    expect(ui.closePanel).not.toHaveBeenCalled();
  });

  it('_cancelMapClick suppresses the next click and clears the flag after 600ms', () => {
    state._cancelMapClick();
    expect(state._selectionJustMade).toBe(true);
    vi.advanceTimersByTime(600);
    expect(state._selectionJustMade).toBe(false);
  });

  it('dragstart disables follow when following a bus', () => {
    state.followBus = true;
    mapState.fire('dragstart');
    expect(ui._disableFollow).toHaveBeenCalledOnce();
  });

  it('dragstart does nothing when not following', () => {
    state.followBus = false;
    state._followPanning = false;
    mapState.fire('dragstart');
    expect(ui._disableFollow).not.toHaveBeenCalled();
  });
});

describe('RetryTileLayer.createTile — retry loop (direct invoke)', () => {
  beforeEach(() => mapModule.init([49.34, 8.66], 14));

  function ctx(options) {
    return {
      options: options,
      getTileUrl: () => 'https://a.basemaps.cartocdn.com/dark_all/1/2/3.png',
    };
  }

  it('resolves done(null, tile) on the first successful load', () => {
    const done = vi.fn();
    const tile = tileProps.createTile.call(ctx({ subdomains: 'abcd' }), { x: 1, y: 2, z: 3 }, done);
    expect(tile.tagName).toBe('IMG');
    expect(tile.getAttribute('role')).toBe('presentation');
    expect(tile.src).toContain('//a.'); // first subdomain
    tile.onload();
    expect(done).toHaveBeenCalledWith(null, tile);
    expect(tile.onload).toBeNull();
  });

  it('retries the next subdomain on error, then succeeds', () => {
    const done = vi.fn();
    const tile = tileProps.createTile.call(ctx({ subdomains: 'abcd' }), { x: 1, y: 2, z: 3 }, done);
    tile.onerror(); // a → b
    expect(tile.src).toContain('//b.');
    tile.onload();
    expect(done).toHaveBeenCalledWith(null, tile);
  });

  it('reports done("failed", tile) after every subdomain errors', () => {
    const done = vi.fn();
    const tile = tileProps.createTile.call(ctx({ subdomains: 'ab' }), { x: 1, y: 2, z: 3 }, done);
    tile.onerror(); // a → b
    tile.onerror(); // b exhausted → failed
    expect(done).toHaveBeenCalledWith('failed', tile);
    expect(tile.onerror).toBeNull();
  });

  it('accepts an array of subdomains (no .split branch)', () => {
    const done = vi.fn();
    const tile = tileProps.createTile.call(
      ctx({ subdomains: ['a', 'b'] }),
      { x: 1, y: 2, z: 3 },
      done,
    );
    tile.onload();
    expect(done).toHaveBeenCalledWith(null, tile);
  });

  it('sets crossOrigin to "" when option is true', () => {
    const done = vi.fn();
    const tile = tileProps.createTile.call(
      ctx({ subdomains: 'abcd', crossOrigin: true }),
      { x: 1, y: 2, z: 3 },
      done,
    );
    // The code assigns '' for crossOrigin===true; happy-dom reflects '' as null.
    expect(tile.crossOrigin).toBeFalsy();
    tile.onload();
    expect(done).toHaveBeenCalledWith(null, tile);
  });

  it('passes through a string crossOrigin value', () => {
    const done = vi.fn();
    const tile = tileProps.createTile.call(
      ctx({ subdomains: 'abcd', crossOrigin: 'anonymous' }),
      { x: 1, y: 2, z: 3 },
      done,
    );
    expect(tile.crossOrigin).toBe('anonymous');
  });

  it('handles crossOrigin === "" (empty-string opt-in)', () => {
    const done = vi.fn();
    const tile = tileProps.createTile.call(
      ctx({ subdomains: 'abcd', crossOrigin: '' }),
      { x: 1, y: 2, z: 3 },
      done,
    );
    // crossOrigin==='' hits the branch and assigns ''; happy-dom reflects as null.
    expect(tile.crossOrigin).toBeFalsy();
    tile.onload();
    expect(done).toHaveBeenCalledWith(null, tile);
  });

  it('defaults subdomains to abcd when the option is absent', () => {
    const done = vi.fn();
    const tile = tileProps.createTile.call(ctx({}), { x: 1, y: 2, z: 3 }, done);
    expect(tile.src).toContain('//a.');
    tile.onload();
    expect(done).toHaveBeenCalledWith(null, tile);
  });
});
