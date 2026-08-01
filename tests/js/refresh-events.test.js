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
  detailLine: { textContent: '' },
  detailDir: { textContent: '' },
};
vi.mock('../../static/ui.js', () => ({ ui: uiMock }));
vi.mock('../../static/api.js', () => ({
  trackedFetch: (...a) => window.fetch(...a),
  api: {
    subscribeBoard: vi.fn(() => Promise.resolve({})),
    selectStream: vi.fn(() => Promise.resolve({})),
  },
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

const {
  _applyJourneyPayload,
  _resendActiveSelection,
  _followPanTo,
  _viewportPayload,
  derivedServerNowMin,
  busradarDump,
  busradarDownloadDump,
  _copyDump,
} = await import('../../static/refresh.js');
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
    state.serverTimeMin = 720; // 12:00
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

  it('off-ring snap cancels an in-flight interpolation RAF before setLatLng (#194)', () => {
    const hadCAF = typeof globalThis.cancelAnimationFrame === 'function';
    const caf = hadCAF
      ? vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {})
      : ((globalThis.cancelAnimationFrame = vi.fn()), globalThis.cancelAnimationFrame);
    const sv = {
      data: { lat: 0, lon: 0, jid: 'JR' },
      marker: { setLatLng: vi.fn() },
      missedCycles: 3,
      _animFrame: 777, // an interpolation RAF is in flight
    };
    state.vehicles.set('JR', sv);
    _applyJourneyPayload('JR', {
      journey: { pos: { x: 8660000, y: 49342000 }, stopL: [] },
    });
    expect(caf).toHaveBeenCalledWith(777);
    expect(sv._animFrame).toBeNull();
    expect(sv.marker.setLatLng).toHaveBeenCalledWith([49.342, 8.66]);
    if (hadCAF) caf.mockRestore();
    else delete globalThis.cancelAnimationFrame;
  });

  it('branch 1b: position present but vehicle not in BBox → only updateJourneyStopDelays', () => {
    const payload = {
      journey: { pos: { x: 8660000, y: 49342000 }, stopL: [] },
    };
    _applyJourneyPayload('J-not-in-bbox', payload);
    expect(uiMock.updateJourneyStopDelays).toHaveBeenCalledOnce();
    expect(uiMock.drawRoute).not.toHaveBeenCalled();
  });

  it('a not-started journey that gets a live position clears the suffix + reveals actions (off-map)', () => {
    const ja = document.createElement('div');
    ja.id = 'journey-actions';
    ja.hidden = true;
    document.body.appendChild(ja);
    uiMock.detailLine.textContent = '';
    uiMock.detailDir.textContent = 'Ziel (noch nicht gestartet)';
    state.selectedJid = 'JS1';
    state._notStartedJid = 'JS1';
    // Bus is NOT in state.vehicles (off-map) → the in-BBox transition in
    // _handleVehiclesPayload can't fire; the journey push must do it.
    _applyJourneyPayload('JS1', {
      journey: { pos: { x: 8660000, y: 49342000 }, stopL: [], prodX: 0, dirTxt: 'Ziel' },
      common: { prodL: [{ nameS: '751', name: 'Bus 751' }] },
    });
    expect(state._notStartedJid).toBeNull();
    expect(uiMock.detailDir.textContent).toBe('Ziel'); // stale "(not started)" suffix gone
    expect(uiMock.detailLine.textContent).toBe('Bus 751');
    expect(ja.hidden).toBe(false);
    document.body.removeChild(ja);
  });

  it('starts a not-started journey defensively when prod/dir/actions are all absent', () => {
    const stray = document.getElementById('journey-actions');
    if (stray) stray.remove(); // ensure the `if (ja)` guard takes its false arm
    uiMock.detailLine.textContent = 'orig-line';
    uiMock.detailDir.textContent = 'orig-dir';
    state.selectedJid = 'JS2';
    state._notStartedJid = 'JS2';
    // no common at all → line ''; no journey.dirTxt; no #journey-actions element
    _applyJourneyPayload('JS2', {
      journey: { pos: { x: 8660000, y: 49342000 }, stopL: [] },
    });
    expect(state._notStartedJid).toBeNull(); // still cleared
    expect(uiMock.detailLine.textContent).toBe('orig-line'); // no line → not overwritten
    expect(uiMock.detailDir.textContent).toBe('orig-dir'); // no dirTxt → not overwritten
  });

  it('falls back to prod.nameS for the header when prod.name is absent', () => {
    const stray = document.getElementById('journey-actions');
    if (stray) stray.remove();
    uiMock.detailLine.textContent = '';
    state.selectedJid = 'JS3';
    state._notStartedJid = 'JS3';
    _applyJourneyPayload('JS3', {
      journey: { pos: { x: 8660000, y: 49342000 }, stopL: [], prodX: 0 },
      common: { prodL: [{ nameS: '751' }] }, // nameS only, no name
    });
    expect(uiMock.detailLine.textContent).toBe('751');
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

  it('branch 2b: isCncl but ui._showJourneyCancelled absent → returns without ending', () => {
    const saved = uiMock._showJourneyCancelled;
    delete uiMock._showJourneyCancelled;
    _applyJourneyPayload('J3b', { journey: { pos: {}, stopL: [], isCncl: true } });
    expect(uiMock.showJourneyEnded).not.toHaveBeenCalled();
    uiMock._showJourneyCancelled = saved;
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
    _applyJourneyPayload('JL', {
      journey: { pos: { x: 8660000, y: 49342000 }, stopL: [{ aTimeS: '110000' }] },
    });
    expect(state._selectedHadPosJid).toBe('JL');
    _applyJourneyPayload('JL', { journey: { pos: {}, stopL: [{ aTimeS: '110000' }] } });
    expect(uiMock.showJourneyEnded).toHaveBeenCalledOnce();
    expect(state._notStartedJid).toBeNull();
  });

  it('live journey losing position with a FUTURE last stop keeps the panel (mid-route gap / near terminus): NOT ended, NOT not-started', () => {
    _applyJourneyPayload('JL', {
      journey: { pos: { x: 8660000, y: 49342000 }, stopL: [{ aTimeS: '140000' }] },
    });
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
    _applyJourneyPayload('JL', {
      journey: { pos: { x: 8660000, y: 49342000 }, stopL: [{ aTimeS: '110000' }] },
    });
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

  it('a different not-started jid is replaced (the jid-mismatch branch)', () => {
    state._notStartedJid = 'OLD';
    state._notStartedSince = 111;
    _applyJourneyPayload('NEW', { journey: { pos: {}, stopL: [{ aTimeS: '140000' }] } });
    expect(state._notStartedJid).toBe('NEW');
  });

  it('re-marking the SAME not-started jid keeps the original _notStartedSince', () => {
    _applyJourneyPayload('SAME', { journey: { pos: {}, stopL: [{ aTimeS: '140000' }] } });
    const since = state._notStartedSince;
    expect(since).toBeGreaterThan(0);
    _applyJourneyPayload('SAME', { journey: { pos: {}, stopL: [{ aTimeS: '140000' }] } });
    expect(state._notStartedSince).toBe(since); // not reset on the repeat
  });

  it('a never-live journey uses the schedule rule: last stop > 5 min past → ended', () => {
    // 11:40, now 12:00 → more than 5 min past, never seen live.
    _applyJourneyPayload('JY', { journey: { pos: {}, stopL: [{ aTimeS: '114000' }] } });
    expect(uiMock.showJourneyEnded).toHaveBeenCalledOnce();
    expect(state._notStartedJid).toBeNull();
  });

  it('a live journey that gets cancelled shows cancelled regardless of last stop time', () => {
    _applyJourneyPayload('JL', {
      journey: { pos: { x: 8660000, y: 49342000 }, stopL: [{ aTimeS: '140000' }] },
    });
    _applyJourneyPayload('JL', {
      journey: { pos: {}, stopL: [{ aTimeS: '140000' }], isCncl: true },
    });
    expect(uiMock._showJourneyCancelled).toHaveBeenCalledOnce();
    expect(uiMock.showJourneyEnded).not.toHaveBeenCalled();
  });

  it('no-pos with an unparseable last-stop time falls back to lastMin=0', () => {
    // parseHafasTimeToMin returns null for a too-short time → the `lastMin ===
    // null` guard resets it to 0. lastTime ('99') is still truthy, and for a
    // never-live journey 0 + 5 <= now(720) → ended.
    _applyJourneyPayload('JBAD', { journey: { pos: {}, stopL: [{ aTimeS: '99' }] } });
    expect(uiMock.showJourneyEnded).toHaveBeenCalledOnce();
  });

  it('midnight-wrap: pre-midnight now, past-midnight last stop → treated as future (not-started)', () => {
    // now 23:30 (1410 > 1080), last stop 00:30 (30 < 360) → +1440 makes it
    // tomorrow, so it is still in the future → not-started, not ended.
    state.serverTimeMin = 1410;
    state.serverTimeStamp = Date.now();
    _applyJourneyPayload('JW1', { journey: { pos: {}, stopL: [{ aTimeS: '003000' }] } });
    expect(uiMock.showJourneyEnded).not.toHaveBeenCalled();
    expect(state._notStartedJid).toBe('JW1');
  });

  it('midnight-wrap: post-midnight now, pre-midnight last stop → treated as past (ended)', () => {
    // now 00:30 (30 < 360), last stop 23:30 (1410 > 1080) → -1440 makes it
    // yesterday, so > 5 min past for a never-live journey → ended.
    state.serverTimeMin = 30;
    state.serverTimeStamp = Date.now();
    _applyJourneyPayload('JW2', { journey: { pos: {}, stopL: [{ aTimeS: '233000' }] } });
    expect(uiMock.showJourneyEnded).toHaveBeenCalledOnce();
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
  if (state._stationDepFetching || state._stationArrFetching) return;
  const capturedLid = loc.lid;
  const isArr = boardType === 'ARR';
  const boardSig = (jnyL) =>
    (jnyL || [])
      .map((j) => {
        const stb = j.stbStop || {};
        return (
          (j.jid || '') +
          '|' +
          (j.prodX != null ? j.prodX : '') +
          '|' +
          (j.dirTxt || '') +
          '|' +
          (j.date || '') +
          '|' +
          (stb.locX != null ? stb.locX : '') +
          '|' +
          (stb.dTimeS || '') +
          '|' +
          (stb.dTimeR || '') +
          '|' +
          (stb.aTimeS || '') +
          '|' +
          (stb.aTimeR || '')
        );
      })
      .join(';');
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
    state._stationDepFetching = false;
    state._stationArrFetching = false;
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
    state._stationDepFetching = true;
    applyPushedStationboard(state.selectedStop, { jnyL: [{ jid: 'X' }] }, 'DEP', sink);
    expect(sink.renderDepartures).not.toHaveBeenCalled();
    state._stationDepFetching = false;
    state._stationArrFetching = true;
    applyPushedStationboard(state.selectedStop, { jnyL: [{ jid: 'Y' }] }, 'ARR', sink);
    expect(sink.renderArrivals).not.toHaveBeenCalled();
  });
});

describe('_resendActiveSelection — restores selection after SSE reconnect', () => {
  beforeEach(() => {
    api.selectStream.mockClear();
    api.subscribeBoard.mockClear();
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

  it('re-subscribes the DEP board at the fixed 2h SSE window when a stop is selected', () => {
    // The reconnect resend goes through subscribeBoard (fixed 2h realtime
    // window), never the 1440 fetch dur — so a reconnect can't push a 24h board.
    state.selectedStop = { lid: 'A=1@L=8000@' };
    state._activeStationBoardType = 'DEP';
    state._stationDepDur = 240;
    _resendActiveSelection();
    expect(api.subscribeBoard).toHaveBeenCalledExactlyOnceWith('A=1@L=8000@', 'DEP');
    expect(api.selectStream).not.toHaveBeenCalled();
  });

  it('re-subscribes the ARR board when the ARR tab is active', () => {
    state.selectedStop = { lid: 'A=1@L=8000@' };
    state._activeStationBoardType = 'ARR';
    _resendActiveSelection();
    expect(api.subscribeBoard).toHaveBeenCalledExactlyOnceWith('A=1@L=8000@', 'ARR');
  });

  it('defaults the board type to DEP when unset', () => {
    state.selectedStop = { lid: 'A=1@L=8000@' };
    _resendActiveSelection();
    expect(api.subscribeBoard).toHaveBeenCalledExactlyOnceWith('A=1@L=8000@', 'DEP');
  });

  it('does nothing when neither a journey nor a stop is selected', () => {
    _resendActiveSelection();
    expect(api.selectStream).not.toHaveBeenCalled();
    expect(api.subscribeBoard).not.toHaveBeenCalled();
  });

  it('prefers the journey selection over a stop when both are set', () => {
    state.selectedJid = 'J9';
    state.selectedStop = { lid: 'A=1@L=8000@' };
    _resendActiveSelection();
    expect(api.selectStream).toHaveBeenCalledExactlyOnceWith('journey', 'J9');
    expect(api.subscribeBoard).not.toHaveBeenCalled();
  });

  it('does nothing for a stop object that has no lid (defensive)', () => {
    state.selectedStop = { name: 'no-lid-stop' };
    _resendActiveSelection();
    expect(api.selectStream).not.toHaveBeenCalled();
    expect(api.subscribeBoard).not.toHaveBeenCalled();
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
    panTo = vi.fn();
    setView = vi.fn();
    moveendCb = null;
    dist = 0;
    uiMock.updateJourneyStopDelays.mockClear();
    uiMock.drawRoute.mockClear();
    state.map = {
      getCenter: () => ({ distanceTo: () => dist }),
      getZoom: () => 15,
      panTo,
      setView,
      once: (ev, cb) => {
        moveendCb = cb;
      },
    };
  });
  afterEach(() => {
    state.map = null;
    state.followBus = false;
    state.selectedJid = null;
  });

  it('panTo for a moderate distance and clears _followPanning on moveend', () => {
    dist = 500;
    _followPanTo(49.5, 8.6);
    expect(panTo).toHaveBeenCalledOnce();
    expect(state._followPanning).toBe(true);
    moveendCb();
    expect(state._followPanning).toBe(false);
  });

  it('the setTimeout fallback clears _followPanning if moveend never fires', () => {
    vi.useFakeTimers();
    try {
      dist = 500;
      _followPanTo(49.5, 8.6);
      expect(state._followPanning).toBe(true);
      // moveend never fires; the 2500ms safety timeout must clear the flag.
      vi.advanceTimersByTime(2500);
      expect(state._followPanning).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the follow-log ring buffer is bounded at 120 entries (oldest shifted out)', () => {
    dist = 500;
    state._followLog = Array.from({ length: 120 }, (_, i) => ({ t: i, action: 'seed' }));
    _followPanTo(49.5, 8.6);
    expect(state._followLog.length).toBe(120); // capped, not 121
    expect(state._followLog[state._followLog.length - 1].action).toBe('panTo');
    expect(state._followLog[0].action).toBe('seed'); // still seeded entries, but shifted
    expect(state._followLog[0].t).toBe(1); // entry t=0 was shifted out
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

  it('no-op when the map is not ready', () => {
    state.map = null;
    _followPanTo(49.5, 8.6);
    expect(panTo).not.toHaveBeenCalled();
    expect(setView).not.toHaveBeenCalled();
  });

  it('_flog lazily initialises state._followLog when it is null', () => {
    dist = 500;
    state._followLog = null;
    _followPanTo(49.5, 8.6);
    expect(Array.isArray(state._followLog)).toBe(true);
    expect(state._followLog[state._followLog.length - 1].action).toBe('panTo');
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
      missedCycles: 3, // off-ring grace
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
      missedCycles: 0, // in-ring: vehicles payload has the real position
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
      getCenter: () => ({ lat: 49.342, lng: 8.66 }),
      getBounds: () => ({
        getSouthWest: () => ({ lat: 49.341, lng: 8.6588 }),
        getNorthEast: () => ({ lat: 49.343, lng: 8.6612 }),
      }),
    };
  });
  afterEach(() => {
    state.map = null;
    state.followBus = false;
    state.selectedJid = null;
  });

  it('returns null when the map is not ready', () => {
    state.map = null;
    expect(_viewportPayload()).toBeNull();
  });

  it('sends the exact visual bounds when not following', () => {
    const p = _viewportPayload();
    expect(p.swLat).toBeCloseTo(49.341, 4);
    expect(p.neLat).toBeCloseTo(49.343, 4);
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
    expect(p.swLon).toBeLessThan(8.66 - 0.02);
    expect(p.neLon).toBeGreaterThan(8.66 + 0.02);
  });

  it('does not shrink a viewport already larger than the follow floor', () => {
    state.followBus = true;
    state.selectedJid = 'JF';
    state.map.getBounds = () => ({
      getSouthWest: () => ({ lat: 49.3, lng: 8.6 }),
      getNorthEast: () => ({ lat: 49.38, lng: 8.72 }),
    });
    const p = _viewportPayload();
    expect(p.swLat).toBeCloseTo(49.3, 4);
    expect(p.neLat).toBeCloseTo(49.38, 4);
    expect(p.swLon).toBeCloseTo(8.6, 4);
    expect(p.neLon).toBeCloseTo(8.72, 4);
  });

  it('does not widen when a bus is selected but follow is off', () => {
    state.followBus = false;
    state.selectedJid = 'JF';
    const p = _viewportPayload();
    expect(p.swLat).toBeCloseTo(49.341, 4);
    expect(p.neLat).toBeCloseTo(49.343, 4);
  });

  it('defaults posMode to CALC when settings.current is null', () => {
    const saved = settings.current;
    settings.current = null;
    const p = _viewportPayload();
    expect(p.posMode).toBe('CALC');
    settings.current = saved;
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
    panTo = vi.fn();
    setView = vi.fn();
    state.map = {
      getCenter: () => ({ lat: 49.34, lng: 8.66, distanceTo: () => 800 }),
      getZoom: () => 15,
      panTo,
      setView,
      once: () => {},
    };
    settings.current = { posMode: 'CALC' };
  });
  afterEach(() => {
    state.map = null;
  });

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
    expect(last.dist).toBe(800); // large dist on a skip = map left behind the marker
    expect(panTo).not.toHaveBeenCalled();
  });

  it('busradarDump returns parseable JSON with state, follow log, and marker-vs-center offset', () => {
    state.selectedJid = 'JD';
    state.vehicles.set('JD', {
      marker: { getLatLng: () => ({ lat: 49.36, lng: 8.68 }) },
      data: {},
    });
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

  it('busradarDump carries the COMPLETE console ring, not a truncated tail', () => {
    const prev = window.__busradarConsoleTail;
    window.__busradarConsoleTail = Array.from({ length: 400 }, (_, i) => 'line-' + i);
    const d = JSON.parse(busradarDump());
    expect(d.consoleTail.length).toBe(400); // no slice(-150) truncation
    expect(d.consoleTail[0]).toBe('line-0'); // oldest retained
    expect(d.consoleTail[399]).toBe('line-399'); // newest retained
    window.__busradarConsoleTail = prev;
  });

  it('busradarDump captures the broader app state (vehicles, stop board, tabs, filters, bounds)', () => {
    state.map.getBounds = () => ({
      getSouthWest: () => ({ lat: 49.3, lng: 8.6 }),
      getNorthEast: () => ({ lat: 49.4, lng: 8.72 }),
    });
    state.selectedJid = 'JV1';
    state.vehicles.set('JV1', {
      data: { line: '725', lat: 49.35, lon: 8.67, delay: 2 },
      missedCycles: 0,
      marker: { getLatLng: () => ({ lat: 49.35, lng: 8.67 }) },
    });
    state.vehicles.set('JV2', {
      data: { line: '719', lat: 49.31, lon: 8.64, delay: null },
      missedCycles: 3,
    });
    state.selectedStop = { lid: 'A=1@L=6003411@', name: 'Sandhausen', extId: '6003411' };
    state._activeStationBoardType = 'DEP';
    state._activeTab = 'departures';
    state._depFilter = '725';
    // New stationboard diagnostics (populated arms): dep cache with jnyL, arr
    // cache WITHOUT jnyL (→ 0), a finite dep horizon, an Infinity arr horizon
    // (serialised as "Infinity"), a dep fetch age + in-flight + pending backoff,
    // and a dep dedup sig; arr side left null/0/false to cover the other arms.
    state._stationDepData = { jnyL: [{}, {}, {}] };
    state._stationArrData = {}; // no jnyL key → cacheCount 0
    state._stationDepHorizon = 800;
    state._stationArrHorizon = Infinity;
    state._stationDepFetchedAt = Date.now() - 5000;
    state._stationArrFetchedAt = null;
    state._stationDepFetching = true;
    state._stationArrFetching = false;
    state._stationDepRetryAt = Date.now() + 30000;
    state._stationArrRetryAt = 0;
    state._lastDepSig = 'A|0|X|20260601|134500';
    state._lastArrSig = null;
    const depList = document.createElement('div');
    depList.id = 'departure-list';
    const row = document.createElement('div');
    row.className = 'departure-item';
    row.textContent = '725  Sandhausen  13:45  +2';
    depList.appendChild(row);
    document.body.appendChild(depList);

    const d = JSON.parse(busradarDump());

    expect(d.vehicles.length).toBe(2);
    const v1 = d.vehicles.find((v) => v.jid === 'JV1');
    expect(v1.line).toBe('725');
    expect(v1.delay).toBe(2);
    expect(v1.selected).toBe(true);
    const v2 = d.vehicles.find((v) => v.jid === 'JV2');
    expect(v2.missedCycles).toBe(3);
    expect(v2.selected).toBe(false);

    expect(d.stop.name).toBe('Sandhausen');
    expect(d.stop.activeBoardType).toBe('DEP');
    expect(d.stop.departures.count).toBe(1);
    expect(d.stop.departures.rows[0]).toContain('725');
    // New board diagnostics — populated arms.
    expect(d.stop.extId).toBe('6003411');
    expect(d.stop.filterExtId).toBeNull(); // _stationExtId unset here
    expect(d.stop.depCacheCount).toBe(3);
    expect(d.stop.arrCacheCount).toBe(0); // {} has no jnyL
    expect(d.stop.depHorizon).toBe(800);
    expect(d.stop.arrHorizon).toBe('Infinity'); // non-finite serialised as string
    expect(d.stop.depFetchedAgeMs).toBeGreaterThanOrEqual(5000);
    expect(d.stop.arrFetchedAgeMs).toBeNull();
    expect(d.stop.depFetching).toBe(true);
    expect(d.stop.arrFetching).toBe(false);
    expect(d.stop.depRetryInMs).toBeGreaterThan(0);
    expect(d.stop.arrRetryInMs).toBeNull();
    expect(d.stop.depLastSig).toBe('A|0|X|20260601|134500');
    expect(d.stop.arrLastSig).toBeNull();

    expect(d.activeTab).toBe('departures');
    expect(d.filters.dep).toBe('725');
    expect(d.map.bounds.swLat).toBeCloseTo(49.3, 5);
    expect(d.map.bounds.neLon).toBeCloseTo(8.72, 5);

    document.body.removeChild(depList);
  });

  it('busradarDump stop is null when no stop is selected', () => {
    state.selectedStop = null;
    const d = JSON.parse(busradarDump());
    expect(d.stop).toBeNull();
    expect(Array.isArray(d.vehicles)).toBe(true);
  });

  it('busradarDump stop diagnostics — not-loaded arms (null cache/horizon, filterExtId set)', () => {
    state.selectedStop = { lid: 'A=1@L=9@' }; // no name, no extId
    state._stationExtId = '9';
    state._activeStationBoardType = 'DEP';
    state._stationDepData = null;
    state._stationArrData = null;
    state._stationDepHorizon = null;
    state._stationArrHorizon = null;
    state._stationDepFetchedAt = null;
    state._stationArrFetchedAt = null;
    state._stationDepFetching = false;
    state._stationArrFetching = false;
    state._stationDepRetryAt = 0;
    state._stationArrRetryAt = 0;
    state._lastDepSig = null;
    state._lastArrSig = null;
    const d = JSON.parse(busradarDump());
    expect(d.stop.name).toBeNull(); // s.name absent
    expect(d.stop.extId).toBeNull(); // s.extId absent
    expect(d.stop.filterExtId).toBe('9'); // state._stationExtId truthy arm
    expect(d.stop.depCacheCount).toBeNull();
    expect(d.stop.arrCacheCount).toBeNull();
    expect(d.stop.depHorizon).toBeNull();
    expect(d.stop.depFetchedAgeMs).toBeNull();
    expect(d.stop.depRetryInMs).toBeNull();
  });

  it('busradarDump env fingerprint is populated (fields present for cross-browser compare)', () => {
    const d = JSON.parse(busradarDump());
    expect(typeof d.env.userAgent === 'string' || d.env.userAgent === null).toBe(true);
    expect('timeZone' in d.env).toBe(true);
    expect('viewportW' in d.env).toBe(true);
    expect('hardwareConcurrency' in d.env).toBe(true);
  });

  it('busradarDump env falls back to null when a navigator read throws (hardened browser)', () => {
    const orig = Object.getOwnPropertyDescriptor(navigator, 'deviceMemory');
    try {
      Object.defineProperty(navigator, 'deviceMemory', {
        configurable: true,
        get() {
          throw new Error('blocked');
        },
      });
      const d = JSON.parse(busradarDump());
      expect(d.env.deviceMemory).toBeNull();
    } finally {
      if (orig) Object.defineProperty(navigator, 'deviceMemory', orig);
      else delete navigator.deviceMemory;
    }
  });

  it('busradarDump journey block carries server stopL AND the rendered DOM rows', () => {
    state.selectedJourneyData = {
      journey: {
        pos: { x: 8660000, y: 49340000 },
        stopL: [
          { locX: 0, dTimeS: '134500', dTimeR: '134700' },
          { locX: 1, aTimeS: '135000' },
        ],
      },
      common: { locL: [{ name: 'Stop A' }, { name: 'Stop B' }] },
    };
    state._renderedStopSig = 'sig-xyz';
    const list = document.createElement('ol');
    list.id = 'stop-list';
    const li = document.createElement('li');
    li.className = 'stop-item';
    const nm = document.createElement('div');
    nm.className = 'stop-name';
    nm.textContent = 'Stop A';
    const tm = document.createElement('div');
    tm.className = 'stop-times';
    tm.textContent = '13:45';
    const dot = document.createElement('div');
    dot.className = 'stop-dot stop-dot--passed';
    li.append(dot, nm, tm);
    list.appendChild(li);
    document.body.appendChild(list);

    const d = JSON.parse(busradarDump());
    expect(d.journey.hasPos).toBe(true);
    expect(d.journey.renderedStopSig).toBe('sig-xyz');
    expect(d.journey.dataStopCount).toBe(2);
    expect(d.journey.dataStops[0].name).toBe('Stop A');
    expect(d.journey.dataStops[0].dTimeR).toBe('134700');
    expect(d.journey.domStopCount).toBe(1);
    expect(d.journey.domStops[0].name).toBe('Stop A');
    expect(d.journey.domStops[0].passed).toBe(true);

    document.body.removeChild(list);
    state.selectedJourneyData = null;
  });

  it('busradarDump vehicles is [] when state.vehicles is null (guard branch)', () => {
    state.vehicles = null;
    const d = JSON.parse(busradarDump());
    expect(d.vehicles).toEqual([]);
    expect(d.vehiclesCount).toBe(0);
  });

  it('busradarDump vehicles returns [{error}] when the forEach throws', () => {
    // A Map-like whose forEach throws → the inner try/catch returns [{error}].
    state.vehicles = {
      size: 1,
      forEach() {
        throw new Error('iter boom');
      },
    };
    const d = JSON.parse(busradarDump());
    expect(Array.isArray(d.vehicles)).toBe(true);
    expect(typeof d.vehicles[0].error).toBe('string');
    state.vehicles = new Map();
  });

  it('busradarDump journey block returns {error} instead of throwing on bad data', () => {
    state.selectedJourneyData = {
      journey: {
        get stopL() {
          throw new Error('boom-journey');
        },
      },
    };
    const d = JSON.parse(busradarDump());
    expect(typeof d.journey.error).toBe('string');
    state.selectedJourneyData = null;
  });

  it('busradarDump stop block returns {error} instead of throwing on bad data', () => {
    state.selectedStop = {
      get lid() {
        throw new Error('boom-stop');
      },
    };
    const d = JSON.parse(busradarDump());
    expect(typeof d.stop.error).toBe('string');
    state.selectedStop = null;
  });

  it('busradarDump map.bounds is null when getBounds throws (guard branch)', () => {
    state.map.getBounds = () => {
      throw new Error('not ready');
    };
    const d = JSON.parse(busradarDump());
    expect(d.map.bounds).toBeNull();
  });

  it('busradarDump exercises the falsy sides of the field fallbacks', () => {
    // mode null (settings.current falsy), hadPosJid truthy, a vehicle with no
    // `.data`, a journey stop whose locX points past locL (no name), a DOM
    // stop-item missing its sub-elements, a selectedStop with no name, and a
    // null _followLog — every `x || y` / `x ? a : b` falsy branch in the dump.
    const savedSettings = settings.current;
    settings.current = null;
    state._selectedHadPosJid = 'HADPOS';
    state.selectedJid = 'JND';
    state.vehicles = new Map();
    state.vehicles.set('JND', { marker: { getLatLng: () => ({ lat: 1, lng: 2 }) } }); // no .data
    state.selectedJourneyData = {
      journey: { pos: null, stopL: [{ locX: 99 }] }, // locL[99] undefined → loc={}
      common: { locL: [] },
    };
    state.selectedStop = { lid: 'A=1@L=1@' }; // no name/extId
    state._followLog = null;

    const list = document.createElement('ol');
    list.id = 'stop-list';
    const li = document.createElement('li');
    li.className = 'stop-item'; // deliberately no .stop-name/.stop-times/.stop-dot children
    list.appendChild(li);
    document.body.appendChild(list);

    const d = JSON.parse(busradarDump());
    expect(d.mode).toBeNull();
    expect(d.hadPosJid).toBe('HADPOS');
    expect(d.journey.dataStops[0].name).toBeNull();
    expect(d.journey.domStops[0].name).toBeNull();
    expect(d.journey.domStops[0].times).toBeNull();
    expect(d.journey.domStops[0].passed).toBeNull();
    expect(d.stop.name).toBeNull();
    expect(Array.isArray(d.followLog)).toBe(true);

    document.body.removeChild(list);
    settings.current = savedSettings;
    state.selectedJourneyData = null;
    state.selectedStop = null;
    state._selectedHadPosJid = null;
  });

  it('busradarDump env fallbacks: languages absent and serviceWorker absent', () => {
    const savedLang = Object.getOwnPropertyDescriptor(navigator, 'languages');
    const savedSw = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
    try {
      Object.defineProperty(navigator, 'languages', { value: undefined, configurable: true });
      Object.defineProperty(navigator, 'serviceWorker', { value: undefined, configurable: true });
      const d = JSON.parse(busradarDump());
      expect(d.env.languages).toBe(''); // (undefined || []).join(',')
      expect(d.env.swController).toBe(false); // serviceWorker falsy short-circuit
    } finally {
      if (savedLang) Object.defineProperty(navigator, 'languages', savedLang);
      else delete navigator.languages;
      if (savedSw) Object.defineProperty(navigator, 'serviceWorker', savedSw);
      else delete navigator.serviceWorker;
    }
  });

  it('busradarDump env swController true when a controller is present', () => {
    const savedSw = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
    try {
      Object.defineProperty(navigator, 'serviceWorker', {
        value: { controller: {} },
        configurable: true,
      });
      const d = JSON.parse(busradarDump());
      expect(d.env.swController).toBe(true);
    } finally {
      if (savedSw) Object.defineProperty(navigator, 'serviceWorker', savedSw);
      else delete navigator.serviceWorker;
    }
  });
});

describe('derivedServerNowMin — shared server-clock helper', () => {
  afterEach(() => {
    state.serverTimeMin = null;
    state.serverTimeStamp = null;
  });

  it('returns null when no server time has arrived yet', () => {
    state.serverTimeMin = null;
    state.serverTimeStamp = null;
    expect(derivedServerNowMin()).toBeNull();
  });

  it('extrapolates from the stamp when serverTimeStamp is set', () => {
    state.serverTimeMin = 600;
    state.serverTimeStamp = Date.now() - 120000; // 2 min ago
    const v = derivedServerNowMin();
    expect(v).toBeGreaterThanOrEqual(601.9);
    expect(v).toBeLessThanOrEqual(602.5);
  });

  it('falls back to elapsed 0 when serverTimeStamp is null (the ternary false arm)', () => {
    state.serverTimeMin = 600;
    state.serverTimeStamp = null;
    expect(derivedServerNowMin()).toBe(600);
  });
});

describe('busradarDump Runde 2 — network / SSE / time / markers / sw / geo', () => {
  let savedSettings;
  beforeEach(() => {
    savedSettings = settings.current;
    settings.current = { posMode: 'CALC', showLocation: false };
    state.map = {
      getCenter: () => ({ lat: 49.34, lng: 8.66, distanceTo: () => 0 }),
      getZoom: () => 15,
    };
    state.selectedJid = null;
    state.vehicles = new Map();
    state._followLog = [];
    state._fetchLog = [];
    state._sseLog = [];
    state._sseState = 'connecting';
    state.lastUpdate = null;
    state.consecutiveErrors = 0;
    state._lastConnectedClients = undefined;
    state.serverTimeMin = null;
    state.serverTimeStamp = null;
    state._lastViewportPayload = null;
    state._swRegistration = null;
    state._swCacheVersion = null;
    state._geoWatchId = null;
    state._geoLastFix = null;
    state._userLocationMarker = null;
    state._appVersion = null;
  });
  afterEach(() => {
    state.map = null;
    settings.current = savedSettings;
    delete globalThis.L.Marker;
  });

  it('fetchLog / sseLog carry the rings when set, and fall back to [] when null', () => {
    state._fetchLog = [{ ts: 1, method: 'GET', url: '/x', status: 200, kind: 'ok' }];
    state._sseLog = [{ t: 1, type: 'vehicles', meta: { n: 3 } }];
    let d = JSON.parse(busradarDump());
    expect(d.fetchLog).toHaveLength(1);
    expect(d.fetchLog[0].kind).toBe('ok');
    expect(d.sseLog[0].type).toBe('vehicles');

    state._fetchLog = null;
    state._sseLog = null;
    d = JSON.parse(busradarDump());
    expect(d.fetchLog).toEqual([]);
    expect(d.sseLog).toEqual([]);
  });

  it('sse block: falsy arms (no _es, no state, no lastUpdate, no clients)', () => {
    state._sseState = null;
    state.lastUpdate = null;
    state._lastConnectedClients = undefined;
    const d = JSON.parse(busradarDump());
    expect(d.sse.state).toBeNull();
    expect(d.sse.readyState).toBeNull(); // _es is null in this suite
    expect(d.sse.lastUpdateAgeMs).toBeNull();
    expect(d.sse.connectedClients).toBeNull();
  });

  it('sse block: truthy arms (state set, lastUpdate + clients present)', () => {
    state._sseState = 'open';
    state.lastUpdate = Date.now() - 1000;
    state._lastConnectedClients = '7';
    state.consecutiveErrors = 2;
    const d = JSON.parse(busradarDump());
    expect(d.sse.state).toBe('open');
    expect(d.sse.consecutiveErrors).toBe(2);
    expect(d.sse.lastUpdateAgeMs).toBeGreaterThanOrEqual(1000);
    expect(d.sse.connectedClients).toBe('7');
  });

  it('serverTime: all null when no server tick yet', () => {
    state.serverTimeMin = null;
    const d = JSON.parse(busradarDump());
    expect(d.serverTime.serverTimeMin).toBeNull();
    expect(d.serverTime.derivedNowMin).toBeNull();
    expect(d.serverTime.skewMin).toBeNull();
  });

  it('serverTime: populated with a near-zero skew when the clock is in sync', () => {
    const now = new Date();
    const localMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
    state.serverTimeMin = localMin + 5;
    state.serverTimeStamp = Date.now();
    const d = JSON.parse(busradarDump());
    expect(d.serverTime.serverTimeMin).toBeCloseTo(localMin + 5, 1);
    expect(d.serverTime.skewMin).toBeGreaterThan(3);
    expect(d.serverTime.skewMin).toBeLessThan(7);
  });

  it('serverTime: skew normalises across the midnight wrap (both directions)', () => {
    const now = new Date();
    const localMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
    // skew > 720 → subtract 1440
    state.serverTimeMin = localMin + 900;
    state.serverTimeStamp = Date.now();
    let d = JSON.parse(busradarDump());
    expect(d.serverTime.skewMin).toBeLessThan(0); // 900 - 1440 = -540
    // skew < -720 → add 1440
    state.serverTimeMin = localMin - 900;
    state.serverTimeStamp = Date.now();
    d = JSON.parse(busradarDump());
    expect(d.serverTime.skewMin).toBeGreaterThan(0); // -900 + 1440 = 540
  });

  it('serverTime: stampMs falls back to null when serverTimeStamp is 0/falsy', () => {
    state.serverTimeMin = 600;
    state.serverTimeStamp = null; // serverTimeMin set but no stamp
    const d = JSON.parse(busradarDump());
    expect(d.serverTime.stampMs).toBeNull();
    expect(d.serverTime.derivedNowMin).toBe(600); // elapsed 0
  });

  it('panelHeader reads the detail header text; missing nodes fall back to null', () => {
    const line = document.createElement('div');
    line.id = 'detail-line';
    line.textContent = '725';
    document.body.appendChild(line);
    const d = JSON.parse(busradarDump());
    expect(d.panelHeader.line).toBe('725');
    // dir/delay nodes absent → _dumpRead catch → null (proves never-throw)
    expect(d.panelHeader.dir).toBeNull();
    expect(d.panelHeader.delay).toBeNull();
    document.body.removeChild(line);
  });

  it('lastViewport reflects the captured payload, else null', () => {
    let d = JSON.parse(busradarDump());
    expect(d.lastViewport).toBeNull();
    state._lastViewportPayload = { swLat: 1, follow: true, ts: 123 };
    d = JSON.parse(busradarDump());
    expect(d.lastViewport.follow).toBe(true);
  });

  it('markers.markersOnMap counts only vehicles whose marker is on the map', () => {
    state.vehicles.set('A', { marker: { _map: {} }, data: {} }); // on map
    state.vehicles.set('B', { marker: { _map: null }, data: {} }); // marker, not on map
    state.vehicles.set('C', { data: {} }); // no marker
    const d = JSON.parse(busradarDump());
    expect(d.markers.markersOnMap).toBe(1);
  });

  it('markers.mapMarkerCount is null without eachLayer, and counts L.Marker layers with the stub', () => {
    // Default map stub has no eachLayer → guard returns null.
    let d = JSON.parse(busradarDump());
    expect(d.markers.mapMarkerCount).toBeNull();

    // eachLayer present but no L.Marker constructor → !Lm arm → null.
    state.map.eachLayer = (cb) => {
      cb({});
    };
    d = JSON.parse(busradarDump());
    expect(d.markers.mapMarkerCount).toBeNull();

    // eachLayer + L.Marker present → explicit count, instanceof both arms.
    globalThis.L.Marker = class {};
    const marker = new globalThis.L.Marker();
    state.map.eachLayer = (cb) => {
      cb(marker); // counts
      cb({}); // not an L.Marker → skipped
    };
    d = JSON.parse(busradarDump());
    expect(d.markers.mapMarkerCount).toBe(1);
  });

  it('markers.mapMarkerCount is null when the map itself is absent (!m arm)', () => {
    state.map = null;
    const d = JSON.parse(busradarDump());
    expect(d.markers.mapMarkerCount).toBeNull();
  });

  it('markers.markersOnMap is null when the vehicles read throws (_dumpRead catch)', () => {
    state.vehicles = {
      forEach() {
        throw new Error('boom');
      },
    };
    const d = JSON.parse(busradarDump());
    expect(d.markers.markersOnMap).toBeNull();
    state.vehicles = new Map();
  });

  it('sw block reflects an injected registration (waiting / installing / active url)', () => {
    const savedSw = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
    try {
      Object.defineProperty(navigator, 'serviceWorker', {
        value: { controller: {} },
        configurable: true,
      });
      state._swRegistration = {
        waiting: {},
        installing: {},
        active: { scriptURL: 'https://x/sw.js' },
      };
      state._swCacheVersion = 'v1,v2';
      state._appVersion = '1.2.41';
      const d = JSON.parse(busradarDump());
      expect(d.sw.controller).toBe(true);
      expect(d.sw.hasRegistration).toBe(true);
      expect(d.sw.waiting).toBe(true);
      expect(d.sw.installing).toBe(true);
      expect(d.sw.activeScriptURL).toBe('https://x/sw.js');
      expect(d.sw.cacheVersion).toBe('v1,v2');
      expect(d.sw.appVersion).toBe('1.2.41');
    } finally {
      if (savedSw) Object.defineProperty(navigator, 'serviceWorker', savedSw);
      else delete navigator.serviceWorker;
    }
  });

  it('sw block: no registration and an active reg without scriptURL fall back to null', () => {
    state._swRegistration = null;
    let d = JSON.parse(busradarDump());
    expect(d.sw.hasRegistration).toBe(false);
    expect(d.sw.waiting).toBe(false);
    expect(d.sw.activeScriptURL).toBeNull();

    state._swRegistration = { active: {} }; // active present, scriptURL absent
    d = JSON.parse(busradarDump());
    expect(d.sw.activeScriptURL).toBeNull(); // scriptURL || null

    state._swRegistration = { active: undefined }; // reg && reg.active false arm
    d = JSON.parse(busradarDump());
    expect(d.sw.activeScriptURL).toBeNull();
  });

  it('sw block yields null (not a throw) when navigator.serviceWorker access throws', () => {
    const savedSw = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
    try {
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        get() {
          throw new Error('blocked by hardened browser');
        },
      });
      const d = JSON.parse(busradarDump());
      expect(d.sw).toBeNull(); // the catch returns null, consistent with sibling blocks
    } finally {
      if (savedSw) Object.defineProperty(navigator, 'serviceWorker', savedSw);
      else delete navigator.serviceWorker;
    }
  });

  it('geo block: independent watch/fix, marker-shown flag, and lastFix age', () => {
    state._geoWatchId = null;
    state._geoLastFix = null;
    state._userLocationMarker = null;
    let d = JSON.parse(busradarDump());
    expect(d.geo.watchActive).toBe(false);
    expect(d.geo.markerShown).toBe(false);
    expect(d.geo.lastFix).toBeNull();
    expect(d.geo.lastFixAgeMs).toBeNull();

    state._geoWatchId = 42;
    state._userLocationMarker = { _map: {} };
    state._geoLastFix = { lat: 49.34, lon: 8.66, accuracy: 12, ts: Date.now() - 2000 };
    d = JSON.parse(busradarDump());
    expect(d.geo.watchActive).toBe(true);
    expect(d.geo.markerShown).toBe(true);
    expect(d.geo.lastFix.accuracy).toBe(12);
    expect(d.geo.lastFixAgeMs).toBeGreaterThanOrEqual(2000);
  });

  it('jsErrors mirrors the window-global error ring', () => {
    const prev = window.__busradarErrors;
    window.__busradarErrors = [{ ts: 1, kind: 'error', message: 'boom' }];
    const d = JSON.parse(busradarDump());
    expect(d.jsErrors[0].message).toBe('boom');
    window.__busradarErrors = prev;
  });

  it('vehicles entries carry direction and onMap', () => {
    state.selectedJid = 'V1';
    state.vehicles.set('V1', {
      data: { line: '725', direction: 'Sandhausen', lat: 49.34, lon: 8.66, delay: 1 },
      missedCycles: 0,
      marker: { _map: {} },
    });
    const d = JSON.parse(busradarDump());
    const v = d.vehicles.find((x) => x.jid === 'V1');
    expect(v.direction).toBe('Sandhausen');
    expect(v.onMap).toBe(true);
  });

  it('journey dataStops carry per-stop delayDep / delayArr', () => {
    state.selectedJourneyData = {
      journey: {
        stopL: [
          { locX: 0, dTimeS: '134500', dTimeR: '134800', aTimeS: '134400', aTimeR: '134700' },
        ],
      },
      common: { locL: [{ name: 'Stop A' }] },
    };
    const d = JSON.parse(busradarDump());
    expect(d.journey.dataStops[0].delayDep).toBe(3);
    expect(d.journey.dataStops[0].delayArr).toBe(3);
    state.selectedJourneyData = null;
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
    expect(revokeSpy).not.toHaveBeenCalled(); // deferred
    vi.advanceTimersByTime(10000);
    expect(revokeSpy).toHaveBeenCalledWith('blob:mock');
  });

  it('falls back to the clipboard copy when Blob/URL is unavailable', async () => {
    createSpy.mockImplementation(() => {
      throw new Error('no URL');
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    const origClipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    busradarDownloadDump();
    expect(writeText).toHaveBeenCalledTimes(1);
    if (origClipboard === undefined) delete navigator.clipboard;
    else
      Object.defineProperty(navigator, 'clipboard', { value: origClipboard, configurable: true });
  });
});

describe('debugLog — gated verbose logger', () => {
  let logSpy;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    delete window.__busradarVerbose;
  });

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

describe('_copyDump — clipboard copy with data-recovery fallback', () => {
  let logSpy;
  const origClipboard = navigator.clipboard;
  beforeEach(() => {
    // A minimal, dump-able state so busradarDump() produces valid JSON.
    state.map = null;
    state.selectedJid = null;
    state.vehicles = new Map();
    state._followLog = [];
    settings.current = { posMode: 'CALC' };
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    if (origClipboard === undefined) delete navigator.clipboard;
    else
      Object.defineProperty(navigator, 'clipboard', { value: origClipboard, configurable: true });
  });

  it('copies to the clipboard when navigator.clipboard.writeText resolves', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    _copyDump();
    expect(writeText).toHaveBeenCalledTimes(1);
    // Let the resolved .then run so report(true) fires.
    await Promise.resolve();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('copied to clipboard'));
    // Success path does NOT echo the full JSON to the console.
    const dumpEchoed = logSpy.mock.calls.some(
      (c) => typeof c[0] === 'string' && c[0].indexOf('"mode"') !== -1,
    );
    expect(dumpEchoed).toBe(false);
  });

  it('no clipboard API → report(false) logs the notice AND the full JSON dump (recovery path)', () => {
    // No usable navigator.clipboard.
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    _copyDump();
    // First log: the "unavailable" notice; second log: the full dump text.
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('clipboard unavailable'));
    const dumpCall = logSpy.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].indexOf('"mode": "CALC"') !== -1,
    );
    expect(dumpCall).toBeTruthy();
    // The echoed text is parseable JSON, i.e. the complete dump for recovery.
    expect(() => JSON.parse(dumpCall[0])).not.toThrow();
  });

  it('writeText rejects → report(false) echoes the full JSON dump too', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    _copyDump();
    expect(writeText).toHaveBeenCalledTimes(1);
    // Let the rejected .then's failure callback run.
    await Promise.resolve();
    await Promise.resolve();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('clipboard unavailable'));
    const dumpCall = logSpy.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].indexOf('"mode": "CALC"') !== -1,
    );
    expect(dumpCall).toBeTruthy();
  });

  it('Ctrl+Shift+D keydown handler copies the dump and prevents the default', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const ev = new KeyboardEvent('keydown', { ctrlKey: true, shiftKey: true, key: 'D' });
    const prevent = vi.spyOn(ev, 'preventDefault');
    window.dispatchEvent(ev);
    expect(prevent).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('Cmd+Shift+D keydown handler (metaKey) also copies the dump', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const ev = new KeyboardEvent('keydown', { metaKey: true, shiftKey: true, key: 'd' });
    const prevent = vi.spyOn(ev, 'preventDefault');
    window.dispatchEvent(ev);
    expect(prevent).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('a non-matching keydown (no shift) is ignored by the handler', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const ev = new KeyboardEvent('keydown', { ctrlKey: true, shiftKey: false, key: 'D' });
    const prevent = vi.spyOn(ev, 'preventDefault');
    window.dispatchEvent(ev);
    expect(prevent).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('a thrown clipboard access is caught → report(false) echoes the full dump', () => {
    // navigator.clipboard getter throws (hardened browser) → outer try/catch
    // falls back to report(false), which logs the notice and the JSON.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      get() {
        throw new Error('clipboard blocked');
      },
    });
    _copyDump();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('clipboard unavailable'));
    const dumpCall = logSpy.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].indexOf('"mode": "CALC"') !== -1,
    );
    expect(dumpCall).toBeTruthy();
  });
});
