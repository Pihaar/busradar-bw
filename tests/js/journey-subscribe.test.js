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
  const ja = document.createElement('div');
  ja.id = 'journey-actions';
  document.body.appendChild(ja);
  document.body.appendChild(ui.departureList);
  state.selectedJid = null;
  state.selectedStop = null;
  state._selectedStopMarker = null;
  state.panelState = 'half';
  vi.spyOn(ui, '_disableFollow').mockImplementation(() => {});
  vi.spyOn(ui, 'setTabMode').mockImplementation(() => {});
  vi.spyOn(ui, 'switchTab').mockImplementation(() => {});
  vi.spyOn(ui, 'clearRoute').mockImplementation(() => {});
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
});
