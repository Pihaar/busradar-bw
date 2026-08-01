/**
 * Regression guard: opening a stop must issue EXACTLY ONE /api/stationboard
 * fetch per board. The window-widening moved server-side, so the old
 * client-side 60→1440 cascade (which fired one request per +60-min step) is
 * gone. This test counts the real window.fetch calls that hit /api/stationboard
 * — it does NOT mock api.js — so a re-introduced client loop would show up as
 * extra fetches and fail here.
 *
 *   ui.loadDepartures(loc, extId, 60, true)  → 1 stationboard fetch
 *   ui.showStationBoard(loc)                  → 2 (DEP + ARR)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildPanelDom, wireUiRefs } from './ui-dom.js';

globalThis.L = {
  latLng: (lat, lon) => ({ lat, lng: lon }),
  circleMarker: vi.fn(() => ({ addTo: vi.fn(), remove: vi.fn() })),
};

// map/status are mocked (no real Leaflet / DOM-announce side effects), but
// api.js is REAL so the fetch it makes is observable and countable.
vi.mock('../../static/map.js', () => ({
  markers: { updateAll: vi.fn(), highlightSelected: vi.fn() },
  stopsLayer: { update: vi.fn(), addStopMarker: vi.fn(), saveToCache: vi.fn() },
}));
vi.mock('../../static/status.js', () => ({ announce: vi.fn() }));

const { ui } = await import('../../static/ui.js');
const { state } = await import('../../static/state.js');

function settle() {
  return new Promise((r) => setTimeout(r, 0));
}

// Count only the /api/stationboard fetches (the app also POSTs /api/stream/
// select for the SSE subscription, which we must not count).
function stationboardCalls() {
  return window.fetch.mock.calls.filter((c) => String(c[0]).indexOf('/stationboard') !== -1);
}

const loc = { lid: 'A=1@O=Empty@L=9999999@', name: 'Empty Stop', lat: 49.3, lon: 8.6 };

describe('stationboard opens with a single request per board', () => {
  let origFetch;
  beforeEach(() => {
    origFetch = window.fetch;
    // Empty board response, no settledDur → the loaders keep the requested dur.
    window.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ jnyL: [], common: {} }) }),
    );
    buildPanelDom();
    wireUiRefs(ui);
    state.selectedStop = loc;
    state._depFilter = null;
    state._arrFilter = null;
    state._autoExpandingDep = false;
    state._autoExpandingArr = false;
    state._stationDepCount = 0;
    state._stationArrCount = 0;
    state._activeStationBoardType = 'DEP';
    state._activeTab = 'departures';
    state.map = { setView: vi.fn(), getCenter: () => ({ lat: 49.3, lng: 8.6 }), getZoom: () => 14 };
    state.allStops = new Map();
    state.vehicles = new Map();
    vi.spyOn(ui, 'discoverPlatforms').mockImplementation(() => {});
    vi.spyOn(ui, 'buildLineFilter').mockImplementation(() => {});
    vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
  });
  afterEach(() => {
    window.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it('loadDepartures fires exactly one /stationboard fetch (no client cascade)', async () => {
    await ui.loadDepartures(loc, '9999999', 60, true);
    await settle();
    expect(stationboardCalls().length).toBe(1);
  });

  it('showStationBoard fires exactly two /stationboard fetches (DEP + ARR)', async () => {
    ui.showStationBoard(loc, true);
    // DEP resolves, then its .finally chains the ARR load.
    for (let i = 0; i < 5; i++) await settle();
    expect(stationboardCalls().length).toBe(2);
  });

  it('an active line filter on first load still triggers only one request', async () => {
    state._depFilter = '721'; // a filter set before the stop opened
    await ui.loadDepartures(loc, '9999999', 60, true);
    await settle();
    expect(stationboardCalls().length).toBe(1);
  });
});
