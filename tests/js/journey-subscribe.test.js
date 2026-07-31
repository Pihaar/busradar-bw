/**
 * Regression tests: a selection MUST subscribe the SSE stream so the server
 * pushes it every tick, and that subscription must NOT depend on the one-shot
 * detail fetch succeeding.
 *
 * focusJourneyById (URL restore, search-result clicks) never called
 * selectStream at all, so a restored journey received no per-tick pushes:
 * _applyJourneyPayload never ran and a finished run was never flagged "Fahrt
 * beendet" (seen in two restored browsers). selectJourney and the stationboard
 * loaders DID subscribe, but only inside the fetch's .then — so a rejected
 * initial fetch (HAFAS blip / rate-limit) left the panel unsubscribed until a
 * reconnect. All paths now subscribe independently of the fetch outcome.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

globalThis.L = { latLng: (lat, lon) => ({ lat, lng: lon }), circleMarker: vi.fn() };

vi.mock('../../static/api.js', () => ({
  api: {
    getStationBoard: vi.fn(),
    getJourney: vi.fn(() => new Promise(() => {})), // never-resolving by default
    selectStream: vi.fn(() => Promise.resolve({})),
  },
  urlState: { push: vi.fn(), replace: vi.fn() },
}));
vi.mock('../../static/map.js', () => ({
  markers: { updateAll: vi.fn(), highlightSelected: vi.fn() },
  stopsLayer: { update: vi.fn(), addStopMarker: vi.fn() },
}));
vi.mock('../../static/status.js', () => ({ announce: vi.fn() }));

const { ui } = await import('../../static/ui.js');
const { api } = await import('../../static/api.js');
const { state } = await import('../../static/state.js');

const JID = '2|#VN#1#ZE#751#DA#310726#';

function panelFixture() {
  document.body.innerHTML = '';
  ui.detailLine = document.createElement('div');
  ui.detailDir = document.createElement('div');
  ui.detailDelay = document.createElement('div');
  ui.stopList = document.createElement('ol');
  ui.departureList = document.createElement('div');
  ui.departureList.id = 'departure-list';
  const arr = document.createElement('div');
  arr.id = 'arrival-list';
  const ja = document.createElement('div');
  ja.id = 'journey-actions';
  document.body.append(ja, ui.departureList, arr, ui.stopList);
  state.selectedJid = null;
  state.selectedStop = null;
  state._selectedStopMarker = null;
  state._endedJid = null;
  state._notStartedJid = null;
  state._selectedHadPosJid = null;
  state.panelState = 'half';
  state.serverTimeMin = 600;
  state.serverTimeStamp = null;
  state.map = { setView: vi.fn(), getCenter: () => ({ lat: 49.3, lng: 8.6 }), getZoom: () => 15 };
  vi.spyOn(ui, '_disableFollow').mockImplementation(() => {});
  vi.spyOn(ui, 'setTabMode').mockImplementation(() => {});
  vi.spyOn(ui, 'switchTab').mockImplementation(() => {});
  vi.spyOn(ui, 'clearRoute').mockImplementation(() => {});
  vi.spyOn(ui, 'renderJourneyStops').mockImplementation(() => {});
  vi.spyOn(ui, 'drawRoute').mockImplementation(() => {});
}

describe('ui.focusJourneyById — subscribes the journey SSE stream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    panelFixture();
  });

  it('calls api.selectStream("journey", jid) for the selected id', () => {
    ui.focusJourneyById(JID, {}, true);
    expect(api.selectStream).toHaveBeenCalledWith('journey', JID);
  });

  it('sets selectedJid before the one-shot fetch resolves', () => {
    ui.focusJourneyById(JID, {}, true);
    expect(state.selectedJid).toBe(JID);
  });

  it('subscribes even when the one-shot getJourney never resolves', () => {
    ui.focusJourneyById(JID, {}, true);
    expect(api.getJourney).toHaveBeenCalledWith(JID, { userInitiated: true });
    expect(api.selectStream).toHaveBeenCalledTimes(1);
  });

  it('resets stale selection flags up front (before the SSE push can arrive)', () => {
    // A previous selection left these set; without an up-front reset an early
    // SSE push would drive _applyJourneyPayload against stale flags.
    state._endedJid = 'OLD';
    state._notStartedJid = 'OLD';
    state._selectedHadPosJid = 'OLD';
    ui.focusJourneyById(JID, {}, true);
    expect(state._endedJid).toBeNull();
    expect(state._notStartedJid).toBeNull();
    expect(state._selectedHadPosJid).toBeNull();
  });

  it('records the journey as seen-live (hadPosJid=jid) when getJourney returns a position', async () => {
    api.getJourney.mockReturnValueOnce(
      Promise.resolve({
        journey: {
          pos: { x: 8660000, y: 49340000 },
          stopL: [{ locX: 0, dTimeS: '134500' }],
          dirTxt: 'Ziel',
        },
        common: { prodL: [{ nameS: '751', name: 'Bus 751' }], locL: [{ name: 'A' }] },
      }),
    );
    ui.focusJourneyById(JID, {}, true);
    await Promise.resolve();
    await Promise.resolve();
    // Live at selection → must be flagged seen-live so a later pos-loss is
    // detected as "ended", not "not started".
    expect(state._selectedHadPosJid).toBe(JID);
  });
});

describe('ui.selectJourney — subscribes up front, not inside the fetch .then', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    panelFixture();
  });

  it('subscribes even when the one-shot getJourney rejects', async () => {
    api.getJourney.mockReturnValueOnce(Promise.reject(new Error('upstream')));
    ui.selectJourney(
      { jid: JID, line: '751', lineFull: 'Bus 751', direction: 'X', delay: null },
      true,
    );
    // subscription is synchronous, before the rejecting fetch settles
    expect(api.selectStream).toHaveBeenCalledWith('journey', JID);
    await Promise.resolve();
    await Promise.resolve();
    // still exactly one subscribe (the .then path no longer double-subscribes)
    expect(api.selectStream).toHaveBeenCalledTimes(1);
  });
});

describe('ui.loadDepartures — subscribes on fetch error so SSE can recover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    panelFixture();
  });

  it('subscribes stationboard even when the initial getStationBoard rejects', async () => {
    const LID = 'A=1@L=6003411@';
    state.selectedStop = { lid: LID, name: 'Sandhausen' };
    state._activeStationBoardType = 'DEP';
    api.getStationBoard.mockReturnValueOnce(Promise.reject(new Error('rate limit')));

    await ui.loadDepartures({ lid: LID, name: 'Sandhausen' }, '6003411', 60, false);

    expect(api.selectStream).toHaveBeenCalledWith('stationboard', LID, 'DEP', 60);
  });

  it('does NOT subscribe when the stop was deselected before the error', async () => {
    const LID = 'A=1@L=6003411@';
    state.selectedStop = null; // user navigated away
    state._activeStationBoardType = 'DEP';
    api.getStationBoard.mockReturnValueOnce(Promise.reject(new Error('rate limit')));

    await ui.loadDepartures({ lid: LID, name: 'Sandhausen' }, '6003411', 60, false);

    expect(api.selectStream).not.toHaveBeenCalled();
  });

  it('does NOT subscribe from .catch when the active board is ARR (wrong tab)', async () => {
    const LID = 'A=1@L=6003411@';
    state.selectedStop = { lid: LID };
    state._activeStationBoardType = 'ARR'; // user switched to arrivals
    api.getStationBoard.mockReturnValueOnce(Promise.reject(new Error('x')));

    await ui.loadDepartures({ lid: LID, name: 'S' }, '6003411', 60, false);

    expect(api.selectStream).not.toHaveBeenCalled();
  });
});

describe('ui.loadArrivals — subscribes on fetch error (ARR mirror)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    panelFixture();
  });

  it('subscribes stationboard ARR when the initial getStationBoard rejects and ARR is active', async () => {
    const LID = 'A=1@L=6003411@';
    state.selectedStop = { lid: LID };
    state._activeStationBoardType = 'ARR';
    api.getStationBoard.mockReturnValueOnce(Promise.reject(new Error('rate limit')));

    await ui.loadArrivals({ lid: LID, name: 'S' }, '6003411', 60, false);

    expect(api.selectStream).toHaveBeenCalledWith('stationboard', LID, 'ARR', 60);
  });

  it('does NOT subscribe from .catch when the active board is DEP (wrong tab)', async () => {
    const LID = 'A=1@L=6003411@';
    state.selectedStop = { lid: LID };
    state._activeStationBoardType = 'DEP';
    api.getStationBoard.mockReturnValueOnce(Promise.reject(new Error('x')));

    await ui.loadArrivals({ lid: LID, name: 'S' }, '6003411', 60, false);

    expect(api.selectStream).not.toHaveBeenCalled();
  });
});
