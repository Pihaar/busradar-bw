/**
 * Tests for static/init.js — the app bootstrap module.
 *
 * init.js has NO exports. It does three things this suite exercises fully:
 *   1. settings._bindUI() — assigned onto the imported settings singleton at
 *      module-eval time (outside the bootstrap guard), so it is testable after
 *      any import. Wires every ⚙ settings-panel control (refresh, interpolation,
 *      posmode, theme, location, language, reset, about dialog, and the
 *      visibilitychange/pagehide save hooks).
 *   2. init() — module-private. Resolves the URL viewport, builds
 *      map/stops/search/ui, wires the zoomend/moveend/popstate/visibilitychange
 *      handlers and starts the SSE stream. It is reachable ONLY through the
 *      bootstrap guard, so it is driven here via a no-flag fresh import.
 *   3. The outer `if (!window.__BUSRADAR_TEST__)` guard (both arms) + the two
 *      window-level offline/online listeners that live OUTSIDE the guard and
 *      attach on every import regardless of the flag.
 *
 * The SW-registration block (https-only, unreachable under happy-dom's http
 * origin) is marked with a v8-ignore range in the source and is not driven here.
 *
 * Listener hygiene: a no-flag import re-attaches window-level listeners, and
 * vi.resetModules() does NOT clear the happy-dom window. Every add/remove is
 * routed through wrappers that record it; afterEach removes every recorded
 * listener and restores the genuine add/remove functions, so nothing stacks
 * into other tests or suites. Within a test we still grab the LAST recorded
 * callback of a type (the one the current import added).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Minimal Leaflet stub: init.js's import graph (map.js/ui.js) touches L at
// module-eval time. Only latLng is reached before our mocks take over.
globalThis.L = { latLng: (lat, lon) => ({ lat, lng: lon, distanceTo: () => 0 }) };

// --- recorded listeners -----------------------------------------------------
const winRec = {};
const docRec = {};
const winAll = []; // {type, cb} for exhaustive cleanup
const docAll = [];
const origWinAdd = window.addEventListener.bind(window);
const origWinRemove = window.removeEventListener.bind(window);
const origDocAdd = document.addEventListener.bind(document);
const origDocRemove = document.removeEventListener.bind(document);

function installRecorders() {
  window.addEventListener = (type, cb, opts) => {
    (winRec[type] = winRec[type] || []).push(cb);
    winAll.push({ type, cb });
    return origWinAdd(type, cb, opts);
  };
  document.addEventListener = (type, cb, opts) => {
    (docRec[type] = docRec[type] || []).push(cb);
    docAll.push({ type, cb });
    return origDocAdd(type, cb, opts);
  };
}
function clearRecorderMaps() {
  for (const k in winRec) delete winRec[k];
  for (const k in docRec) delete docRec[k];
}
function removeAllRecorded() {
  winAll.forEach(({ type, cb }) => origWinRemove(type, cb));
  docAll.forEach(({ type, cb }) => origDocRemove(type, cb));
  winAll.length = 0;
  docAll.length = 0;
}
function lastWin(type) {
  const l = winRec[type] || [];
  return l[l.length - 1];
}
function lastDoc(type) {
  const l = docRec[type] || [];
  return l[l.length - 1];
}
function setReadyState(v) {
  Object.defineProperty(document, 'readyState', { value: v, configurable: true });
}

// --- module mocks -----------------------------------------------------------
// state.js is NOT mocked: init.js binds the real settings singleton and reads
// real state. Everything else is a spy so init() has no real side effects.
vi.mock('../../static/debug.js', () => ({}));

const uiMock = {
  init: vi.fn(),
  closePanel: vi.fn(),
  selectJourney: vi.fn(),
  focusJourneyById: vi.fn(),
  showStationBoard: vi.fn(),
  switchTab: vi.fn(),
};
const searchMock = { init: vi.fn() };
vi.mock('../../static/ui.js', () => ({ ui: uiMock, search: searchMock }));

const refreshMock = {
  startStream: vi.fn(),
  notifyViewportChange: vi.fn(),
  refresh: vi.fn(),
  showError: vi.fn(),
  announce: vi.fn(),
};
vi.mock('../../static/refresh.js', () => refreshMock);

const urlStateMock = { parse: vi.fn(() => Object.create(null)), saveMapPosition: vi.fn() };
vi.mock('../../static/api.js', () => ({
  trackedFetch: (...a) => window.fetch(...a),
  urlState: urlStateMock,
}));

const mapMock = {
  mapModule: { init: vi.fn() },
  stopsLayer: { init: vi.fn(), loadAll: vi.fn() },
  setUserLocationMarker: vi.fn(),
  startLocationWatch: vi.fn(),
  stopLocationWatch: vi.fn(),
  removeUserLocationMarker: vi.fn(),
};
vi.mock('../../static/map.js', () => mapMock);

// A map object exposing exactly the surface init()'s handlers touch. init()
// wires state.map.on('zoomend'|'moveend'), and the popstate/restore paths call
// getCenter/getBounds/getZoom/setView. mapModule.init is what populates it.
function makeMap() {
  const handlers = {};
  return {
    on: vi.fn((evt, cb) => {
      (handlers[evt] = handlers[evt] || []).push(cb);
    }),
    fire(evt, arg) {
      (handlers[evt] || []).forEach((cb) => cb(arg));
    },
    getCenter: vi.fn(() => ({ lat: 49.342, lng: 8.66 })),
    getBounds: vi.fn(() => ({
      getSouthWest: () => ({ lat: 49.341, lng: 8.6588 }),
      getNorthEast: () => ({ lat: 49.343, lng: 8.6612 }),
    })),
    getZoom: vi.fn(() => 14),
    setView: vi.fn(),
  };
}

// Full ⚙ settings-panel + about-dialog fixture. Mirrors static/index.html so
// every getElementById/querySelectorAll in _bindUI + settings.init resolves.
function buildSettingsDom() {
  document.body.innerHTML = `
    <meta id="meta-theme-color" content="#0a0e1a" />
    <button id="settings-btn" aria-expanded="false"></button>
    <div id="settings-panel" hidden>
      <div id="settings-hint" hidden></div>
      <div class="settings-options" id="setting-posmode">
        <button class="settings-opt settings-opt--active" data-value="CALC"></button>
        <button class="settings-opt" data-value="REPORT_ONLY"></button>
      </div>
      <div class="settings-options" id="setting-refresh">
        <button class="settings-opt settings-opt--active" data-value="10000"></button>
        <button class="settings-opt" data-value="20000"></button>
        <button class="settings-opt" data-value="30000"></button>
      </div>
      <div class="settings-options" id="setting-interpolation">
        <button class="settings-opt settings-opt--active" data-value="on"></button>
        <button class="settings-opt" data-value="off"></button>
      </div>
      <div class="settings-hint" id="hint-animation-disabled" hidden></div>
      <div class="settings-options" id="setting-theme">
        <button class="settings-opt settings-opt--active" data-value="dark"></button>
        <button class="settings-opt" data-value="light"></button>
      </div>
      <div class="settings-options" id="setting-location">
        <button class="settings-opt" data-value="on"></button>
        <button class="settings-opt settings-opt--active" data-value="off"></button>
      </div>
      <div class="settings-options" id="setting-language">
        <button class="settings-opt settings-opt--active" data-value="de"></button>
        <button class="settings-opt" data-value="en"></button>
      </div>
      <button id="setting-reset"></button>
    </div>
    <dialog id="about-dialog"><span class="about-body"></span><button class="about-close"></button></dialog>
  `;
}

function optOf(groupId, value) {
  return document.querySelector('#' + groupId + ' .settings-opt[data-value="' + value + '"]');
}
function click(el) {
  el.dispatchEvent(new window.Event('click', { bubbles: true }));
}

let state;
let settings;
const savedNavigator = globalThis.navigator;

// The default beforeEach imports init.js WITH the test flag so the bootstrap
// guard is skipped: it gives us settings._bindUI + the offline/online listeners
// without auto-running init(). The init()/guard-true-arm blocks override this
// via their own fresh no-flag imports.
beforeEach(async () => {
  clearRecorderMaps();
  installRecorders();
  vi.clearAllMocks();
  buildSettingsDom();
  setReadyState('complete');

  window.__BUSRADAR_TEST__ = true;
  vi.resetModules();
  const st = await import('../../static/state.js');
  state = st.state;
  settings = st.settings;
  // Side-effect import: installs settings._bindUI + the offline/online
  // listeners. With the flag set, init()/SW are skipped.
  await import('../../static/init.js');

  state.map = null;
  state.vehicles = new Map();
  state.allStops = new Map();
  state.selectedJid = null;
  state.selectedStop = null;
  state._navigating = false;
  state._restoreInProgress = false;
  state._followPanning = false;
  state._gpsControlContainer = null;
  urlStateMock.parse.mockReturnValue(Object.create(null));
  mapMock.mapModule.init.mockImplementation(() => {
    state.map = makeMap();
  });
});

afterEach(() => {
  removeAllRecorded();
  window.addEventListener = origWinAdd;
  window.removeEventListener = origWinRemove;
  document.addEventListener = origDocAdd;
  document.removeEventListener = origDocRemove;
  delete window.__BUSRADAR_TEST__;
  globalThis.navigator = savedNavigator;
  setReadyState('complete');
  vi.useRealTimers();
});

// Run init.js WITHOUT the flag in a fresh registry so the real (private) init()
// executes. Returns the fresh state + the mocked map module so a test can fire
// the map handlers init() wired. Recorded listeners are cleaned in afterEach.
async function freshInit(params, ready = 'complete') {
  clearRecorderMaps();
  installRecorders();
  vi.clearAllMocks();
  delete window.__BUSRADAR_TEST__;
  vi.resetModules();
  setReadyState(ready);
  buildSettingsDom();
  const st = await import('../../static/state.js');
  const map = await import('../../static/map.js');
  map.mapModule.init.mockImplementation(() => {
    st.state.map = makeMap();
  });
  urlStateMock.parse.mockReturnValue(params || Object.create(null));
  await import('../../static/init.js');
  return { state: st.state, settings: st.settings, map };
}

describe('bootstrap guard — flag-set import skips init() and SW', () => {
  it('importing with __BUSRADAR_TEST__ set does NOT auto-run init()', () => {
    expect(mapMock.mapModule.init).not.toHaveBeenCalled();
    expect(refreshMock.startStream).not.toHaveBeenCalled();
    // _bindUI was still installed onto the settings singleton (outside guard).
    expect(typeof settings._bindUI).toBe('function');
  });
});

describe('settings._bindUI — settings button toggle', () => {
  beforeEach(() => settings.init());

  it('opening the panel unhides it, sets aria-expanded and refreshes the hint', () => {
    const spy = vi.spyOn(settings, '_updateHint');
    const btn = document.getElementById('settings-btn');
    const panel = document.getElementById('settings-panel');
    settings._bindUI();
    click(btn);
    expect(panel.hidden).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(spy).toHaveBeenCalled();
  });

  it('closing the panel re-hides it and does not refresh the hint', () => {
    const spy = vi.spyOn(settings, '_updateHint');
    const btn = document.getElementById('settings-btn');
    const panel = document.getElementById('settings-panel');
    settings._bindUI();
    click(btn); // open
    spy.mockClear();
    click(btn); // close
    expect(panel.hidden).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('settings._bindUI — refresh interval', () => {
  beforeEach(() => {
    settings.init();
    settings._bindUI();
  });

  it('picks the interval, persists it and re-anchors the viewport', () => {
    settings.current.posMode = 'CALC';
    click(optOf('setting-refresh', '20000'));
    expect(settings.current.refreshInterval).toBe(20000);
    expect(settings._userRefreshInterval).toBe(20000);
    expect(state.currentInterval).toBe(20000);
    expect(refreshMock.notifyViewportChange).toHaveBeenCalled();
    expect(refreshMock.announce).toHaveBeenCalled();
    expect(optOf('setting-refresh', '20000').classList.contains('settings-opt--active')).toBe(true);
  });

  it('is inert in REPORT_ONLY mode (guard early-returns)', () => {
    settings.current.posMode = 'REPORT_ONLY';
    const before = settings.current.refreshInterval;
    refreshMock.notifyViewportChange.mockClear();
    click(optOf('setting-refresh', '20000'));
    expect(settings.current.refreshInterval).toBe(before);
    expect(refreshMock.notifyViewportChange).not.toHaveBeenCalled();
  });
});

describe('settings._bindUI — interpolation toggle', () => {
  beforeEach(() => {
    settings.init();
    settings._bindUI();
  });

  it('turning animation ON records the user preference and announces it', () => {
    settings.current.posMode = 'CALC';
    click(optOf('setting-interpolation', 'on'));
    expect(settings._userInterpolation).toBe(true);
    expect(settings.current.interpolation).toBe(true);
    expect(refreshMock.announce).toHaveBeenCalled();
  });

  it('turning animation OFF cancels in-flight anim frames and snaps markers home', () => {
    settings.current.posMode = 'CALC';
    const cancel = vi.spyOn(globalThis, 'cancelAnimationFrame');
    const setLatLng = vi.fn();
    state.vehicles.set('j1', {
      _animFrame: 7,
      marker: { setLatLng },
      data: { lat: 49.3, lon: 8.6 },
    });
    click(optOf('setting-interpolation', 'off'));
    expect(settings._userInterpolation).toBe(false);
    expect(cancel).toHaveBeenCalledWith(7);
    expect(state.vehicles.get('j1')._animFrame).toBeNull();
    expect(setLatLng).toHaveBeenCalledWith([49.3, 8.6]);
  });

  it('turning OFF with no active anim frame skips cancelAnimationFrame', () => {
    settings.current.posMode = 'CALC';
    const cancel = vi.spyOn(globalThis, 'cancelAnimationFrame');
    const setLatLng = vi.fn();
    state.vehicles.set('j2', { _animFrame: null, marker: { setLatLng }, data: { lat: 1, lon: 2 } });
    click(optOf('setting-interpolation', 'off'));
    expect(cancel).not.toHaveBeenCalled();
    expect(setLatLng).toHaveBeenCalledWith([1, 2]);
  });

  it('is inert in REPORT_ONLY mode', () => {
    settings.current.posMode = 'REPORT_ONLY';
    settings._userInterpolation = true;
    click(optOf('setting-interpolation', 'off'));
    expect(settings._userInterpolation).toBe(true);
  });

  it('reflects a stored interpolation=off when binding the initial group state', () => {
    // Drives the false arm of the `interpolation ? 'on' : 'off'` initial
    // _updateGroup call at bind time (default init leaves it true).
    settings.current.interpolation = false;
    settings._bindUI();
    expect(optOf('setting-interpolation', 'off').classList.contains('settings-opt--active')).toBe(
      true,
    );
  });
});

describe('settings._bindUI — posmode toggle', () => {
  beforeEach(() => {
    settings.init();
    settings._bindUI();
  });

  it('switching to CALC announces the calc message and re-anchors', () => {
    click(optOf('setting-posmode', 'CALC'));
    expect(settings.current.posMode).toBe('CALC');
    expect(refreshMock.notifyViewportChange).toHaveBeenCalled();
    expect(refreshMock.announce).toHaveBeenCalled();
  });

  it('switching to REPORT_ONLY with animation preference ON announces the gps message', () => {
    settings._userInterpolation = true;
    click(optOf('setting-posmode', 'REPORT_ONLY'));
    expect(settings.current.posMode).toBe('REPORT_ONLY');
    expect(refreshMock.announce).toHaveBeenCalled();
  });

  it('switching to REPORT_ONLY with animation preference OFF announces the gps-anim-off message', () => {
    settings._userInterpolation = false;
    click(optOf('setting-posmode', 'REPORT_ONLY'));
    expect(settings.current.posMode).toBe('REPORT_ONLY');
    expect(refreshMock.announce).toHaveBeenCalled();
  });
});

describe('settings._bindUI — theme toggle', () => {
  beforeEach(() => {
    settings.init();
    settings._bindUI();
  });

  it('choosing light applies the theme attribute and announces light', () => {
    const apply = vi.spyOn(settings, '_applyThemeAttr');
    const tiles = vi.spyOn(settings, 'applyTileLayers');
    click(optOf('setting-theme', 'light'));
    expect(settings.current.theme).toBe('light');
    expect(apply).toHaveBeenCalled();
    expect(tiles).toHaveBeenCalled();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('choosing dark announces the dark message', () => {
    settings.current.theme = 'light';
    click(optOf('setting-theme', 'dark'));
    expect(settings.current.theme).toBe('dark');
    expect(refreshMock.announce).toHaveBeenCalled();
  });
});

describe('settings._bindUI — location toggle', () => {
  beforeEach(() => settings.init());

  function installGeo(getImpl) {
    globalThis.navigator = { geolocation: { getCurrentPosition: getImpl } };
  }

  it('turning ON with no geolocation support shows an error and does not proceed', () => {
    globalThis.navigator = {};
    settings._bindUI();
    click(optOf('setting-location', 'on'));
    expect(refreshMock.showError).toHaveBeenCalled();
    expect(settings.current.showLocation).not.toBe(true);
  });

  it('turning ON success sets showLocation, centers the map and starts the watch', () => {
    const gpsContainer = { style: { display: 'none' } };
    state._gpsControlContainer = gpsContainer;
    state.map = makeMap();
    installGeo((ok) => ok({ coords: { latitude: 49.5, longitude: 8.5 } }));
    settings._bindUI();
    click(optOf('setting-location', 'on'));
    expect(settings.current.showLocation).toBe(true);
    expect(mapMock.setUserLocationMarker).toHaveBeenCalledWith(49.5, 8.5);
    expect(state.map.setView).toHaveBeenCalled();
    expect(mapMock.startLocationWatch).toHaveBeenCalled();
    expect(gpsContainer.style.display).toBe('');
  });

  it('turning ON success is discarded when the toggle nonce was superseded', () => {
    state.map = makeMap();
    let cb;
    installGeo((ok) => {
      cb = ok;
    });
    settings._bindUI();
    click(optOf('setting-location', 'on'));
    settings._locationToggleNonce++; // user flipped OFF before the async fix
    cb({ coords: { latitude: 49.5, longitude: 8.5 } });
    expect(mapMock.setUserLocationMarker).not.toHaveBeenCalled();
  });

  it.each([
    [1, 'location_denied'],
    [2, 'location_unavailable'],
    [3, 'location_timeout'],
    [99, 'location_error'],
    [undefined, 'location_error'],
  ])('error code %s maps to a distinct message', (code) => {
    state.map = makeMap();
    installGeo((_ok, err) => err(code === undefined ? {} : { code }));
    settings._bindUI();
    refreshMock.showError.mockClear();
    click(optOf('setting-location', 'on'));
    expect(refreshMock.showError).toHaveBeenCalledTimes(1);
  });

  it('error callback is discarded when the toggle nonce was superseded', () => {
    installGeo((_ok, err) => {
      settings._locationToggleNonce++; // supersede before the error fires
      err({ code: 1 });
    });
    settings._bindUI();
    refreshMock.showError.mockClear();
    click(optOf('setting-location', 'on'));
    expect(refreshMock.showError).not.toHaveBeenCalled();
  });

  it('turning OFF stops the watch, removes the dot and hides the gps control', () => {
    const gpsContainer = { style: { display: '' } };
    state._gpsControlContainer = gpsContainer;
    installGeo(() => {});
    settings._bindUI();
    click(optOf('setting-location', 'off'));
    expect(settings.current.showLocation).toBe(false);
    expect(mapMock.stopLocationWatch).toHaveBeenCalled();
    expect(mapMock.removeUserLocationMarker).toHaveBeenCalled();
    expect(gpsContainer.style.display).toBe('none');
  });

  it('turning OFF with no gps control container present is still safe', () => {
    state._gpsControlContainer = null;
    installGeo(() => {});
    settings._bindUI();
    click(optOf('setting-location', 'off'));
    expect(mapMock.stopLocationWatch).toHaveBeenCalled();
  });

  it('turning ON success with no gps control container present is still safe', () => {
    state._gpsControlContainer = null;
    state.map = makeMap();
    installGeo((ok) => ok({ coords: { latitude: 49.5, longitude: 8.5 } }));
    settings._bindUI();
    click(optOf('setting-location', 'on'));
    expect(mapMock.setUserLocationMarker).toHaveBeenCalled();
  });
});

describe('settings._bindUI — language toggle', () => {
  beforeEach(() => {
    settings.init();
    settings._bindUI();
  });

  it('choosing a new language persists settings and reloads', () => {
    settings.current.lang = 'de';
    const reload = vi.fn();
    location.reload = reload;
    localStorage.clear();
    click(optOf('setting-language', 'en'));
    expect(settings.current.lang).toBe('en');
    expect(JSON.parse(localStorage.getItem('busradar_settings_v1')).lang).toBe('en');
    expect(reload).toHaveBeenCalled();
  });

  it('choosing the already-active language is a no-op (no reload)', () => {
    settings.current.lang = 'de';
    const reload = vi.fn();
    location.reload = reload;
    click(optOf('setting-language', 'de'));
    expect(reload).not.toHaveBeenCalled();
  });

  it('reload still fires when localStorage.setItem throws', () => {
    settings.current.lang = 'de';
    const reload = vi.fn();
    location.reload = reload;
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    click(optOf('setting-language', 'en'));
    expect(reload).toHaveBeenCalled();
    setItem.mockRestore();
  });
});

describe('settings._bindUI — reset flow', () => {
  let confirmSpy;
  let replaceSpy;

  beforeEach(() => {
    settings.init();
    replaceSpy = vi.fn();
    location.replace = replaceSpy;
    window.confirm = vi.fn(() => true);
    confirmSpy = window.confirm;
  });

  it('cancelling the confirm dialog aborts the reset', () => {
    window.confirm = vi.fn(() => false);
    settings._bindUI();
    const btn = document.getElementById('setting-reset');
    click(btn);
    expect(btn.disabled).toBe(false);
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it('confirmed reset clears storage, unregisters SW/caches and reloads with a cache-buster', async () => {
    globalThis.caches = {
      keys: vi.fn(() => Promise.resolve(['c1', 'c2'])),
      delete: vi.fn(() => Promise.resolve(true)),
    };
    globalThis.navigator = {
      serviceWorker: {
        getRegistrations: vi.fn(() =>
          Promise.resolve([{ unregister: vi.fn(() => Promise.resolve()) }]),
        ),
      },
    };
    settings._bindUI();
    const btn = document.getElementById('setting-reset');
    click(btn);
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    await vi.waitFor(() => expect(replaceSpy).toHaveBeenCalled());
    expect(replaceSpy.mock.calls[0][0]).toContain('?_=');
    expect(globalThis.caches.delete).toHaveBeenCalledTimes(2);
    delete globalThis.caches;
  });

  it('a second click while resetting is ignored (re-entrancy guard)', () => {
    globalThis.caches = { keys: vi.fn(() => new Promise(() => {})) };
    globalThis.navigator = {
      serviceWorker: { getRegistrations: vi.fn(() => new Promise(() => {})) },
    };
    settings._bindUI();
    const btn = document.getElementById('setting-reset');
    click(btn);
    click(btn); // ignored: resetting === true
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    delete globalThis.caches;
  });

  it('reset tolerates caches being undefined and serviceWorker being absent', async () => {
    delete globalThis.caches;
    globalThis.navigator = {}; // no serviceWorker
    settings._bindUI();
    click(document.getElementById('setting-reset'));
    await vi.waitFor(() => expect(replaceSpy).toHaveBeenCalled());
  });

  it('reset tolerates serviceWorker present but getRegistrations absent', async () => {
    delete globalThis.caches;
    globalThis.navigator = { serviceWorker: {} };
    settings._bindUI();
    click(document.getElementById('setting-reset'));
    await vi.waitFor(() => expect(replaceSpy).toHaveBeenCalled());
  });

  it('reset tolerates localStorage.clear / sessionStorage.clear throwing', async () => {
    delete globalThis.caches;
    globalThis.navigator = {};
    const clr = vi.spyOn(Storage.prototype, 'clear').mockImplementation(() => {
      throw new Error('nope');
    });
    settings._bindUI();
    click(document.getElementById('setting-reset'));
    await vi.waitFor(() => expect(replaceSpy).toHaveBeenCalled());
    clr.mockRestore();
  });

  it('safeClearCaches swallows a rejecting caches.keys and still reloads', async () => {
    globalThis.caches = { keys: vi.fn(() => Promise.reject(new Error('boom'))), delete: vi.fn() };
    globalThis.navigator = {};
    settings._bindUI();
    click(document.getElementById('setting-reset'));
    await vi.waitFor(() => expect(replaceSpy).toHaveBeenCalled());
    delete globalThis.caches;
  });

  it('safeClearCaches swallows a per-key delete rejection', async () => {
    globalThis.caches = {
      keys: vi.fn(() => Promise.resolve(['c1'])),
      delete: vi.fn(() => Promise.reject(new Error('locked'))),
    };
    globalThis.navigator = {};
    settings._bindUI();
    click(document.getElementById('setting-reset'));
    await vi.waitFor(() => expect(replaceSpy).toHaveBeenCalled());
    delete globalThis.caches;
  });

  it('caches present but caches.keys missing → safeClearCaches early-returns', async () => {
    globalThis.caches = {}; // typeof !== 'undefined' but no .keys
    globalThis.navigator = {};
    settings._bindUI();
    click(document.getElementById('setting-reset'));
    await vi.waitFor(() => expect(replaceSpy).toHaveBeenCalled());
    delete globalThis.caches;
  });

  it('safeUnregisterSW swallows a per-reg unregister rejection', async () => {
    delete globalThis.caches;
    globalThis.navigator = {
      serviceWorker: {
        getRegistrations: vi.fn(() =>
          Promise.resolve([{ unregister: vi.fn(() => Promise.reject(new Error('x'))) }]),
        ),
      },
    };
    settings._bindUI();
    click(document.getElementById('setting-reset'));
    await vi.waitFor(() => expect(replaceSpy).toHaveBeenCalled());
  });

  it('safeUnregisterSW swallows getRegistrations itself rejecting', async () => {
    delete globalThis.caches;
    globalThis.navigator = {
      serviceWorker: { getRegistrations: vi.fn(() => Promise.reject(new Error('denied'))) },
    };
    settings._bindUI();
    click(document.getElementById('setting-reset'));
    await vi.waitFor(() => expect(replaceSpy).toHaveBeenCalled());
  });

  it('safeClearCaches outer try/catch swallows a synchronous throw from caches access', async () => {
    // A getter that throws makes the `!caches.keys` probe throw synchronously,
    // hitting the outer try/catch (not the promise .catch).
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      get() {
        throw new Error('sync');
      },
    });
    globalThis.navigator = {};
    settings._bindUI();
    click(document.getElementById('setting-reset'));
    await vi.waitFor(() => expect(replaceSpy).toHaveBeenCalled());
    delete globalThis.caches;
  });

  it('safeUnregisterSW outer try/catch swallows a synchronous throw from getRegistrations', async () => {
    delete globalThis.caches;
    globalThis.navigator = {
      serviceWorker: {
        getRegistrations: () => {
          throw new Error('sync'); // throws synchronously, not a rejection
        },
      },
    };
    settings._bindUI();
    click(document.getElementById('setting-reset'));
    await vi.waitFor(() => expect(replaceSpy).toHaveBeenCalled());
  });

  it('is not bound when the reset button is absent from the DOM', () => {
    document.getElementById('setting-reset').remove();
    expect(() => settings._bindUI()).not.toThrow();
  });
});

describe('settings._bindUI — about dialog', () => {
  beforeEach(() => settings.init());

  it('the close button closes the dialog', () => {
    const dialog = document.getElementById('about-dialog');
    const close = vi.spyOn(dialog, 'close');
    settings._bindUI();
    click(dialog.querySelector('.about-close'));
    expect(close).toHaveBeenCalled();
  });

  it('clicking the backdrop (target === dialog) closes it', () => {
    const dialog = document.getElementById('about-dialog');
    const close = vi.spyOn(dialog, 'close');
    settings._bindUI();
    dialog.dispatchEvent(new window.Event('click', { bubbles: true }));
    expect(close).toHaveBeenCalled();
  });

  it('a click on inner content (target !== dialog) does NOT close it', () => {
    const dialog = document.getElementById('about-dialog');
    const close = vi.spyOn(dialog, 'close');
    settings._bindUI();
    // The inner span has no own close handler; its click bubbles to the dialog
    // listener, whose `target === dialog` guard is then false.
    click(dialog.querySelector('.about-body'));
    expect(close).not.toHaveBeenCalled();
  });

  it('is safe when the about dialog is absent', () => {
    document.getElementById('about-dialog').remove();
    expect(() => settings._bindUI()).not.toThrow();
  });
});

describe('settings._bindUI — save-on-hide hooks', () => {
  beforeEach(() => {
    settings.init();
    settings._bindUI();
  });

  it('visibilitychange to hidden flushes the pending save', () => {
    const flush = vi.spyOn(settings, '_flushSave');
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new window.Event('visibilitychange'));
    expect(flush).toHaveBeenCalled();
  });

  it('visibilitychange to visible does NOT flush', () => {
    const flush = vi.spyOn(settings, '_flushSave');
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new window.Event('visibilitychange'));
    expect(flush).not.toHaveBeenCalled();
  });

  it('pagehide flushes the pending save', () => {
    const flush = vi.spyOn(settings, '_flushSave');
    window.dispatchEvent(new window.Event('pagehide'));
    expect(flush).toHaveBeenCalled();
  });
});

describe('init() — map/stream wiring', () => {
  it('builds the map at the default center when the URL has no viewport', async () => {
    const { map } = await freshInit();
    expect(map.mapModule.init).toHaveBeenCalledTimes(1);
    expect(map.stopsLayer.init).toHaveBeenCalled();
    expect(searchMock.init).toHaveBeenCalled();
    expect(uiMock.init).toHaveBeenCalled();
    expect(refreshMock.startStream).toHaveBeenCalled();
    expect(map.stopsLayer.loadAll).toHaveBeenCalledWith(49.342, 8.66, 5000);
  });

  it('uses the URL viewport when lat/lon/z are all valid', async () => {
    const { map } = await freshInit({ lat: '49.5', lon: '8.5', z: '16' });
    expect(map.mapModule.init).toHaveBeenCalledWith([49.5, 8.5], 16);
  });

  it('falls back to defaults when a URL coordinate is out of range', async () => {
    const { map } = await freshInit({ lat: '999', lon: '8.5', z: '16' });
    expect(map.mapModule.init.mock.calls[0][0]).toEqual([49.2944, 8.6434]);
  });

  it('marks a restore in progress when the URL carries a jid', async () => {
    const { state: s } = await freshInit({ jid: 'J1' });
    expect(s._restoreInProgress).toBe(true);
    expect(s._pendingRestore).toEqual({ jid: 'J1' });
  });

  it('marks a restore in progress when the URL carries a stop', async () => {
    const { state: s } = await freshInit({ stop: '6003411' });
    expect(s._restoreInProgress).toBe(true);
  });

  it('no restore when the URL is bare', async () => {
    const { state: s } = await freshInit();
    expect(s._restoreInProgress).toBe(false);
    expect(s._pendingRestore).toBeNull();
  });
});

describe('init() — map event handlers', () => {
  let s;
  let freshSettings;
  beforeEach(async () => {
    ({ state: s, settings: freshSettings } = await freshInit());
  });

  it('zoomend refreshes the settings hint only while the panel is open', () => {
    const spy = vi.spyOn(freshSettings, '_updateHint');
    document.getElementById('settings-panel').hidden = false;
    s.map.fire('zoomend');
    expect(spy).toHaveBeenCalled();
  });

  it('zoomend does nothing while the settings panel is hidden', () => {
    const spy = vi.spyOn(freshSettings, '_updateHint');
    document.getElementById('settings-panel').hidden = true;
    s.map.fire('zoomend');
    expect(spy).not.toHaveBeenCalled();
  });

  it('moveend saves the map URL and re-anchors the viewport when nothing is selected', () => {
    s.selectedJid = null;
    s.selectedStop = null;
    s.map.fire('moveend');
    expect(urlStateMock.saveMapPosition).toHaveBeenCalled();
    expect(refreshMock.notifyViewportChange).toHaveBeenCalled();
  });

  it('moveend skips the URL save while a journey is selected but still re-anchors', () => {
    s.selectedJid = 'J1';
    urlStateMock.saveMapPosition.mockClear();
    refreshMock.notifyViewportChange.mockClear();
    s.map.fire('moveend');
    expect(urlStateMock.saveMapPosition).not.toHaveBeenCalled();
    expect(refreshMock.notifyViewportChange).toHaveBeenCalled();
  });

  it('moveend bails out entirely during a restore', () => {
    s._restoreInProgress = true;
    refreshMock.notifyViewportChange.mockClear();
    s.map.fire('moveend');
    expect(refreshMock.notifyViewportChange).not.toHaveBeenCalled();
  });

  it('moveend bails out while navigating', () => {
    s._navigating = true;
    refreshMock.notifyViewportChange.mockClear();
    s.map.fire('moveend');
    expect(refreshMock.notifyViewportChange).not.toHaveBeenCalled();
  });

  it('the second zoomend handler re-anchors the viewport', () => {
    refreshMock.notifyViewportChange.mockClear();
    s.map.fire('zoomend');
    expect(refreshMock.notifyViewportChange).toHaveBeenCalled();
  });

  it('the second zoomend handler bails out during a follow-pan', () => {
    s._followPanning = true;
    refreshMock.notifyViewportChange.mockClear();
    s.map.fire('zoomend');
    expect(refreshMock.notifyViewportChange).not.toHaveBeenCalled();
  });

  it('init visibilitychange to visible triggers a refresh', () => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    refreshMock.refresh.mockClear();
    lastDoc('visibilitychange')(new window.Event('visibilitychange'));
    expect(refreshMock.refresh).toHaveBeenCalled();
  });

  it('init visibilitychange to hidden does not refresh', () => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    refreshMock.refresh.mockClear();
    lastDoc('visibilitychange')(new window.Event('visibilitychange'));
    expect(refreshMock.refresh).not.toHaveBeenCalled();
  });
});

describe('init() — popstate handler', () => {
  let s;
  let popstate;
  beforeEach(async () => {
    ({ state: s } = await freshInit());
    popstate = lastWin('popstate');
    urlStateMock._pushCount = 0;
  });

  const ev = (stateObj) => ({ state: stateObj });

  it('jid with a known vehicle selects it and applies the URL viewport', () => {
    s.vehicles.set('J1', { data: { jid: 'J1' } });
    urlStateMock._pushCount = 2;
    popstate(ev({ jid: 'J1', lat: '49.5', lon: '8.5', z: '15' }));
    expect(s.map.setView).toHaveBeenCalledWith([49.5, 8.5], 15);
    expect(uiMock.selectJourney).toHaveBeenCalledWith({ jid: 'J1' }, true);
    expect(urlStateMock._pushCount).toBe(1); // decremented
  });

  it('jid with a known vehicle but out-of-range viewport skips setView', () => {
    s.vehicles.set('J1', { data: { jid: 'J1' } });
    popstate(ev({ jid: 'J1', lat: '999', lon: '8.5', z: '15' }));
    expect(s.map.setView).not.toHaveBeenCalled();
    expect(uiMock.selectJourney).toHaveBeenCalled();
  });

  it('jid known vehicle, viewport partially present → no setView', () => {
    s.vehicles.set('J1', { data: { jid: 'J1' } });
    popstate(ev({ jid: 'J1', lat: '49.5' })); // lon/z missing
    expect(s.map.setView).not.toHaveBeenCalled();
    expect(uiMock.selectJourney).toHaveBeenCalled();
  });

  it('jid without a loaded vehicle focuses it by id', () => {
    popstate(ev({ jid: 'J404' }));
    expect(uiMock.focusJourneyById).toHaveBeenCalledWith('J404', {}, true);
  });

  it('stop by extId shows the station board and applies the viewport', () => {
    s.allStops.set('s1', { data: { extId: '6003411', name: 'X' } });
    popstate(ev({ stop: '6003411', lat: '49.5', lon: '8.5', z: '15' }));
    expect(s.map.setView).toHaveBeenCalledWith([49.5, 8.5], 15);
    expect(uiMock.showStationBoard).toHaveBeenCalledWith({ extId: '6003411', name: 'X' }, true);
  });

  it('stop with tab=arr also switches to the arrivals tab', () => {
    s.allStops.set('s1', { data: { extId: '6003411', name: 'X' } });
    popstate(ev({ stop: '6003411', tab: 'arr' }));
    expect(uiMock.switchTab).toHaveBeenCalledWith('arrivals');
  });

  it('numeric stop id not in allStops synthesizes a minimal stop entry', () => {
    // A present-but-non-matching stop drives the forEach `if` false-arm too.
    s.allStops.set('other', { data: { extId: '9999999', name: 'Other' } });
    popstate(ev({ stop: '12345' }));
    expect(uiMock.showStationBoard).toHaveBeenCalledTimes(1);
    const arg = uiMock.showStationBoard.mock.calls[0][0];
    expect(arg.extId).toBe('12345');
    expect(arg.lid).toBe('A=1@L=12345@');
  });

  it('non-numeric unknown stop id resolves to nothing (no board shown)', () => {
    popstate(ev({ stop: 'abc' }));
    expect(uiMock.showStationBoard).not.toHaveBeenCalled();
  });

  it('stop with an out-of-range viewport skips setView but still shows the board', () => {
    s.allStops.set('s1', { data: { extId: '6003411', name: 'X' } });
    popstate(ev({ stop: '6003411', lat: '999', lon: '8.5', z: '15' }));
    expect(s.map.setView).not.toHaveBeenCalled();
    expect(uiMock.showStationBoard).toHaveBeenCalled();
  });

  it('bare state closes the panel and applies a valid viewport', () => {
    popstate(ev({ lat: '49.5', lon: '8.5', z: '15' }));
    expect(uiMock.closePanel).toHaveBeenCalled();
    expect(s.map.setView).toHaveBeenCalledWith([49.5, 8.5], 15);
  });

  it('bare state with an out-of-range viewport closes the panel without setView', () => {
    popstate(ev({ lat: '999', lon: '8.5', z: '15' }));
    expect(uiMock.closePanel).toHaveBeenCalled();
    expect(s.map.setView).not.toHaveBeenCalled();
  });

  it('bare state with no viewport just closes the panel', () => {
    popstate(ev({}));
    expect(uiMock.closePanel).toHaveBeenCalled();
    expect(s.map.setView).not.toHaveBeenCalled();
  });

  it('falls back to urlState.parse() when the event carries no state', () => {
    urlStateMock.parse.mockReturnValue({});
    popstate({ state: null });
    expect(uiMock.closePanel).toHaveBeenCalled();
  });

  it('does not decrement _pushCount below zero', () => {
    urlStateMock._pushCount = 0;
    popstate(ev({}));
    expect(urlStateMock._pushCount).toBe(0);
  });
});

describe('offline / online window listeners (outside the guard)', () => {
  // These attach at module-eval time regardless of the flag, so the default
  // (flag-set) import already registered them.
  function trusted(type) {
    const e = new window.Event(type);
    Object.defineProperty(e, 'isTrusted', { value: true });
    return e;
  }

  it('a trusted offline event shows the offline error', () => {
    refreshMock.showError.mockClear();
    lastWin('offline')(trusted('offline'));
    expect(refreshMock.showError).toHaveBeenCalledTimes(1);
  });

  it('an untrusted offline event is ignored', () => {
    refreshMock.showError.mockClear();
    lastWin('offline')(new window.Event('offline')); // isTrusted === false
    expect(refreshMock.showError).not.toHaveBeenCalled();
  });

  it('a trusted online event kicks a refresh', () => {
    refreshMock.refresh.mockClear();
    lastWin('online')(trusted('online'));
    expect(refreshMock.refresh).toHaveBeenCalledTimes(1);
  });

  it('an untrusted online event is ignored', () => {
    refreshMock.refresh.mockClear();
    lastWin('online')(new window.Event('online'));
    expect(refreshMock.refresh).not.toHaveBeenCalled();
  });
});

describe('bootstrap guard TRUE arm — fresh no-flag import', () => {
  it("readyState 'complete' runs init() immediately during import", async () => {
    const { state: s, map } = await freshInit(Object.create(null), 'complete');
    expect(map.mapModule.init).toHaveBeenCalledTimes(1);
    expect(refreshMock.startStream).toHaveBeenCalledTimes(1);
    expect(s.map).toBeTruthy();
  });

  it("readyState 'loading' defers init() to DOMContentLoaded", async () => {
    const { state: s, map } = await freshInit(Object.create(null), 'loading');
    // Deferred: nothing built yet.
    expect(map.mapModule.init).not.toHaveBeenCalled();
    const dcl = lastDoc('DOMContentLoaded');
    expect(typeof dcl).toBe('function');
    dcl();
    expect(map.mapModule.init).toHaveBeenCalledTimes(1);
    expect(s.map).toBeTruthy();
  });
});
