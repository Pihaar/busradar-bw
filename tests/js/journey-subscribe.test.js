/**
 * Regression test: a journey opened by id MUST subscribe the SSE stream so the
 * server pushes it every tick. focusJourneyById is the id-based entry point
 * (URL restore on load, search-result clicks) — unlike focusVehicle (map-marker
 * click) it did NOT call api.selectStream, so a restored/searched journey never
 * received per-tick journey pushes. Without those pushes _applyJourneyPayload
 * never runs, so the panel never transitions to live/ended: a bus whose run had
 * finished stayed frozen as "running" and was never flagged "Fahrt beendet"
 * (observed in two browsers, both restored from the URL hash).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

globalThis.L = { latLng: (lat, lon) => ({ lat, lng: lon }) };

vi.mock('../../static/api.js', () => ({
  api: {
    getStationBoard: vi.fn(),
    // never-resolving so the test stays on focusJourneyById's synchronous path
    getJourney: vi.fn(() => new Promise(() => {})),
    selectStream: vi.fn(() => Promise.resolve({})),
  },
  urlState: { push: vi.fn(), replace: vi.fn() },
}));
vi.mock('../../static/map.js', () => ({
  markers: { updateAll: vi.fn() },
  stopsLayer: { update: vi.fn(), addStopMarker: vi.fn() },
}));
vi.mock('../../static/status.js', () => ({ announce: vi.fn() }));

const { ui } = await import('../../static/ui.js');
const { api } = await import('../../static/api.js');
const { state } = await import('../../static/state.js');

const JID = '2|#VN#1#ZE#751#DA#310726#';

describe('ui.focusJourneyById — subscribes the journey SSE stream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
    ui.detailLine = document.createElement('div');
    ui.detailDir = document.createElement('div');
    ui.detailDelay = document.createElement('div');
    ui.stopList = document.createElement('ol');
    state.selectedJid = null;
    state.selectedStop = null;
    state._selectedStopMarker = null;
    state.panelState = 'half'; // already open → setPanelState not exercised here
    // Stub the panel-plumbing helpers so the test targets the subscription only.
    vi.spyOn(ui, '_disableFollow').mockImplementation(() => {});
    vi.spyOn(ui, 'setTabMode').mockImplementation(() => {});
    vi.spyOn(ui, 'switchTab').mockImplementation(() => {});
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
    // The subscription must not depend on the fetch outcome — the server push
    // is what drives every subsequent transition (not-started → live → ended).
    ui.focusJourneyById(JID, {}, true);
    expect(api.getJourney).toHaveBeenCalledWith(JID, { userInitiated: true });
    expect(api.selectStream).toHaveBeenCalledTimes(1);
  });
});
