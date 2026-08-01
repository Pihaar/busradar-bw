/**
 * Last two reachable branch arms in static/ui.js:
 *  - the DEP-side dur `|| 60` fallback in applyPushedStationboard, and
 *  - the `if (r.stop)` false arm in doSearch's remote-stop dedup pass
 *    (a _localStops entry that carries no stop object).
 * The other remaining arms are invariant-guarded defensive code and are
 * documented as unreachable in the task report (not ignored in source).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

globalThis.L = {
  latLng: (lat, lon) => ({ lat, lng: lon }),
  latLngBounds: (c) => ({ _c: c }),
  layerGroup: vi.fn(() => ({ addTo: vi.fn() })),
  polyline: vi.fn(() => ({ addTo: vi.fn() })),
  circleMarker: vi.fn(() => {
    const m = { addTo: vi.fn(() => m), bindTooltip: vi.fn(() => m), on: vi.fn(), remove: vi.fn() };
    return m;
  }),
};

const selectStream = vi.fn(() => Promise.resolve());
vi.mock('../../static/api.js', () => ({
  trackedFetch: (...a) => window.fetch(...a),
  api: { selectStream: (...a) => selectStream(...a) },
  urlState: { push: vi.fn(), replace: vi.fn() },
}));
vi.mock('../../static/map.js', () => ({
  markers: { highlightSelected: vi.fn() },
  stopsLayer: { addStopMarker: vi.fn(), saveToCache: vi.fn() },
}));
vi.mock('../../static/status.js', () => ({ announce: vi.fn() }));

const { ui, search } = await import('../../static/ui.js');
const { state } = await import('../../static/state.js');

function settle() {
  return new Promise((r) => setTimeout(r, 0));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('applyPushedStationboard — DEP dur || 60 fallback (ternary false side)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '<ol id="departure-list"></ol><ol id="arrival-list"></ol>';
    ui.departureList = document.getElementById('departure-list');
    state.selectedStop = { lid: 'A=1@L=1@', extId: 'E1' };
    state._autoExpandingDep = false;
    state._autoExpandingArr = false;
    state._lastDepSig = null;
  });

  it('uses 60 when _stationDepDur is falsy on a DEP push', () => {
    state._stationDepDur = 0; // falsy → || 60, on the isArr-false side of the ternary
    vi.spyOn(ui, 'renderDepartures').mockImplementation(() => {});
    const lm = vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
    ui.applyPushedStationboard(
      { lid: 'A=1@L=1@', extId: 'E1' },
      { jnyL: [{ jid: 'A', stbStop: {} }], common: {} },
      'DEP',
    );
    expect(lm).toHaveBeenCalledWith('departure-list', expect.anything(), 'E1', 60, 'DEP');
  });
});

describe('doSearch remote-stop dedup — if (r.stop) false arm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '<input id="search-input" /><div id="search-results" hidden></div>';
    search.init();
    state.map = { setView: vi.fn(), getCenter: () => ({ lat: 49.3, lng: 8.6 }) };
    state.vehicles = new Map();
    state.allStops = new Map();
    search._searchSeq = 0;
  });

  it('skips a _localStops entry that has no stop object when seeding the seen sets', async () => {
    let resolveJson;
    window.fetch = vi.fn((url) =>
      url.includes('/search?')
        ? Promise.resolve({ ok: true, json: () => new Promise((r) => (resolveJson = r)) })
        : new Promise(() => {}),
    );
    search.doSearch('walldorf');
    // Inject a stop-less entry so the remote-merge forEach hits `if (r.stop)` false.
    search._localStops = [{ type: 'stop' }];
    await settle();
    resolveJson({ results: [{ name: 'Walldorf', lat: 49.3, lon: 8.64, extId: 'E5' }] });
    await settle();
    // the stop-less local entry contributes nothing to `seen`, so the remote
    // result is still merged in.
    expect(search._asyncStops.map((r) => r.stop.extId)).toEqual(['E5']);
  });
});

describe('drawRoute — coords.length === 0 defensive arm (malformed crdEncYX)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '<div id="journey-actions" hidden></div>';
    state.map = { setView: vi.fn() };
    state.routeLayer = null;
    state.routeCoords = null;
    state.routeStopMarkers = [];
    state.serverTimeMin = 600;
    state.serverTimeStamp = null;
  });

  it('a truthy but non-string crdEncYX decodes to [] → skips the route build', () => {
    // crdEncYX passes the `polyL[0].crdEncYX` truthiness guard but has no
    // .length/.charCodeAt semantics, so decodePolyline returns [] and the
    // `if (coords.length > 0)` guard takes its false arm.
    ui.drawRoute(
      { common: { polyL: [{ crdEncYX: 123 }], locL: [] }, journey: { stopL: [] } },
      null,
    );
    expect(state.routeCoords).toBeNull();
  });
});
