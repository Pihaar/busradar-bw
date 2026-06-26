/**
 * Tests for the SSE event helpers in static/refresh.js + ui.js.
 *
 * Covers the three branches of _applyJourneyPayload (has-pos, journey-ended,
 * not-started) and applyPushedStationboard (de-dup, lid mismatch, DEP/ARR
 * dispatch, auto-expand guard).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const { _applyJourneyPayload } = await import('../../static/refresh.js');
const { state } = await import('../../static/state.js');

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
