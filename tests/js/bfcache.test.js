/**
 * Tests for the bf-cache page-lifecycle handling in static/refresh.js.
 *
 * The app becomes bf-cache eligible by closing the SSE EventSource on
 * pagehide (_suspendStream) and rebuilding it on a bf-restore
 * (_resumeStream / pageshow persisted). Suspend/resume also orchestrate the
 * geolocation watch + dot and the staleness clock. The terminal banner is
 * dismissed via the SSE 'open' branch after any reopen path.
 *
 * showLocation on/off gating of the geolocation watch is covered in
 * user-location-watch.test.js and is not re-asserted here (startLocationWatch
 * is a spy in this file).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Minimal Leaflet stub so the ui.js/map.js import graph loads under happy-dom.
globalThis.L = {
  latLng: (lat, lon) => ({ lat, lng: lon, distanceTo: () => 0 }),
};

const uiMock = {
  hideTerminalBanner: vi.fn(),
  showVersionUpdateBanner: vi.fn(),
  showTerminalBanner: vi.fn(),
  updateSseState: vi.fn(),
};
vi.mock('../../static/ui.js', () => ({ ui: uiMock }));
vi.mock('../../static/api.js', () => ({
  trackedFetch: (...a) => window.fetch(...a),
  api: {
    subscribeBoard: () => Promise.resolve({}),
    selectStream: vi.fn(() => Promise.resolve({})),
  },
}));
vi.mock('../../static/map.js', () => ({
  markers: { updateAll: vi.fn() },
  stopsLayer: { update: vi.fn() },
  startLocationWatch: vi.fn(),
  stopLocationWatch: vi.fn(),
  removeUserLocationMarker: vi.fn(),
}));

const { startStream, notifyViewportChange, _suspendStream, _resumeStream } =
  await import('../../static/refresh.js');
const { state, settings } = await import('../../static/state.js');
const mapMock = await import('../../static/map.js');

// EventSource stub: records each instance and its per-type listeners so a test
// can drive the 'subscribe' handler directly. readyState/onerror are settable.
const instances = [];
class ESStub {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.onerror = null;
    this.listeners = {};
    this.close = vi.fn();
    instances.push(this);
  }
  addEventListener(type, cb) {
    (this.listeners[type] = this.listeners[type] || []).push(cb);
  }
}

function setVisibility(v) {
  Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
}

function makeMap() {
  return {
    getCenter: () => ({ lat: 49.342, lng: 8.66, distanceTo: () => 0 }),
    getBounds: () => ({
      getSouthWest: () => ({ lat: 49.341, lng: 8.6588 }),
      getNorthEast: () => ({ lat: 49.343, lng: 8.6612 }),
    }),
  };
}

let _origES;

beforeEach(() => {
  _origES = globalThis.EventSource;
  globalThis.EventSource = ESStub;
  // Normalize module state: close any leftover _es from a prior test, then
  // clear the recorded-instances log so counts start fresh.
  _suspendStream();
  instances.length = 0;
  uiMock.hideTerminalBanner.mockClear();
  uiMock.showVersionUpdateBanner.mockClear();
  uiMock.showTerminalBanner.mockClear();
  uiMock.updateSseState.mockClear();
  mapMock.startLocationWatch.mockClear();
  mapMock.stopLocationWatch.mockClear();
  mapMock.removeUserLocationMarker.mockClear();
  state.map = null;
  state.lastUpdate = null;
  state.selectedJid = null;
  state.selectedStop = null;
  state._versionUpdateBannerShown = false;
  settings.current = { showLocation: true, posMode: 'CALC' };
});

afterEach(() => {
  globalThis.EventSource = _origES;
  vi.useRealTimers();
});

describe('_suspendStream', () => {
  it('with an active stream: closes it, nulls lastUpdate, stops the watch and removes the dot', () => {
    startStream();
    expect(instances.length).toBe(1);
    const es = instances[0];
    state.lastUpdate = Date.now();
    _suspendStream();
    expect(es.close).toHaveBeenCalledTimes(1);
    expect(state.lastUpdate).toBeNull();
    expect(mapMock.stopLocationWatch).toHaveBeenCalled();
    expect(mapMock.removeUserLocationMarker).toHaveBeenCalled();
  });

  it('with no active stream: no throw, no new instance, no close, lastUpdate nulled', () => {
    // beforeEach already suspended, so _es is null here.
    state.lastUpdate = Date.now();
    expect(() => _suspendStream()).not.toThrow();
    expect(instances.length).toBe(0);
    expect(state.lastUpdate).toBeNull();
  });

  it('does not set any error/terminal UI state', () => {
    startStream();
    _suspendStream();
    expect(uiMock.showTerminalBanner).not.toHaveBeenCalled();
  });
});

describe('_resumeStream', () => {
  it('re-arms the version banner, starts the stream and the location watch', () => {
    state._versionUpdateBannerShown = true;
    _resumeStream();
    expect(instances.length).toBe(1);
    expect(mapMock.startLocationWatch).toHaveBeenCalled();
    expect(state._versionUpdateBannerShown).toBe(false);
  });

  it('called twice closes the first stream and opens a second (startStream if(_es) branch)', () => {
    _resumeStream();
    expect(instances.length).toBe(1);
    const first = instances[0];
    _resumeStream();
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(instances.length).toBe(2);
  });
});

describe('pagehide / pageshow listeners', () => {
  it('pageshow persisted=true resumes (new instance)', () => {
    const e = new Event('pageshow');
    e.persisted = true;
    window.dispatchEvent(e);
    expect(instances.length).toBe(1);
  });

  it('pageshow persisted=false is a normal load → no resume', () => {
    const e = new Event('pageshow');
    e.persisted = false;
    window.dispatchEvent(e);
    expect(instances.length).toBe(0);
  });

  it('pageshow with persisted undefined (plain Event) → no resume', () => {
    window.dispatchEvent(new Event('pageshow'));
    expect(instances.length).toBe(0);
  });

  it('pagehide suspends: closes the stream and nulls lastUpdate', () => {
    startStream();
    const es = instances[0];
    state.lastUpdate = Date.now();
    window.dispatchEvent(new Event('pagehide'));
    expect(es.close).toHaveBeenCalledTimes(1);
    expect(state.lastUpdate).toBeNull();
  });
});

describe("_setSseState('open') via the subscribe handler dismisses the terminal banner", () => {
  it('invoking the captured subscribe listener funnels through open → ui.hideTerminalBanner', () => {
    startStream();
    const subscribeCb = instances[0].listeners.subscribe[0];
    expect(typeof subscribeCb).toBe('function');
    subscribeCb({ data: '{}' });
    expect(uiMock.hideTerminalBanner).toHaveBeenCalled();
  });
});

describe('visibilitychange resumes the location watch and reopens a dead stream', () => {
  it('reopens when the stream is CLOSED (readyState 2) and starts the watch', () => {
    state.map = makeMap();
    startStream();
    instances[0].readyState = 2;
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(instances.length).toBe(2);
    expect(mapMock.startLocationWatch).toHaveBeenCalled();
  });

  it('reopens when there is no stream at all (_es === null)', () => {
    state.map = makeMap();
    // beforeEach left _es null.
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(instances.length).toBe(1);
    expect(mapMock.startLocationWatch).toHaveBeenCalled();
  });

  it('healthy open stream (readyState 1, not stale): no reopen but watch still resumes', () => {
    state.map = makeMap();
    startStream();
    instances[0].readyState = 1;
    state.lastUpdate = Date.now();
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(instances.length).toBe(1);
    expect(mapMock.startLocationWatch).toHaveBeenCalled();
  });
});

describe('restore ordering — pageshow and visibilitychange interaction on a bf-restore', () => {
  it('order A: pageshow persisted first, then a trailing visibilitychange does NOT double-start', () => {
    state.map = makeMap();
    const e = new Event('pageshow');
    e.persisted = true;
    window.dispatchEvent(e);
    expect(instances.length).toBe(1);
    // The resumed stream is still connecting (readyState 0, not CLOSED) and
    // lastUpdate is null, so visibilitychange neither reopens nor force-reconnects.
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(instances.length).toBe(1);
  });

  it('order B: visibilitychange reopens first, then pageshow persisted replaces that stream', () => {
    state.map = makeMap();
    // No stream yet (suspended). visibilitychange sees _es === null → reopens.
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(instances.length).toBe(1);
    const first = instances[0];
    const e = new Event('pageshow');
    e.persisted = true;
    window.dispatchEvent(e);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(instances.length).toBe(2);
  });
});

describe('notifyViewportChange debounced callback', () => {
  let fetchSpy;
  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.fn(() => Promise.resolve({ status: 200 }));
    window.fetch = fetchSpy;
  });

  it('(a) no stream + visible page → startStream, no viewport POST', () => {
    state.map = makeMap();
    setVisibility('visible');
    notifyViewportChange();
    vi.advanceTimersByTime(250);
    expect(instances.length).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('(b) no stream + hidden page → neither reopen nor POST', () => {
    state.map = makeMap();
    setVisibility('hidden');
    notifyViewportChange();
    vi.advanceTimersByTime(250);
    expect(instances.length).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('(c) stream present but not OPEN (readyState !== 1) → no POST', () => {
    state.map = makeMap();
    startStream();
    instances[0].readyState = 0;
    notifyViewportChange();
    vi.advanceTimersByTime(250);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('(d) stream OPEN (readyState 1) → viewport POST fires', () => {
    state.map = makeMap();
    startStream();
    instances[0].readyState = 1;
    notifyViewportChange();
    vi.advanceTimersByTime(250);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toContain('/stream/viewport');
  });
});
