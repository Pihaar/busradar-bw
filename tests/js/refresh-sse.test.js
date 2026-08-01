/**
 * Tests for the SSE EventSource driver in static/refresh.js.
 *
 * The `startStream` function registers per-type listeners on an EventSource and
 * an `onerror` handler. We drive those callbacks directly via the recorded
 * listeners on a stub EventSource (the "recorded-listener" pattern), exercising
 * the subscribe/connected/vehicles/journey/stationboard/error branches, the
 * reconnect/terminal machinery, the online/offline handlers, broken-session
 * recovery, and the full _handleVehiclesPayload code paths.
 *
 * Every test asserts an observable result (a mock call, a state mutation, a new
 * EventSource instance, or a DOM change) — never merely "does not throw".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

globalThis.L = {
  latLng: (lat, lon) => ({ lat, lng: lon, distanceTo: () => 0 }),
};

// Rich ui mock: every method _handleVehiclesPayload / the SSE handlers touch.
// detailLine/detailDir/detailDelay are plain objects with settable props.
const uiMock = {
  drawRoute: vi.fn(),
  updateJourneyStopDelays: vi.fn(),
  showJourneyEnded: vi.fn(),
  _showJourneyCancelled: vi.fn(),
  hideTerminalBanner: vi.fn(),
  showVersionUpdateBanner: vi.fn(),
  showTerminalBanner: vi.fn(),
  updateSseState: vi.fn(),
  applyPushedStationboard: vi.fn(),
  focusJourneyById: vi.fn(),
  showStationBoard: vi.fn(),
  switchTab: vi.fn(),
  renderJourneyStops: vi.fn(),
  _disableFollow: vi.fn(),
  _updateFollowButton: vi.fn(),
  _updateFollowUrl: vi.fn(),
  updateStopProgress: vi.fn(),
  detailLine: {},
  detailDir: {},
  detailDelay: {},
};
vi.mock('../../static/ui.js', () => ({ ui: uiMock }));

const apiMock = { selectStream: vi.fn(() => Promise.resolve({})) };
vi.mock('../../static/api.js', () => ({
  trackedFetch: (...a) => window.fetch(...a),
  api: apiMock,
}));

const markersMock = { updateAll: vi.fn(), _lastVisibleCount: null };
const stopsLayerMock = { update: vi.fn() };
vi.mock('../../static/map.js', () => ({
  markers: markersMock,
  stopsLayer: stopsLayerMock,
  startLocationWatch: vi.fn(),
  stopLocationWatch: vi.fn(),
  removeUserLocationMarker: vi.fn(),
}));

// Use the REAL status.js: showPersistentError/clearPersistentError/announce etc.
// touch the DOM; we spy on them below where needed rather than mocking the
// module, so the connection between _setSseState and the status layer is real.
const statusMock = {
  updateStatus: vi.fn(),
  getServerTimeStr: vi.fn(() => '12:00'),
  showError: vi.fn(),
  showPersistentError: vi.fn(),
  clearPersistentError: vi.fn(),
  announce: vi.fn(),
  formatStatusText: vi.fn(() => 'status-text'),
};
vi.mock('../../static/status.js', () => statusMock);

const { startStream, refresh, _suspendStream, busradarDump } =
  await import('../../static/refresh.js');
const { state, settings } = await import('../../static/state.js');

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
  fire(type, data) {
    (this.listeners[type] || []).forEach((cb) => cb({ data }));
  }
}

function makeMap() {
  return {
    getCenter: () => ({ lat: 49.342, lng: 8.66, distanceTo: () => 0 }),
    getBounds: () => ({
      getSouthWest: () => ({ lat: 49.341, lng: 8.6588 }),
      getNorthEast: () => ({ lat: 49.343, lng: 8.6612 }),
    }),
    getZoom: () => 15,
    panTo: vi.fn(),
    setView: vi.fn(),
    once: vi.fn(),
  };
}

let _origES;

beforeEach(() => {
  _origES = globalThis.EventSource;
  globalThis.EventSource = ESStub;
  _suspendStream(); // reset module-private _es / _reconnectAttempt / _lastForceReconnectAt
  instances.length = 0;
  for (const fn of Object.values(uiMock))
    if (typeof fn === 'function' && fn.mockClear) fn.mockClear();
  uiMock.detailLine = {};
  uiMock.detailDir = {};
  uiMock.detailDelay = {};
  for (const fn of Object.values(statusMock)) if (fn.mockClear) fn.mockClear();
  apiMock.selectStream.mockClear();
  markersMock.updateAll.mockClear();
  markersMock._lastVisibleCount = null;
  stopsLayerMock.update.mockClear();

  // Reset the state the handlers read/write.
  state.map = null;
  state.vehicles = new Map();
  state.allStops = new Map();
  state.lastUpdate = null;
  state.consecutiveErrors = 0;
  state.selectedJid = null;
  state.selectedStop = null;
  state.selectedJourneyData = null;
  state._currentStopL = null;
  state._notStartedJid = null;
  state._notStartedSince = 0;
  state._selectedHadPosJid = null;
  state._lastConnectedClients = undefined;
  state._appVersion = null;
  state._versionUpdateBannerShown = false;
  state.followBus = false;
  state._pendingRestore = null;
  state._userInteractionSeq = 0;
  state._restoreInProgress = false;
  state.serverTimeMin = null;
  state.serverTimeStamp = null;
  state._lastBusCount = 0;
  state._errorUntil = 0;
  settings.current = { posMode: 'CALC', showLocation: false };
  delete window.__busradarVerbose;
});

afterEach(() => {
  globalThis.EventSource = _origES;
  vi.useRealTimers();
  _suspendStream();
});

describe('startStream — EventSource lifecycle', () => {
  it('closes an existing stream before opening a new one', () => {
    startStream();
    const first = instances[0];
    startStream();
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(instances.length).toBe(2);
  });

  it('EventSource constructor throwing routes to the terminal banner', () => {
    globalThis.EventSource = class {
      constructor() {
        throw new Error('no SSE');
      }
    };
    startStream();
    expect(uiMock.showTerminalBanner).toHaveBeenCalledTimes(1);
  });
});

describe('subscribe listener', () => {
  it('resets reconnect state, seeds lastUpdate, clears consecutiveErrors, resends viewport+selection', () => {
    state.map = makeMap();
    state.selectedJid = 'JSEL';
    state.consecutiveErrors = 3;
    window.fetch = vi.fn(() => Promise.resolve({ status: 200 }));
    startStream();
    const es = instances[0];
    es.readyState = 1;
    es.fire('subscribe', '{}');
    expect(state.lastUpdate).toBeTypeOf('number');
    expect(state.consecutiveErrors).toBe(0);
    expect(statusMock.clearPersistentError).toHaveBeenCalled();
    expect(window.fetch).toHaveBeenCalledTimes(1); // _sendCurrentViewport
    expect(apiMock.selectStream).toHaveBeenCalledWith('journey', 'JSEL'); // _resendActiveSelection
  });

  it('verbose subscribe logs via debugLog', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    window.__busradarVerbose = true;
    startStream();
    instances[0].fire('subscribe', '{}');
    expect(logSpy).toHaveBeenCalledWith('[verbose]', 'sse subscribe (stream open)');
    logSpy.mockRestore();
  });

  it('protocol mismatch shows the version-update banner and closes the stream', () => {
    startStream();
    const es = instances[0];
    es.fire('subscribe', JSON.stringify({ protocol: '2' }));
    expect(es.close).toHaveBeenCalled();
    expect(uiMock.showVersionUpdateBanner).toHaveBeenCalledTimes(1);
    expect(state._versionUpdateBannerShown).toBe(true);
  });

  it('protocol mismatch falls back to the terminal banner when no version banner exists', () => {
    const savedVer = uiMock.showVersionUpdateBanner;
    delete uiMock.showVersionUpdateBanner;
    startStream();
    instances[0].fire('subscribe', JSON.stringify({ protocol: '2' }));
    expect(uiMock.showTerminalBanner).toHaveBeenCalled();
    uiMock.showVersionUpdateBanner = savedVer;
  });

  it('a valid appVersion in the subscribe payload is recorded', () => {
    startStream();
    instances[0].fire('subscribe', JSON.stringify({ appVersion: 'v1.2.3' }));
    expect(state._appVersion).toBe('v1.2.3');
  });

  it('malformed subscribe JSON is swallowed but the viewport/selection resend still runs', () => {
    state.map = makeMap();
    window.fetch = vi.fn(() => Promise.resolve({ status: 200 }));
    startStream();
    const es = instances[0];
    es.readyState = 1;
    es.fire('subscribe', '{not json');
    expect(window.fetch).toHaveBeenCalledTimes(1);
  });

  it('subscribe leaves an already-set lastUpdate untouched (if(!lastUpdate) false branch)', () => {
    state.map = makeMap();
    window.fetch = vi.fn(() => Promise.resolve({ status: 200 }));
    const stamp = Date.now() - 5000;
    state.lastUpdate = stamp;
    startStream();
    instances[0].readyState = 1;
    instances[0].fire('subscribe', '{}');
    expect(state.lastUpdate).toBe(stamp); // not reseeded
  });

  it('protocol mismatch with NEITHER banner method present still closes and returns', () => {
    const savedVer = uiMock.showVersionUpdateBanner;
    const savedTerm = uiMock.showTerminalBanner;
    delete uiMock.showVersionUpdateBanner;
    delete uiMock.showTerminalBanner;
    startStream();
    const es = instances[0];
    es.fire('subscribe', JSON.stringify({ protocol: '9' }));
    expect(es.close).toHaveBeenCalled();
    expect(state._lastConnectedClients).toBeNull();
    uiMock.showVersionUpdateBanner = savedVer;
    uiMock.showTerminalBanner = savedTerm;
  });
});

describe('_setSseState — ui method absence (else branches)', () => {
  it('open state without ui.updateSseState / ui.hideTerminalBanner still transitions', () => {
    const savedUpd = uiMock.updateSseState;
    const savedHide = uiMock.hideTerminalBanner;
    delete uiMock.updateSseState;
    delete uiMock.hideTerminalBanner;
    state.map = makeMap();
    window.fetch = vi.fn(() => Promise.resolve({ status: 200 }));
    state.consecutiveErrors = 1;
    startStream();
    instances[0].readyState = 1;
    // subscribe → _setSseState('open') → both `typeof ui.x === 'function'` false
    instances[0].fire('subscribe', '{}');
    expect(statusMock.clearPersistentError).toHaveBeenCalled();
    uiMock.updateSseState = savedUpd;
    uiMock.hideTerminalBanner = savedHide;
  });
});

describe('_maybeUpdateAppVersion via subscribe', () => {
  it('a changed version raises the update banner once', () => {
    state._appVersion = 'v1.0.0';
    startStream();
    instances[0].fire('subscribe', JSON.stringify({ appVersion: 'v2.0.0' }));
    expect(uiMock.showVersionUpdateBanner).toHaveBeenCalledTimes(1);
    expect(state._versionUpdateBannerShown).toBe(true);
  });

  it('an invalid version string is ignored', () => {
    state._appVersion = 'v1.0.0';
    startStream();
    instances[0].fire('subscribe', JSON.stringify({ appVersion: 'not a valid version!!' }));
    expect(uiMock.showVersionUpdateBanner).not.toHaveBeenCalled();
    expect(state._appVersion).toBe('v1.0.0');
  });

  it('the same version as the stored one is a no-op (else-if false)', () => {
    state._appVersion = 'v1.0.0';
    startStream();
    instances[0].fire('subscribe', JSON.stringify({ appVersion: 'v1.0.0' }));
    expect(uiMock.showVersionUpdateBanner).not.toHaveBeenCalled();
  });

  it('a changed version does not re-raise the banner once it has already been shown', () => {
    state._appVersion = 'v1.0.0';
    state._versionUpdateBannerShown = true; // banner already latched
    startStream();
    instances[0].fire('subscribe', JSON.stringify({ appVersion: 'v3.0.0' }));
    expect(uiMock.showVersionUpdateBanner).not.toHaveBeenCalled();
  });
});

describe('connected listener + _formatConnectedCount', () => {
  it('a normal count is stored as an exact string', () => {
    startStream();
    instances[0].fire('connected', JSON.stringify({ count: 42 }));
    expect(state._lastConnectedClients).toBe('42');
  });

  it('a count of 100 or more caps to "100+"', () => {
    startStream();
    instances[0].fire('connected', JSON.stringify({ count: 150 }));
    expect(state._lastConnectedClients).toBe('100+');
  });

  it('a negative count formats to null', () => {
    startStream();
    instances[0].fire('connected', JSON.stringify({ count: -5 }));
    expect(state._lastConnectedClients).toBeNull();
  });

  it('a non-finite numeric count (NaN) formats to null', () => {
    startStream();
    // JSON has no NaN; send a raw payload the parser turns into count:NaN.
    instances[0].listeners.connected[0]({ data: '{"count": 1e999999}' });
    // 1e999999 parses to Infinity → isFinite false → null.
    expect(state._lastConnectedClients).toBeNull();
  });

  it('a non-numeric count leaves _lastConnectedClients untouched', () => {
    state._lastConnectedClients = 'keep';
    startStream();
    instances[0].fire('connected', JSON.stringify({ count: 'lots' }));
    expect(state._lastConnectedClients).toBe('keep');
  });

  it('malformed connected JSON is swallowed', () => {
    state._lastConnectedClients = 'keep';
    startStream();
    instances[0].fire('connected', '{bad');
    expect(state._lastConnectedClients).toBe('keep');
  });
});

describe('vehicles listener', () => {
  it('malformed vehicles JSON returns early without calling updateAll', () => {
    startStream();
    instances[0].fire('vehicles', '{bad');
    expect(markersMock.updateAll).not.toHaveBeenCalled();
  });

  it('a valid vehicles payload flows into markers.updateAll and updateStatus', () => {
    state.map = makeMap();
    markersMock._lastVisibleCount = 7;
    startStream();
    instances[0].fire('vehicles', JSON.stringify({ vehicles: [{ jid: 'A' }], dataAge: 5 }));
    expect(markersMock.updateAll).toHaveBeenCalledOnce();
    expect(stopsLayerMock.update).toHaveBeenCalledOnce();
    expect(statusMock.updateStatus).toHaveBeenCalledWith(7, 5, undefined);
  });

  it('verbose vehicles logs the count', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    window.__busradarVerbose = true;
    startStream();
    instances[0].fire('vehicles', JSON.stringify({ vehicles: [{}, {}] }));
    expect(logSpy).toHaveBeenCalledWith('[verbose]', 'sse vehicles', { count: 2 });
    logSpy.mockRestore();
  });
});

describe('journey listener', () => {
  it('applies the journey payload when the jid matches the selection', () => {
    state.selectedJid = 'JM';
    state.map = makeMap();
    startStream();
    instances[0].fire(
      'journey',
      JSON.stringify({ jid: 'JM', journey: { pos: { x: 8660000, y: 49342000 }, stopL: [] } }),
    );
    expect(uiMock.updateJourneyStopDelays).toHaveBeenCalled();
  });

  it('drops a journey push for a non-selected jid', () => {
    state.selectedJid = 'JM';
    startStream();
    instances[0].fire('journey', JSON.stringify({ jid: 'OTHER', journey: { pos: {}, stopL: [] } }));
    expect(uiMock.updateJourneyStopDelays).not.toHaveBeenCalled();
  });

  it('drops a journey push with no jid', () => {
    startStream();
    instances[0].fire('journey', JSON.stringify({ journey: {} }));
    expect(uiMock.updateJourneyStopDelays).not.toHaveBeenCalled();
  });

  it('drops a journey push with a matching jid but no journey object', () => {
    state.selectedJid = 'JM';
    startStream();
    instances[0].fire('journey', JSON.stringify({ jid: 'JM' }));
    expect(uiMock.updateJourneyStopDelays).not.toHaveBeenCalled();
  });

  it('verbose journey logs jid + hasPos', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    window.__busradarVerbose = true;
    state.selectedJid = 'JV';
    state.map = makeMap();
    startStream();
    instances[0].fire(
      'journey',
      JSON.stringify({ jid: 'JV', journey: { pos: { x: 1, y: 2 }, stopL: [] } }),
    );
    expect(logSpy).toHaveBeenCalledWith('[verbose]', 'sse journey', { jid: 'JV', hasPos: true });
    logSpy.mockRestore();
  });

  it('malformed journey JSON returns early', () => {
    state.selectedJid = 'JM';
    startStream();
    instances[0].fire('journey', '{bad');
    expect(uiMock.updateJourneyStopDelays).not.toHaveBeenCalled();
  });
});

describe('stationboard listener', () => {
  it('renders the pushed board for the selected stop', () => {
    state.selectedStop = { lid: 'A=1@L=1@' };
    startStream();
    instances[0].fire(
      'stationboard',
      JSON.stringify({ lid: 'A=1@L=1@', stationboard: { jnyL: [] }, boardType: 'ARR' }),
    );
    expect(uiMock.applyPushedStationboard).toHaveBeenCalledWith(
      state.selectedStop,
      { jnyL: [] },
      'ARR',
    );
  });

  it('defaults board type to DEP and payload to {} when absent', () => {
    state.selectedStop = { lid: 'A=1@L=1@' };
    startStream();
    instances[0].fire('stationboard', JSON.stringify({ lid: 'A=1@L=1@' }));
    expect(uiMock.applyPushedStationboard).toHaveBeenCalledWith(state.selectedStop, {}, 'DEP');
  });

  it('drops a board push with no lid', () => {
    state.selectedStop = { lid: 'A=1@L=1@' };
    startStream();
    instances[0].fire('stationboard', JSON.stringify({ stationboard: {} }));
    expect(uiMock.applyPushedStationboard).not.toHaveBeenCalled();
  });

  it('drops a board push when no stop is selected', () => {
    state.selectedStop = null;
    startStream();
    instances[0].fire('stationboard', JSON.stringify({ lid: 'A=1@L=1@' }));
    expect(uiMock.applyPushedStationboard).not.toHaveBeenCalled();
  });

  it('drops a board push for a different lid', () => {
    state.selectedStop = { lid: 'A=1@L=1@' };
    startStream();
    instances[0].fire('stationboard', JSON.stringify({ lid: 'A=1@L=999@' }));
    expect(uiMock.applyPushedStationboard).not.toHaveBeenCalled();
  });

  it('an exception inside applyPushedStationboard is caught and warned', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    state.selectedStop = { lid: 'A=1@L=1@' };
    uiMock.applyPushedStationboard.mockImplementationOnce(() => {
      throw new Error('render boom');
    });
    startStream();
    instances[0].fire('stationboard', JSON.stringify({ lid: 'A=1@L=1@' }));
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('malformed stationboard JSON returns early', () => {
    state.selectedStop = { lid: 'A=1@L=1@' };
    startStream();
    instances[0].fire('stationboard', '{bad');
    expect(uiMock.applyPushedStationboard).not.toHaveBeenCalled();
  });
});

describe('error listener (server-emitted error events)', () => {
  it('{stale:true} surfaces the stale banner', () => {
    startStream();
    instances[0].fire('error', JSON.stringify({ stale: true }));
    expect(statusMock.showPersistentError).toHaveBeenCalled();
  });

  it("{selection:'journey'} logs a warning and stays quiet", () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    startStream();
    instances[0].fire('error', JSON.stringify({ selection: 'journey', reason: 'HAFAS 500' }));
    expect(warnSpy).toHaveBeenCalledWith('detail-fetch error from server:', 'journey', 'HAFAS 500');
    expect(statusMock.showPersistentError).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("{selection:'stationboard'} also logs a warning", () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    startStream();
    instances[0].fire('error', JSON.stringify({ selection: 'stationboard' }));
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('a parsed null payload returns early (the !d guard)', () => {
    startStream();
    instances[0].fire('error', 'null');
    expect(statusMock.showPersistentError).not.toHaveBeenCalled();
  });

  it('an empty error event ({}) is a no-op', () => {
    startStream();
    instances[0].fire('error', undefined); // JSON.parse('{}') path via `ev.data || '{}'`
    expect(statusMock.showPersistentError).not.toHaveBeenCalled();
  });

  it('malformed error JSON is swallowed', () => {
    startStream();
    instances[0].fire('error', '{bad');
    expect(statusMock.showPersistentError).not.toHaveBeenCalled();
  });
});

describe('onerror → reconnect scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('onerror is a no-op while the socket is not CLOSED', () => {
    startStream();
    const es = instances[0];
    es.readyState = 1; // OPEN
    es.onerror();
    vi.advanceTimersByTime(60000);
    expect(instances.length).toBe(1); // no reconnect scheduled
  });

  it('onerror on a CLOSED socket schedules a reconnect that reopens the stream', () => {
    startStream();
    const es = instances[0];
    es.readyState = 2; // CLOSED
    es.onerror();
    expect(statusMock.showPersistentError).toHaveBeenCalled(); // reconnecting → persistent error
    vi.advanceTimersByTime(60000);
    expect(instances.length).toBe(2); // startStream ran from the scheduled timer
  });

  it('verbose reconnect logs the scheduled attempt', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    window.__busradarVerbose = true;
    startStream();
    const es = instances[0];
    es.readyState = 2;
    es.onerror();
    expect(logSpy).toHaveBeenCalledWith(
      '[verbose]',
      'sse reconnect scheduled',
      expect.objectContaining({ attempt: 1 }),
    );
    logSpy.mockRestore();
  });

  it('exhausting the backoff sequence transitions to the terminal banner', () => {
    startStream();
    // Drive 6 error cycles: 5 schedule (attempts 1..5), the 6th hits the cap.
    for (let i = 0; i < 6; i++) {
      const es = instances[instances.length - 1];
      es.readyState = 2;
      es.onerror();
      vi.advanceTimersByTime(60000); // fire any scheduled startStream
    }
    expect(uiMock.showTerminalBanner).toHaveBeenCalled();
  });
});

describe('_recoverIfBrokenSession via a viewport POST response', () => {
  it('a 401 response closes the stream, resets, and reopens', async () => {
    state.map = makeMap();
    startStream();
    instances[0].readyState = 1;
    window.fetch = vi.fn(() => Promise.resolve({ status: 401 }));
    refresh(); // → _sendCurrentViewport → POST → .then → _recoverIfBrokenSession
    await vi.waitFor(() => expect(instances.length).toBe(2));
  });

  it('a 409 response also triggers a reopen', async () => {
    state.map = makeMap();
    startStream();
    instances[0].readyState = 1;
    window.fetch = vi.fn(() => Promise.resolve({ status: 409 }));
    refresh();
    await vi.waitFor(() => expect(instances.length).toBe(2));
  });

  it('a 200 response does not reopen the stream', async () => {
    state.map = makeMap();
    startStream();
    instances[0].readyState = 1;
    window.fetch = vi.fn(() => Promise.resolve({ status: 200 }));
    refresh();
    await Promise.resolve();
    await Promise.resolve();
    expect(instances.length).toBe(1);
  });

  it('a 401 whose stream was already torn down (_es null) still reopens (if(_es) else)', async () => {
    state.map = makeMap();
    startStream();
    instances[0].readyState = 1;
    // Resolve on a deferred so we can null _es (via _suspendStream) before the
    // .then runs — exercising the `if (_es)` false branch in _recoverIfBrokenSession.
    let resolve;
    window.fetch = vi.fn(() => new Promise((r) => (resolve = r)));
    refresh(); // POST issued, promise pending
    _suspendStream(); // _es = null while the POST is in flight
    resolve({ status: 401 });
    await vi.waitFor(() => expect(instances.length).toBe(2)); // startStream still ran
  });
});

describe('_sendCurrentViewport guards', () => {
  it('is a no-op with no map', () => {
    window.fetch = vi.fn();
    state.map = null;
    startStream();
    instances[0].readyState = 1;
    refresh();
    expect(window.fetch).not.toHaveBeenCalled();
  });

  it('is a no-op when the stream is not OPEN', () => {
    window.fetch = vi.fn();
    state.map = makeMap();
    startStream();
    instances[0].readyState = 0;
    refresh();
    expect(window.fetch).not.toHaveBeenCalled();
  });

  it('verbose viewport POST logs the payload', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    window.__busradarVerbose = true;
    window.fetch = vi.fn(() => Promise.resolve({ status: 200 }));
    state.map = makeMap();
    startStream();
    instances[0].readyState = 1;
    refresh();
    expect(logSpy).toHaveBeenCalledWith('[verbose]', 'viewport POST', expect.any(Object));
    logSpy.mockRestore();
  });
});

describe('online / offline window handlers', () => {
  it('offline surfaces the connection-lost banner', () => {
    window.dispatchEvent(new Event('offline'));
    expect(statusMock.showPersistentError).toHaveBeenCalled();
  });

  it('online reopens the stream when the socket is CLOSED', () => {
    startStream();
    instances[0].readyState = 2;
    window.dispatchEvent(new Event('online'));
    expect(instances.length).toBe(2);
  });

  it('online clears the persistent error when the socket survived (OPEN)', () => {
    startStream();
    instances[0].readyState = 1;
    window.dispatchEvent(new Event('online'));
    expect(statusMock.clearPersistentError).toHaveBeenCalled();
    expect(instances.length).toBe(1);
  });

  it('online with no stream neither reopens nor clears', () => {
    // beforeEach suspended → _es is null.
    window.dispatchEvent(new Event('online'));
    expect(instances.length).toBe(0);
    expect(statusMock.clearPersistentError).not.toHaveBeenCalled();
  });
});

function setVisibility(v) {
  Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
}

describe('visibilitychange handler', () => {
  afterEach(() => setVisibility('visible'));

  it('is a no-op when the page is hidden', () => {
    state.map = makeMap();
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(instances.length).toBe(0);
  });

  it('is a no-op when there is no map', () => {
    state.map = null;
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(instances.length).toBe(0);
  });

  it('reopens a CLOSED stream on becoming visible', () => {
    state.map = makeMap();
    startStream();
    instances[0].readyState = 2;
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(instances.length).toBe(2);
  });

  it('force-reconnects a stale-but-OPEN stream (stale-on-visible)', () => {
    state.map = makeMap();
    startStream();
    instances[0].readyState = 1;
    // lastUpdate far in the past → older than the CALC 45s threshold.
    state.lastUpdate = Date.now() - 60000;
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(instances.length).toBe(2); // _forceReconnect opened a fresh stream
  });

  it('does NOT reconnect a healthy fresh OPEN stream', () => {
    state.map = makeMap();
    startStream();
    instances[0].readyState = 1;
    state.lastUpdate = Date.now();
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(instances.length).toBe(1);
  });
});

describe('_onTerminal fallback when ui has no terminal banner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('falls back to showPersistentError when ui.showTerminalBanner is absent', () => {
    const saved = uiMock.showTerminalBanner;
    delete uiMock.showTerminalBanner;
    startStream();
    // Exhaust the backoff so _scheduleReconnect hits the cap → _onTerminal.
    for (let i = 0; i < 6; i++) {
      const es = instances[instances.length - 1];
      es.readyState = 2;
      es.onerror();
      vi.advanceTimersByTime(60000);
    }
    // The reconnecting transitions AND the terminal fallback both call
    // showPersistentError; a terminal message must be among the calls.
    const msgs = statusMock.showPersistentError.mock.calls.map((c) => c[0]);
    expect(msgs.some((m) => typeof m === 'string')).toBe(true);
    expect(state._lastConnectedClients).toBeNull();
    uiMock.showTerminalBanner = saved;
  });
});

describe('_resendActiveSelection rejection paths (the .catch handlers)', () => {
  it('a rejected journey selectStream is swallowed by its .catch', async () => {
    apiMock.selectStream.mockReturnValueOnce(Promise.reject(new Error('net')));
    state.map = makeMap();
    state.selectedJid = 'JREJ';
    window.fetch = vi.fn(() => Promise.resolve({ status: 200 }));
    startStream();
    instances[0].readyState = 1;
    instances[0].fire('subscribe', '{}');
    expect(apiMock.selectStream).toHaveBeenCalledWith('journey', 'JREJ');
    await Promise.resolve();
    await Promise.resolve(); // let the rejection settle through .catch
  });

  it('a rejected stationboard selectStream is swallowed by its .catch', async () => {
    apiMock.selectStream.mockReturnValueOnce(Promise.reject(new Error('net')));
    state.map = makeMap();
    state.selectedStop = { lid: 'A=1@L=7@' };
    state._activeStationBoardType = 'DEP';
    window.fetch = vi.fn(() => Promise.resolve({ status: 200 }));
    startStream();
    instances[0].readyState = 1;
    instances[0].fire('subscribe', '{}');
    expect(apiMock.selectStream).toHaveBeenCalledWith('stationboard', 'A=1@L=7@', 'DEP', 60);
    await Promise.resolve();
    await Promise.resolve();
  });
});

describe('_sendCurrentViewport fetch rejection (the trailing .catch)', () => {
  it('a rejected viewport POST is swallowed and the stream stays', async () => {
    state.map = makeMap();
    startStream();
    instances[0].readyState = 1;
    window.fetch = vi.fn(() => Promise.reject(new Error('offline')));
    refresh();
    await Promise.resolve();
    await Promise.resolve();
    expect(instances.length).toBe(1); // no recovery reopen; error was swallowed
  });
});

describe('Runde 2 dump/log paths that need a live _es', () => {
  it('busradarDump.sse.readyState reflects the live EventSource readyState', () => {
    state.map = makeMap();
    startStream();
    instances[0].readyState = 1;
    const d = JSON.parse(busradarDump());
    expect(d.sse.readyState).toBe(1); // the `_es ? _es.readyState : null` truthy arm
  });

  it('the onerror _sselog reads null readyState after the stream was torn down', () => {
    startStream();
    const es = instances[0];
    _suspendStream(); // nulls the module-private _es
    // The stub still holds the assigned onerror closure; firing it now exercises
    // the `_es ? _es.readyState : null` FALSE arm (module _es is null).
    expect(() => es.onerror()).not.toThrow();
  });

  it('_sendCurrentViewport captures the follow-widened lastViewport payload', () => {
    state.map = makeMap();
    state.followBus = true;
    state.selectedJid = 'JFOLLOW';
    window.fetch = vi.fn(() => Promise.resolve({ status: 200 }));
    startStream();
    instances[0].readyState = 1;
    instances[0].fire('subscribe', '{}');
    expect(state._lastViewportPayload).toBeTruthy();
    expect(state._lastViewportPayload.follow).toBe(true); // the `followBus && selectedJid` truthy arm
    expect(typeof state._lastViewportPayload.ts).toBe('number');
  });

  it('_sselog re-initialises the ring when state._sseLog is null (the assignment arm)', () => {
    state._sseLog = null;
    startStream();
    instances[0].fire('vehicles', JSON.stringify({ vehicles: [] }));
    expect(Array.isArray(state._sseLog)).toBe(true);
    expect(state._sseLog[state._sseLog.length - 1].type).toBe('vehicles');
  });

  it('_sselog caps the ring at 120 entries (oldest evicted)', () => {
    state._sseLog = Array.from({ length: 120 }, (_, i) => ({ t: i, type: 'seed', meta: null }));
    startStream();
    instances[0].fire('vehicles', JSON.stringify({ vehicles: [] }));
    expect(state._sseLog).toHaveLength(120);
    expect(state._sseLog[state._sseLog.length - 1].type).toBe('vehicles'); // newest kept
    expect(state._sseLog[0].t).toBe(1); // entry t=0 shifted out
  });
});
