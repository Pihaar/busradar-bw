/**
 * Tests for the interactive controls wired inside mapModule.init and for
 * mapModule.requestGPS: the GpsControl button (geolocation success / error /
 * unavailable), the AboutControl button (version-fetch chain: cached / in-flight
 * / fresh-ok / bad-version / http-error / network-error / abort-timeout), and
 * requestGPS's own early-returns + success retries + watch start.
 *
 * The Leaflet stub is deliberately minimal but complete for the control path:
 * L.Control.extend invokes onAdd through addTo, DomEvent.on attaches real DOM
 * listeners so a dispatched 'click' drives the handler.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

const savedL = globalThis.L;
const savedNavigator = globalThis.navigator;
const savedFetch = globalThis.window.fetch;

let mapState;
function makeMap() {
  const handlers = {};
  const container = document.createElement('div');
  container.id = 'map';
  document.body.appendChild(container);
  mapState = { zoom: 14, layers: new Set(), handlers, container };
  return {
    on: vi.fn((evt, cb) => {
      (handlers[evt] = handlers[evt] || []).push(cb);
    }),
    setView: vi.fn(),
    getCenter: vi.fn(() => ({ lat: 49.34, lng: 8.66, distanceTo: () => 0 })),
    getBounds: vi.fn(() => ({
      getNorthEast: () => ({ lat: 49.4, lng: 8.7, distanceTo: () => 4000 }),
      getSouthWest: () => ({ lat: 49.3, lng: 8.6 }),
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

function makeLayerObj() {
  const o = {
    on: vi.fn(() => o),
    addTo: vi.fn((m) => {
      m.addLayer(o);
      return o;
    }),
  };
  return o;
}

let controlContainers;
function installL() {
  controlContainers = [];
  globalThis.L = {
    map: vi.fn(() => makeMap()),
    tileLayer: vi.fn(() => makeLayerObj()),
    TileLayer: {
      extend: vi.fn((props) => {
        function TL(url, opts) {
          this.options = opts || {};
          Object.assign(this, props);
        }
        TL.prototype.on = () => {};
        TL.prototype.addTo = function (m) {
          m.addLayer(this);
          return this;
        };
        TL.prototype.getTileUrl = () => 'https://a/x.png';
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
          controlContainers.push(this.onAdd(m));
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

vi.mock('../../static/refresh.js', () => ({ refresh: vi.fn() }));
const getStops = vi.fn().mockResolvedValue({ stops: [] });
vi.mock('../../static/api.js', () => ({ api: { getStops: (...a) => getStops(...a) } }));
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
const { CONFIG } = await import('../../static/config.js');

// Find a control container by its class (gps-control / about-control).
function control(cls) {
  return controlContainers.find((c) => c.className.includes(cls));
}
function clickLink(container) {
  container.querySelector('a').dispatchEvent(new window.Event('click', { cancelable: true }));
}

// Geolocation stub with directly-fireable callbacks.
function installGeolocation() {
  const calls = { current: [], watch: [] };
  globalThis.navigator = {
    geolocation: {
      getCurrentPosition: vi.fn((ok, err, opts) => {
        calls.current.push({ ok, err, opts });
      }),
      watchPosition: vi.fn((ok, err, opts) => {
        calls.watch.push({ ok, err, opts });
        return 99;
      }),
      clearWatch: vi.fn(),
    },
  };
  return calls;
}

beforeEach(() => {
  document.body.innerHTML = '';
  installL();
  state.map = null;
  state.darkTileLayer = state.lightTileLayer = state._osmFallback = null;
  state.allStops = new Map();
  state.vehicles = new Map();
  state._geoWatchId = null;
  state._userLocationMarker = null;
  state._appVersion = null;
  state._appVersionFetch = null;
  settings.current = { theme: 'dark', showLocation: false, lang: 'de' };
  location.hash = '';
  getStops.mockClear();
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

describe('GpsControl button', () => {
  it('hides the control container when showLocation is off', () => {
    installGeolocation();
    mapModule.init([49.34, 8.66], 14);
    expect(control('gps-control').style.display).toBe('none');
    expect(state._gpsControlContainer).toBe(control('gps-control'));
  });

  it('is visible when showLocation is on', () => {
    settings.current.showLocation = true;
    installGeolocation();
    mapModule.init([49.34, 8.66], 14);
    expect(control('gps-control').style.display).toBe('');
  });

  it('flags an error class when geolocation is unavailable at click time', () => {
    installGeolocation();
    mapModule.init([49.34, 8.66], 14);
    vi.useFakeTimers();
    const c = control('gps-control');
    delete navigator.geolocation; // unavailable
    clickLink(c);
    const link = c.querySelector('a');
    expect(link.classList.contains('gps-control--error')).toBe(true);
    vi.advanceTimersByTime(1500);
    expect(link.classList.contains('gps-control--error')).toBe(false);
  });

  it('on success re-centers, drops a marker and starts the watch', () => {
    const calls = installGeolocation();
    mapModule.init([49.34, 8.66], 14);
    const c = control('gps-control');
    clickLink(c);
    expect(navigator.geolocation.getCurrentPosition).toHaveBeenCalled();
    const link = c.querySelector('a');
    expect(link.style.opacity).toBe('0.5');
    settings.current.showLocation = true; // so setUserLocationMarker/startWatch proceed
    calls.current[0].ok({ coords: { latitude: 49.5, longitude: 8.5 } });
    expect(link.style.opacity).toBe('');
    expect(state.map.setView).toHaveBeenCalledWith([49.5, 8.5], CONFIG.defaultZoom);
    expect(navigator.geolocation.watchPosition).toHaveBeenCalled();
  });

  it('on error clears opacity and flashes the error class', () => {
    const calls = installGeolocation();
    mapModule.init([49.34, 8.66], 14);
    vi.useFakeTimers();
    const c = control('gps-control');
    clickLink(c);
    const link = c.querySelector('a');
    calls.current[0].err({ code: 1 });
    expect(link.style.opacity).toBe('');
    expect(link.classList.contains('gps-control--error')).toBe(true);
    vi.advanceTimersByTime(1500);
    expect(link.classList.contains('gps-control--error')).toBe(false);
  });
});

describe('AboutControl button — version fetch chain', () => {
  function setupDialog() {
    const dlg = document.createElement('dialog');
    dlg.id = 'about-dialog';
    const v = document.createElement('span');
    v.id = 'about-version-value';
    dlg.appendChild(v);
    document.body.appendChild(dlg);
    return { dlg, v };
  }

  it('shows a cached version without fetching', () => {
    installGeolocation();
    const { v } = setupDialog();
    state._appVersion = '1.2.3';
    window.fetch = vi.fn();
    mapModule.init([49.34, 8.66], 14);
    clickLink(control('about-control'));
    expect(v.textContent).toBe('1.2.3');
    expect(window.fetch).not.toHaveBeenCalled();
  });

  it('shows a placeholder when a fetch is already in flight', () => {
    installGeolocation();
    const { v } = setupDialog();
    state._appVersionFetch = Promise.resolve();
    window.fetch = vi.fn();
    mapModule.init([49.34, 8.66], 14);
    clickLink(control('about-control'));
    expect(v.textContent).toBe('…');
    expect(window.fetch).not.toHaveBeenCalled();
  });

  it('fetches and renders a valid version on success', async () => {
    installGeolocation();
    const { v } = setupDialog();
    window.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ version: '2.0.0' }) }),
    );
    mapModule.init([49.34, 8.66], 14);
    clickLink(control('about-control'));
    expect(v.textContent).toBe('…');
    await vi.waitFor(() => expect(v.textContent).toBe('2.0.0'));
    expect(state._appVersion).toBe('2.0.0');
    expect(state._appVersionFetch).toBeNull();
  });

  it('renders an em-dash when the payload version fails the regex', async () => {
    installGeolocation();
    const { v } = setupDialog();
    window.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ version: 'no spaces allowed!' }) }),
    );
    mapModule.init([49.34, 8.66], 14);
    clickLink(control('about-control'));
    await vi.waitFor(() => expect(v.textContent).toBe('—'));
    expect(state._appVersion).toBeNull();
  });

  it('renders an em-dash on a non-ok HTTP response', async () => {
    installGeolocation();
    const { v } = setupDialog();
    window.fetch = vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }));
    mapModule.init([49.34, 8.66], 14);
    clickLink(control('about-control'));
    await vi.waitFor(() => expect(v.textContent).toBe('—'));
  });

  it('renders an em-dash when the fetch rejects (network error)', async () => {
    installGeolocation();
    const { v } = setupDialog();
    window.fetch = vi.fn(() => Promise.reject(new Error('network')));
    mapModule.init([49.34, 8.66], 14);
    clickLink(control('about-control'));
    await vi.waitFor(() => expect(v.textContent).toBe('—'));
    expect(state._appVersionFetch).toBeNull();
  });

  it('does not re-open the dialog when it is already open', () => {
    installGeolocation();
    const { dlg, v } = setupDialog();
    dlg.open = true;
    window.fetch = vi.fn();
    mapModule.init([49.34, 8.66], 14);
    clickLink(control('about-control'));
    expect(v.textContent).toBe(''); // handler bailed out on the open guard
    expect(window.fetch).not.toHaveBeenCalled();
  });

  it('tolerates a missing version node (dialog present, node absent)', () => {
    installGeolocation();
    const dlg = document.createElement('dialog');
    dlg.id = 'about-dialog';
    document.body.appendChild(dlg); // no #about-version-value inside
    window.fetch = vi.fn();
    const showModal = vi.spyOn(dlg, 'showModal');
    mapModule.init([49.34, 8.66], 14);
    clickLink(control('about-control'));
    expect(showModal).toHaveBeenCalled();
  });

  it('is a no-op when the dialog element is absent', () => {
    installGeolocation();
    window.fetch = vi.fn();
    mapModule.init([49.34, 8.66], 14);
    expect(() => clickLink(control('about-control'))).not.toThrow();
    expect(window.fetch).not.toHaveBeenCalled();
  });

  it('aborts the fetch after the 10s timeout elapses', async () => {
    installGeolocation();
    const { v } = setupDialog();
    vi.useFakeTimers();
    let capturedSignal = null;
    window.fetch = vi.fn((url, opts) => {
      capturedSignal = opts && opts.signal;
      return new Promise((_, reject) => {
        // reject when aborted
        if (opts && opts.signal) {
          opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }
      });
    });
    mapModule.init([49.34, 8.66], 14);
    clickLink(control('about-control'));
    expect(capturedSignal).not.toBeNull();
    vi.advanceTimersByTime(10000); // fires ctrl.abort()
    expect(capturedSignal.aborted).toBe(true);
    await vi.waitFor(() => expect(v.textContent).toBe('—'));
  });

  it('fetches without an AbortController when the API is unavailable', async () => {
    installGeolocation();
    const { v } = setupDialog();
    const savedAC = globalThis.AbortController;
    // Remove AbortController so the ternary picks the null arm (no signal, no timer).
    globalThis.AbortController = undefined;
    let capturedOpts = 'unset';
    window.fetch = vi.fn((url, opts) => {
      capturedOpts = opts;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ version: '3.1.4' }) });
    });
    mapModule.init([49.34, 8.66], 14);
    clickLink(control('about-control'));
    expect(capturedOpts).toBeUndefined(); // no { signal } passed
    await vi.waitFor(() => expect(v.textContent).toBe('3.1.4'));
    globalThis.AbortController = savedAC;
  });
});

describe('mapModule.requestGPS', () => {
  it('returns early when geolocation is unavailable', () => {
    globalThis.navigator = {};
    state.map = {};
    settings.current.showLocation = true;
    expect(() => mapModule.requestGPS()).not.toThrow();
  });

  it('returns early when showLocation is off', () => {
    const calls = installGeolocation();
    settings.current.showLocation = false;
    mapModule.requestGPS();
    expect(navigator.geolocation.getCurrentPosition).not.toHaveBeenCalled();
    expect(calls.current).toHaveLength(0);
  });

  it('on success (no URL hash) re-centers, loads stops, drops the dot and starts watch', () => {
    const calls = installGeolocation();
    settings.current.showLocation = true;
    state.map = makeMap();
    state.map.getZoom.mockReturnValue(15); // so loadAll passes the zoom gate
    location.hash = '';
    mapModule.requestGPS();
    calls.current[0].ok({ coords: { latitude: 49.5, longitude: 8.5 } });
    expect(state.map.invalidateSize).toHaveBeenCalled();
    expect(state.map.setView).toHaveBeenCalledWith([49.5, 8.5], CONFIG.defaultZoom);
    expect(getStops).toHaveBeenCalled();
    expect(navigator.geolocation.watchPosition).toHaveBeenCalled();
  });

  it('with a URL hash it suppresses the view jump but still drops the dot', () => {
    const calls = installGeolocation();
    settings.current.showLocation = true;
    state.map = makeMap();
    location.hash = '#49.3/8.6/14';
    mapModule.requestGPS();
    calls.current[0].ok({ coords: { latitude: 49.5, longitude: 8.5 } });
    expect(state.map.setView).not.toHaveBeenCalled();
    expect(getStops).not.toHaveBeenCalled();
    expect(state.map.whenReady).toHaveBeenCalled();
  });

  it('re-checks showLocation inside the callback and bails if toggled off meanwhile', () => {
    const calls = installGeolocation();
    settings.current.showLocation = true;
    state.map = makeMap();
    mapModule.requestGPS();
    settings.current.showLocation = false; // toggled off before the fix lands
    calls.current[0].ok({ coords: { latitude: 49.5, longitude: 8.5 } });
    expect(state.map.invalidateSize).not.toHaveBeenCalled();
  });

  it('the delayed retries keep re-dropping the dot (100ms / 1s / 5s)', () => {
    const calls = installGeolocation();
    settings.current.showLocation = true;
    state.map = makeMap();
    vi.useFakeTimers();
    mapModule.requestGPS();
    calls.current[0].ok({ coords: { latitude: 49.5, longitude: 8.5 } });
    state.map.invalidateSize.mockClear();
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(900); // → 1000
    expect(state.map.invalidateSize).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(4000); // → 5000 (final one does not invalidateSize)
    // The 5s retry only calls setUserLocationMarker, not invalidateSize.
    expect(state.map.invalidateSize).toHaveBeenCalledTimes(2);
  });

  it('logs the error code on failure without throwing', () => {
    const calls = installGeolocation();
    settings.current.showLocation = true;
    state.map = makeMap();
    mapModule.requestGPS();
    expect(() => calls.current[0].err({ code: 2 })).not.toThrow();
  });

  it('tolerates matchMedia being present (standalone display-mode probe)', () => {
    const calls = installGeolocation();
    settings.current.showLocation = true;
    state.map = makeMap();
    const mm = vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true });
    mapModule.requestGPS();
    expect(navigator.geolocation.getCurrentPosition).toHaveBeenCalled();
    mm.mockRestore();
    expect(calls.current).toHaveLength(1);
  });
});
