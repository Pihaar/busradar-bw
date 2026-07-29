/**
 * Tests for the SSE event helpers in static/refresh.js + ui.js.
 *
 * Covers the three branches of _applyJourneyPayload (has-pos, journey-ended,
 * not-started) and applyPushedStationboard (de-dup, lid mismatch, DEP/ARR
 * dispatch, auto-expand guard).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub leaflet globals before any module that imports map.js sees them.
globalThis.L = {
  latLng: (lat, lon) => ({ lat, lng: lon, distanceTo: () => 0 }),
};

// Mock the ui module so we can spy on the render methods that
// _applyJourneyPayload calls into. Module-level mock so the import-graph
// resolves before refresh.js loads.
const uiMock = {
  drawRoute: vi.fn(),
  updateJourneyStopDelays: vi.fn(),
  showJourneyEnded: vi.fn(),
  _showJourneyCancelled: vi.fn(),
};
vi.mock('../../static/ui.js', () => ({ ui: uiMock }));
vi.mock('../../static/api.js', () => ({
  api: { selectStream: vi.fn(() => Promise.resolve({})) },
}));
vi.mock('../../static/map.js', () => ({
  markers: { updateAll: vi.fn() },
  stopsLayer: { update: vi.fn() },
}));
vi.mock('../../static/status.js', () => ({
  updateStatus: vi.fn(),
  getServerTimeStr: vi.fn(() => '12:00'),
  showError: vi.fn(),
  showPersistentError: vi.fn(),
  clearPersistentError: vi.fn(),
  announce: vi.fn(),
  formatStatusText: vi.fn(() => 'status'),
}));

const { _applyJourneyPayload, _resendActiveSelection, _followPanTo, _viewportPayload, busradarDump, busradarDownloadDump } = await import('../../static/refresh.js');
const { state, settings, debugLog } = await import('../../static/state.js');
const { api } = await import('../../static/api.js');

describe('_applyJourneyPayload — journey SSE event helper', () => {
  beforeEach(() => {
    uiMock.drawRoute.mockClear();
    uiMock.updateJourneyStopDelays.mockClear();
    uiMock.showJourneyEnded.mockClear();
    uiMock._showJourneyCancelled.mockClear();
    state.selectedJourneyData = null;
    state._currentStopL = null;
    state._notStartedJid = null;
    state._notStartedSince = 0;
    state._selectedHadPosJid = null;
    state.vehicles = new Map();
    state.serverTimeStamp = Date.now();
    state.serverTimeMin = 720;  // 12:00
  });

  it('branch 1: position present + vehicle in BBox → drawRoute + updateJourneyStopDelays', () => {
    const sv = {
      data: { lat: 0, lon: 0, jid: 'J1' },
      marker: { setLatLng: vi.fn() },
      missedCycles: 2,
    };
    state.vehicles.set('J1', sv);
    const payload = {
      journey: { pos: { x: 8660000, y: 49342000 }, stopL: [{ name: 'A' }] },
    };
    _applyJourneyPayload('J1', payload);
    expect(uiMock.drawRoute).toHaveBeenCalledOnce();
    expect(uiMock.updateJourneyStopDelays).toHaveBeenCalledOnce();
    expect(uiMock.showJourneyEnded).not.toHaveBeenCalled();
    expect(sv.missedCycles).toBe(0);
    expect(sv.marker.setLatLng).toHaveBeenCalledWith([49.342, 8.66]);
  });

  it('branch 1b: position present but vehicle not in BBox → only updateJourneyStopDelays', () => {
    const payload = {
      journey: { pos: { x: 8660000, y: 49342000 }, stopL: [] },
    };
    _applyJourneyPayload('J-not-in-bbox', payload);
    expect(uiMock.updateJourneyStopDelays).toHaveBeenCalledOnce();
    expect(uiMock.drawRoute).not.toHaveBeenCalled();
  });

  it('branch 2: no pos + last-stop time well in the past → showJourneyEnded', () => {
    const payload = {
      journey: { pos: {}, stopL: [{ aTimeS: '060000' }] },
    };
    _applyJourneyPayload('J2', payload);
    expect(uiMock.showJourneyEnded).toHaveBeenCalledOnce();
    expect(uiMock.drawRoute).not.toHaveBeenCalled();
  });

  it('branch 2b: no pos + isCncl flag → _showJourneyCancelled', () => {
    const payload = {
      journey: { pos: {}, stopL: [], isCncl: true },
    };
    _applyJourneyPayload('J3', payload);
    expect(uiMock._showJourneyCancelled).toHaveBeenCalledOnce();
    expect(uiMock.showJourneyEnded).not.toHaveBeenCalled();
  });

  it('branch 3: no pos + last stop still in future → set _notStartedJid', () => {
    const payload = {
      journey: { pos: {}, stopL: [{ aTimeS: '140000' }] },
    };
    expect(state._notStartedJid).toBeNull();
    _applyJourneyPayload('J4', payload);
    expect(state._notStartedJid).toBe('J4');
    expect(state._notStartedSince).toBeGreaterThan(0);
    expect(uiMock.showJourneyEnded).not.toHaveBeenCalled();
    expect(uiMock.updateJourneyStopDelays).toHaveBeenCalled();
  });

  it('stores selectedJourneyData and _currentStopL on every call', () => {
    const payload = {
      journey: { pos: {}, stopL: [{ name: 'STOP-A' }, { name: 'STOP-B' }] },
    };
    _applyJourneyPayload('J5', payload);
    expect(state.selectedJourneyData).toBe(payload);
    expect(state._currentStopL).toEqual([{ name: 'STOP-A' }, { name: 'STOP-B' }]);
  });

  it('live journey that loses its position with a PAST last stop → ended immediately, NOT not-started', () => {
    // Live first (now 12:00; last stop 11:00 is already past).
    _applyJourneyPayload('JL', { journey: { pos: { x: 8660000, y: 49342000 }, stopL: [{ aTimeS: '110000' }] } });
    expect(state._selectedHadPosJid).toBe('JL');
    _applyJourneyPayload('JL', { journey: { pos: {}, stopL: [{ aTimeS: '110000' }] } });
    expect(uiMock.showJourneyEnded).toHaveBeenCalledOnce();
    expect(state._notStartedJid).toBeNull();
  });

  it('live journey losing position with a FUTURE last stop keeps the panel (mid-route gap / near terminus): NOT ended, NOT not-started', () => {
    _applyJourneyPayload('JL', { journey: { pos: { x: 8660000, y: 49342000 }, stopL: [{ aTimeS: '140000' }] } });
    // now 12:00, last stop 14:00 in the future → still en route, no live pos.
    _applyJourneyPayload('JL', { journey: { pos: {}, stopL: [{ aTimeS: '140000' }] } });
    expect(uiMock.showJourneyEnded).not.toHaveBeenCalled();
    expect(state._notStartedJid).toBeNull();
    expect(uiMock.updateJourneyStopDelays).toHaveBeenCalled();
    // A second no-pos frame (still future last stop) must still not end / not flip,
    // and must NOT wipe the list — so a returning position can't leave a broken panel.
    _applyJourneyPayload('JL', { journey: { pos: {}, stopL: [{ aTimeS: '140000' }] } });
    expect(uiMock.showJourneyEnded).not.toHaveBeenCalled();
    expect(state._notStartedJid).toBeNull();
  });

  it('ended stays ended and idempotent across repeated no-pos frames (never flips to not-started)', () => {
    _applyJourneyPayload('JL', { journey: { pos: { x: 8660000, y: 49342000 }, stopL: [{ aTimeS: '110000' }] } });
    for (let i = 0; i < 3; i++) {
      _applyJourneyPayload('JL', { journey: { pos: {}, stopL: [{ aTimeS: '110000' }] } });
    }
    expect(uiMock.showJourneyEnded).toHaveBeenCalledTimes(3);
    expect(state._notStartedJid).toBeNull();
  });

  it('a never-live journey uses the schedule rule: future last stop → not-started', () => {
    _applyJourneyPayload('JX', { journey: { pos: {}, stopL: [{ aTimeS: '140000' }] } });
    expect(uiMock.showJourneyEnded).not.toHaveBeenCalled();
    expect(state._notStartedJid).toBe('JX');
  });

  it('a never-live journey uses the schedule rule: last stop > 5 min past → ended', () => {
    // 11:40, now 12:00 → more than 5 min past, never seen live.
    _applyJourneyPayload('JY', { journey: { pos: {}, stopL: [{ aTimeS: '114000' }] } });
    expect(uiMock.showJourneyEnded).toHaveBeenCalledOnce();
    expect(state._notStartedJid).toBeNull();
  });

  it('a live journey that gets cancelled shows cancelled regardless of last stop time', () => {
    _applyJourneyPayload('JL', { journey: { pos: { x: 8660000, y: 49342000 }, stopL: [{ aTimeS: '140000' }] } });
    _applyJourneyPayload('JL', { journey: { pos: {}, stopL: [{ aTimeS: '140000' }], isCncl: true } });
    expect(uiMock._showJourneyCancelled).toHaveBeenCalledOnce();
    expect(uiMock.showJourneyEnded).not.toHaveBeenCalled();
  });
});

// === applyPushedStationboard ===
//
// ui.js was mocked above to make refresh.js loadable; for these tests we
// need the REAL applyPushedStationboard. Use a separate spec file would be
// cleaner; here we inline the logic to keep the suite consolidated, calling
// applyPushedStationboard's pure shape directly via a re-implementation
// that mirrors the one in ui.js. This isn't ideal — see #97 (proxy.py split
// + extract ui helpers into testable modules) for the proper fix.
//
// What we test here is the de-dup signature + DEP/ARR dispatch + auto-expand
// guard — all decisions are in pure-JS that doesn't depend on the DOM.
function applyPushedStationboard(loc, data, boardType, sink) {
  if (state._autoExpandingDep || state._autoExpandingArr) return;
  const capturedLid = loc.lid;
  const isArr = boardType === 'ARR';
  const boardSig = (jnyL) => (jnyL || []).map((j) => {
    const stb = j.stbStop || {};
    return (j.jid || '') + '|' + (j.prodX != null ? j.prodX : '') + '|' + (j.dirTxt || '') + '|' + (j.date || '') + '|' + (stb.locX != null ? stb.locX : '') + '|' + (stb.dTimeS || '') + '|' + (stb.dTimeR || '') + '|' + (stb.aTimeS || '') + '|' + (stb.aTimeR || '');
  }).join(';');
  if (!state.selectedStop || state.selectedStop.lid !== capturedLid) return;
  const sig = boardSig(data.jnyL);
  if (isArr) {
    if (sig === state._lastArrSig) return;
    state._lastArrSig = sig;
    state._stationArrData = data;
    sink.renderArrivals(data);
  } else {
    if (sig === state._lastDepSig) return;
    state._lastDepSig = sig;
    state._stationDepData = data;
    sink.renderDepartures(data);
  }
}

describe('applyPushedStationboard — stationboard SSE event helper', () => {
  let sink;
  beforeEach(() => {
    state.selectedStop = { lid: 'A=1@L=1234@', extId: '1234' };
    state._lastDepSig = null;
    state._lastArrSig = null;
    state._stationDepData = null;
    state._stationArrData = null;
    state._autoExpandingDep = false;
    state._autoExpandingArr = false;
    sink = { renderDepartures: vi.fn(), renderArrivals: vi.fn() };
  });

  it('DEP push renders departures and updates _stationDepData', () => {
    const data = { jnyL: [{ jid: 'J-A', dirTxt: 'X' }] };
    applyPushedStationboard(state.selectedStop, data, 'DEP', sink);
    expect(sink.renderDepartures).toHaveBeenCalledOnce();
    expect(sink.renderArrivals).not.toHaveBeenCalled();
    expect(state._stationDepData).toBe(data);
  });

  it('ARR push renders arrivals and updates _stationArrData', () => {
    const data = { jnyL: [{ jid: 'J-B', dirTxt: 'Y' }] };
    applyPushedStationboard(state.selectedStop, data, 'ARR', sink);
    expect(sink.renderArrivals).toHaveBeenCalledOnce();
    expect(sink.renderDepartures).not.toHaveBeenCalled();
    expect(state._stationArrData).toBe(data);
  });

  it('lid mismatch returns early without rendering', () => {
    const otherLoc = { lid: 'A=1@L=9999@' };
    applyPushedStationboard(otherLoc, { jnyL: [{ jid: 'X' }] }, 'DEP', sink);
    expect(sink.renderDepartures).not.toHaveBeenCalled();
  });

  it('identical signature skips re-render (de-dup)', () => {
    const data = { jnyL: [{ jid: 'J-A', dirTxt: 'X' }] };
    applyPushedStationboard(state.selectedStop, data, 'DEP', sink);
    expect(sink.renderDepartures).toHaveBeenCalledTimes(1);
    applyPushedStationboard(state.selectedStop, data, 'DEP', sink);
    expect(sink.renderDepartures).toHaveBeenCalledTimes(1);
  });

  it('changed signature triggers re-render', () => {
    applyPushedStationboard(state.selectedStop, { jnyL: [{ jid: 'A' }] }, 'DEP', sink);
    applyPushedStationboard(state.selectedStop, { jnyL: [{ jid: 'B' }] }, 'DEP', sink);
    expect(sink.renderDepartures).toHaveBeenCalledTimes(2);
  });

  it('auto-expand guards suppress both DEP and ARR rendering', () => {
    state._autoExpandingDep = true;
    applyPushedStationboard(state.selectedStop, { jnyL: [{ jid: 'X' }] }, 'DEP', sink);
    expect(sink.renderDepartures).not.toHaveBeenCalled();
    state._autoExpandingDep = false;
    state._autoExpandingArr = true;
    applyPushedStationboard(state.selectedStop, { jnyL: [{ jid: 'Y' }] }, 'ARR', sink);
    expect(sink.renderArrivals).not.toHaveBeenCalled();
  });
});

describe('_resendActiveSelection — restores selection after SSE reconnect', () => {
  beforeEach(() => {
    api.selectStream.mockClear();
    state.selectedJid = null;
    state.selectedStop = null;
    state._activeStationBoardType = null;
    state._stationDepDur = null;
    state._stationArrDur = null;
  });

  it('re-selects the journey when a jid is selected', () => {
    state.selectedJid = 'J1';
    _resendActiveSelection();
    expect(api.selectStream).toHaveBeenCalledExactlyOnceWith('journey', 'J1');
  });

  it('re-selects the DEP board with the current expanded dur when a stop is selected', () => {
    state.selectedStop = { lid: 'A=1@L=8000@' };
    state._activeStationBoardType = 'DEP';
    state._stationDepDur = 240;
    _resendActiveSelection();
    expect(api.selectStream).toHaveBeenCalledExactlyOnceWith('stationboard', 'A=1@L=8000@', 'DEP', 240);
  });

  it('re-selects the ARR board with the ARR dur when ARR tab is active', () => {
    state.selectedStop = { lid: 'A=1@L=8000@' };
    state._activeStationBoardType = 'ARR';
    state._stationArrDur = 120;
    _resendActiveSelection();
    expect(api.selectStream).toHaveBeenCalledExactlyOnceWith('stationboard', 'A=1@L=8000@', 'ARR', 120);
  });

  it('defaults board type to DEP and dur to 60 when unset', () => {
    state.selectedStop = { lid: 'A=1@L=8000@' };
    _resendActiveSelection();
    expect(api.selectStream).toHaveBeenCalledExactlyOnceWith('stationboard', 'A=1@L=8000@', 'DEP', 60);
  });

  it('does nothing when neither a journey nor a stop is selected', () => {
    _resendActiveSelection();
    expect(api.selectStream).not.toHaveBeenCalled();
  });

  it('prefers the journey selection over a stop when both are set', () => {
    state.selectedJid = 'J9';
    state.selectedStop = { lid: 'A=1@L=8000@' };
    _resendActiveSelection();
    expect(api.selectStream).toHaveBeenCalledExactlyOnceWith('journey', 'J9');
  });

  it('does nothing for a stop object that has no lid (defensive)', () => {
    state.selectedStop = { name: 'no-lid-stop' };
    _resendActiveSelection();
    expect(api.selectStream).not.toHaveBeenCalled();
  });
});

describe('_followPanTo + journey-driven follow (follow bus out of the viewport)', () => {
  let panTo, setView, moveendCb, dist;
  beforeEach(() => {
    state._followPanning = false;
    state._navigating = false;
    state._followPanTimeout = null;
    state.followBus = false;
    state.selectedJid = null;
    state.vehicles = new Map();
    state.serverTimeStamp = Date.now();
    state.serverTimeMin = 720;
    panTo = vi.fn(); setView = vi.fn(); moveendCb = null; dist = 0;
    uiMock.updateJourneyStopDelays.mockClear();
    uiMock.drawRoute.mockClear();
    state.map = {
      getCenter: () => ({ distanceTo: () => dist }),
      getZoom: () => 15,
      panTo,
      setView,
      once: (ev, cb) => { moveendCb = cb; },
    };
  });
  afterEach(() => { state.map = null; state.followBus = false; state.selectedJid = null; });

  it('panTo for a moderate distance and clears _followPanning on moveend', () => {
    dist = 500;
    _followPanTo(49.5, 8.6);
    expect(panTo).toHaveBeenCalledOnce();
    expect(state._followPanning).toBe(true);
    moveendCb();
    expect(state._followPanning).toBe(false);
  });

  it('snaps with setView (no animation) for a large distance', () => {
    dist = 5000;
    _followPanTo(49.9, 8.6);
    expect(setView).toHaveBeenCalledOnce();
    expect(panTo).not.toHaveBeenCalled();
    expect(state._followPanning).toBe(false);
  });

  it('no-op when the target is within 5 m', () => {
    dist = 3;
    _followPanTo(49.5, 8.6);
    expect(panTo).not.toHaveBeenCalled();
    expect(setView).not.toHaveBeenCalled();
  });

  it('no-op while a pan is already in flight', () => {
    dist = 500;
    state._followPanning = true;
    _followPanTo(49.5, 8.6);
    expect(panTo).not.toHaveBeenCalled();
  });

  it('no-op during a URL-restore navigation', () => {
    dist = 500;
    state._navigating = true;
    _followPanTo(49.5, 8.6);
    expect(panTo).not.toHaveBeenCalled();
  });

  it('no-op for null coordinates', () => {
    dist = 500;
    _followPanTo(null, 8.6);
    expect(panTo).not.toHaveBeenCalled();
  });

  it('_applyJourneyPayload pans to the journey position when following and the bus is OFF-ring (not in vehicles)', () => {
    dist = 800;
    state.followBus = true;
    state.selectedJid = 'JF';
    // Bus is NOT in state.vehicles (it left the ring/viewport) — the journey
    // payload still carries its position and must drive the follow-pan.
    _applyJourneyPayload('JF', { journey: { pos: { x: 8600000, y: 49500000 }, stopL: [] } });
    expect(panTo).toHaveBeenCalledOnce();
  });

  it('_applyJourneyPayload pans when following and the bus is in the map but OFF-ring (missedCycles > 0)', () => {
    dist = 800;
    state.followBus = true;
    state.selectedJid = 'JF';
    state.vehicles.set('JF', {
      data: { lat: 49.4, lon: 8.6 },
      marker: { setLatLng: vi.fn() },
      missedCycles: 3,  // off-ring grace
    });
    _applyJourneyPayload('JF', { journey: { pos: { x: 8600000, y: 49500000 }, stopL: [] } });
    expect(panTo).toHaveBeenCalledOnce();
  });

  it('_applyJourneyPayload does NOT pan when the bus is IN-ring (missedCycles === 0) — the vehicles handler owns the pan', () => {
    dist = 800;
    state.followBus = true;
    state.selectedJid = 'JF';
    state.vehicles.set('JF', {
      data: { lat: 49.34, lon: 8.66 },
      marker: { setLatLng: vi.fn() },
      missedCycles: 0,  // in-ring: vehicles payload has the real position
    });
    _applyJourneyPayload('JF', { journey: { pos: { x: 8600000, y: 49500000 }, stopL: [] } });
    expect(panTo).not.toHaveBeenCalled();
    expect(setView).not.toHaveBeenCalled();
  });

  it('_applyJourneyPayload does NOT pan when not following', () => {
    dist = 800;
    state.followBus = false;
    state.selectedJid = 'JF';
    _applyJourneyPayload('JF', { journey: { pos: { x: 8600000, y: 49500000 }, stopL: [] } });
    expect(panTo).not.toHaveBeenCalled();
  });
});

describe('_viewportPayload — follow widens the fetch ring so a zoomed-in bus stays in the payload', () => {
  beforeEach(() => {
    state.followBus = false;
    state.selectedJid = null;
    settings.current = { posMode: 'CALC' };
    // Tiny viewport (~200 m) centered on Sandhausen, as when strongly zoomed in.
    state.map = {
      getCenter: () => ({ lat: 49.342, lng: 8.660 }),
      getBounds: () => ({
        getSouthWest: () => ({ lat: 49.3410, lng: 8.6588 }),
        getNorthEast: () => ({ lat: 49.3430, lng: 8.6612 }),
      }),
    };
  });
  afterEach(() => { state.map = null; state.followBus = false; state.selectedJid = null; });

  it('returns null when the map is not ready', () => {
    state.map = null;
    expect(_viewportPayload()).toBeNull();
  });

  it('sends the exact visual bounds when not following', () => {
    const p = _viewportPayload();
    expect(p.swLat).toBeCloseTo(49.3410, 4);
    expect(p.neLat).toBeCloseTo(49.3430, 4);
    expect(p.swLon).toBeCloseTo(8.6588, 4);
    expect(p.neLon).toBeCloseTo(8.6612, 4);
    expect(p.posMode).toBe('CALC');
  });

  it('widens a tiny viewport to at least ~2 km each way when following', () => {
    state.followBus = true;
    state.selectedJid = 'JF';
    const p = _viewportPayload();
    // ~2000 m ≈ 0.018° lat around center 49.342.
    expect(p.swLat).toBeLessThan(49.342 - 0.017);
    expect(p.neLat).toBeGreaterThan(49.342 + 0.017);
    expect(p.swLon).toBeLessThan(8.660 - 0.02);
    expect(p.neLon).toBeGreaterThan(8.660 + 0.02);
  });

  it('does not shrink a viewport already larger than the follow floor', () => {
    state.followBus = true;
    state.selectedJid = 'JF';
    state.map.getBounds = () => ({
      getSouthWest: () => ({ lat: 49.30, lng: 8.60 }),
      getNorthEast: () => ({ lat: 49.38, lng: 8.72 }),
    });
    const p = _viewportPayload();
    expect(p.swLat).toBeCloseTo(49.30, 4);
    expect(p.neLat).toBeCloseTo(49.38, 4);
    expect(p.swLon).toBeCloseTo(8.60, 4);
    expect(p.neLon).toBeCloseTo(8.72, 4);
  });

  it('does not widen when a bus is selected but follow is off', () => {
    state.followBus = false;
    state.selectedJid = 'JF';
    const p = _viewportPayload();
    expect(p.swLat).toBeCloseTo(49.3410, 4);
    expect(p.neLat).toBeCloseTo(49.3430, 4);
  });
});

describe('follow-pan log + busradarDump (debug dump)', () => {
  let panTo, setView;
  beforeEach(() => {
    state._followPanning = false;
    state._navigating = false;
    state._followPanTimeout = null;
    state._followLog = [];
    state.selectedJid = null;
    state.vehicles = new Map();
    panTo = vi.fn(); setView = vi.fn();
    state.map = {
      getCenter: () => ({ lat: 49.34, lng: 8.66, distanceTo: () => 800 }),
      getZoom: () => 15, panTo, setView, once: () => {},
    };
    settings.current = { posMode: 'CALC' };
  });
  afterEach(() => { state.map = null; });

  it('_followPanTo logs a panTo decision with its distance', () => {
    _followPanTo(49.5, 8.6);
    const last = state._followLog[state._followLog.length - 1];
    expect(last.action).toBe('panTo');
    expect(last.dist).toBe(800);
  });

  it('_followPanTo logs skip:panning WITH the distance (the divergence signature)', () => {
    state._followPanning = true;
    _followPanTo(49.5, 8.6);
    const last = state._followLog[state._followLog.length - 1];
    expect(last.action).toBe('skip');
    expect(last.reason).toBe('panning');
    expect(last.dist).toBe(800);  // large dist on a skip = map left behind the marker
    expect(panTo).not.toHaveBeenCalled();
  });

  it('busradarDump returns parseable JSON with state, follow log, and marker-vs-center offset', () => {
    state.selectedJid = 'JD';
    state.vehicles.set('JD', { marker: { getLatLng: () => ({ lat: 49.36, lng: 8.68 }) }, data: {} });
    state._followLog = [{ t: 1, action: 'skip', dist: 900, reason: 'panning' }];
    const d = JSON.parse(busradarDump());
    expect(d.selectedJid).toBe('JD');
    expect(d.mode).toBe('CALC');
    expect(Array.isArray(d.followLog)).toBe(true);
    expect(d.followLog[0].reason).toBe('panning');
    expect(d.selectedMarker).toBeTruthy();
    expect(d.selectedMarker.offsetMeters).toBe(800);
    expect(typeof d.ts).toBe('string');
  });
});

describe('busradarDownloadDump — download the dump as a .json file', () => {
  let clickSpy, createSpy, revokeSpy;
  beforeEach(() => {
    state.map = null;
    state.selectedJid = null;
    state.vehicles = new Map();
    settings.current = { posMode: 'CALC' };
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    createSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
    revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('creates a Blob of valid JSON, clicks a DOM-attached anchor, and revokes on a delay', () => {
    vi.useFakeTimers();
    busradarDownloadDump();
    expect(createSpy).toHaveBeenCalledTimes(1);
    const blob = createSpy.mock.calls[0][0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('application/json');
    expect(clickSpy).toHaveBeenCalledTimes(1);
    // Anchor is removed again after the click (not left in the DOM).
    expect(document.querySelector('a[download]')).toBeNull();
    expect(revokeSpy).not.toHaveBeenCalled();  // deferred
    vi.advanceTimersByTime(10000);
    expect(revokeSpy).toHaveBeenCalledWith('blob:mock');
  });

  it('falls back to the clipboard copy when Blob/URL is unavailable', async () => {
    createSpy.mockImplementation(() => { throw new Error('no URL'); });
    const writeText = vi.fn().mockResolvedValue(undefined);
    const origClipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    busradarDownloadDump();
    expect(writeText).toHaveBeenCalledTimes(1);
    if (origClipboard === undefined) delete navigator.clipboard;
    else Object.defineProperty(navigator, 'clipboard', { value: origClipboard, configurable: true });
  });
});

describe('debugLog — gated verbose logger', () => {
  let logSpy;
  beforeEach(() => { logSpy = vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { logSpy.mockRestore(); delete window.__busradarVerbose; });

  it('is a no-op when window.__busradarVerbose is off', () => {
    window.__busradarVerbose = false;
    debugLog('should not log', { a: 1 });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('logs with a [verbose] prefix when the flag is on', () => {
    window.__busradarVerbose = true;
    debugLog('viewport POST', { x: 1 });
    expect(logSpy).toHaveBeenCalledWith('[verbose]', 'viewport POST', { x: 1 });
  });
});
