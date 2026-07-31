/**
 * Falsy-left-operand branch coverage for static/ui.js. Every `x || fallback`
 * chain and `cond ? a : b` here is only ever exercised on one side by the
 * happy-path tests; these cases feed payloads where the LEFT operand is falsy
 * (missing journey/common/jnyL/prodL/locL/stop times/names, empty state
 * counters, out-of-range indices) so the fallback arm runs. Each asserts the
 * fallback-driven output.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildPanelDom, wireUiRefs } from './ui-dom.js';

globalThis.L = {
  latLng: (lat, lon) => ({ lat, lng: lon }),
  latLngBounds: (c) => ({ _c: c }),
  layerGroup: vi.fn(() => ({ addTo: vi.fn() })),
  polyline: vi.fn(() => ({ addTo: vi.fn() })),
  circleMarker: vi.fn(() => {
    const m = {
      addTo: vi.fn(() => m),
      bindTooltip: vi.fn(() => m),
      on: vi.fn((e, cb) => (m._click = cb)),
      remove: vi.fn(),
    };
    return m;
  }),
};

const getJourney = vi.fn(() => new Promise(() => {}));
const getStationBoard = vi.fn(() => new Promise(() => {}));
const selectStream = vi.fn(() => Promise.resolve());
vi.mock('../../static/api.js', () => ({
  api: {
    getStationBoard: (...a) => getStationBoard(...a),
    getJourney: (...a) => getJourney(...a),
    selectStream: (...a) => selectStream(...a),
  },
  urlState: { push: vi.fn(), replace: vi.fn(), parse: vi.fn(() => ({})), saveMapPosition: vi.fn() },
}));
vi.mock('../../static/map.js', () => ({
  markers: { updateAll: vi.fn(), highlightSelected: vi.fn() },
  stopsLayer: { update: vi.fn(), addStopMarker: vi.fn(), saveToCache: vi.fn() },
}));
vi.mock('../../static/status.js', () => ({ announce: vi.fn() }));

const { ui, search } = await import('../../static/ui.js');
const { state } = await import('../../static/state.js');
const { stopsLayer } = await import('../../static/map.js');

function settle() {
  return new Promise((r) => setTimeout(r, 0));
}
function mapStub(extra) {
  return Object.assign(
    {
      setView: vi.fn(),
      panTo: vi.fn(),
      fitBounds: vi.fn(),
      once: vi.fn(),
      getCenter: () => ({ lat: 49.3, lng: 8.6 }),
      getZoom: () => 14,
    },
    extra || {},
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  buildPanelDom();
  wireUiRefs(ui);
  state.serverTimeMin = 600;
  state.serverTimeStamp = null;
  state.map = mapStub();
  state.selectedStop = null;
  state.selectedJid = null;
  state.vehicles = new Map();
  state.allStops = new Map();
  state.routeLayer = null;
  state.routeCoords = null;
  state.routeStopMarkers = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('buildLineFilter / applyLineFilter — missing-data fallbacks', () => {
  it('handles data with no common and no jnyL (both default)', () => {
    ui.buildLineFilter({}); // common || {} , filteredJnyL || data.jnyL || []
    expect(document.getElementById('line-filter').hidden).toBe(true);
  });

  it('applyLineFilter(arr) uses the || 60 dur fallback when _stationArrDur is unset', () => {
    state._activeTab = 'arrivals';
    state._stationArrData = { jnyL: [] };
    state._stationLoc = { lid: 'A' };
    state._stationExtId = '1';
    state._stationArrDur = 0; // falsy → || 60
    vi.spyOn(ui, 'renderArrivals').mockImplementation(() => {});
    const lm = vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
    ui.applyLineFilter('705');
    expect(lm).toHaveBeenCalledWith('arrival-list', { lid: 'A' }, '1', 60, 'ARR');
  });

  it('applyLineFilter(dep) uses the || 60 dur fallback when _stationDepDur is unset', () => {
    state._activeTab = 'departures';
    state._stationDepData = { jnyL: [] };
    state._stationLoc = { lid: 'A' };
    state._stationExtId = '1';
    state._stationDepDur = 0;
    vi.spyOn(ui, 'renderDepartures').mockImplementation(() => {});
    const lm = vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
    ui.applyLineFilter(null);
    expect(lm).toHaveBeenCalledWith('departure-list', { lid: 'A' }, '1', 60, 'DEP');
  });
});

describe('updateJourneyStopDelays — data with no journey/stopL', () => {
  it('treats a bare data object as an empty stop set (journey/stopL default)', () => {
    state._renderedStopSig = ui._stopSig([]);
    const list = document.createElement('ol');
    document.body.appendChild(list);
    ui.stopList = list;
    ui.updateJourneyStopDelays({}); // journey || {} → stopL || []
    expect(list.querySelectorAll('.stop-item').length).toBe(0);
  });
});

describe('drawRoute — data with no common/journey/locL/stopL', () => {
  it('a bare data object yields no route (every || fallback taken)', () => {
    ui.drawRoute({}, null); // common||{}, polyL||[], journey||{}, locL||[], stopL||[]
    expect(state.routeCoords).toBeNull();
  });

  it('fallback line uses the first-stop || {} when locX is out of range', () => {
    const data = {
      common: {
        polyL: [],
        locL: [
          { name: 'A', crd: { x: 8600000, y: 49300000 } },
          { name: 'B', crd: { x: 8620000, y: 49320000 } },
        ],
      },
      // one stop with locX out of range (>= locL.length) → loc defaults to {} → skipped
      journey: { stopL: [{ locX: 9 }, { locX: 0 }, { locX: 1 }] },
    };
    ui.drawRoute(data, null);
    expect(state.routeCoords.length).toBe(2);
  });

  it('route-stop tooltip uses the "" fallback for a nameless loc', () => {
    const data = {
      common: {
        polyL: [{ crdEncYX: '' }], // empty decode → falls to the stopL >= 2 fallback
        locL: [{ crd: { x: 8600000, y: 49300000 } }, { crd: { x: 8620000, y: 49320000 } }], // no name
      },
      journey: { stopL: [{ locX: 0 }, { locX: 1 }] },
    };
    ui.drawRoute(data, null);
    const created = L.circleMarker.mock.results[0].value;
    expect(created.bindTooltip).toHaveBeenCalledWith('', expect.any(Object));
  });

  it('route-stop click uses cachedStop || loc when no cache matches', () => {
    state.allStops = new Map();
    const data = {
      common: {
        polyL: [{ crdEncYX: '' }],
        locL: [
          { name: 'A', lid: 'A=1@L=1@', extId: 'E1', crd: { x: 8600000, y: 49300000 } },
          { name: 'B', crd: { x: 8620000, y: 49320000 } },
        ],
      },
      journey: { stopL: [{ locX: 0 }, { locX: 1 }] },
    };
    ui.drawRoute(data, null);
    const sb = vi.spyOn(ui, 'showStationBoard').mockImplementation(() => {});
    L.circleMarker.mock.results[0].value._click();
    expect(sb).toHaveBeenCalledWith(data.common.locL[0]); // loc fallback
  });
});

describe('renderDepartures / renderArrivals — jnyL/common/prodL fallbacks', () => {
  beforeEach(() => {
    ui.departureList = document.getElementById('departure-list');
    state._stationDepDur = 60;
    state._stationArrDur = 60;
    state._autoExpandingDep = false;
    state._autoExpandingArr = false;
    state.vehicles = new Map();
  });

  it('renderDepartures with prodX out of range uses the {} prod fallback ("?")', () => {
    const data = {
      jnyL: [{ jid: 'A', prodX: 9, dirTxt: 'X', stbStop: { dTimeS: '120000' } }],
      common: { prodL: [{ nameS: '721' }], locL: [] },
    };
    ui.renderDepartures(data, { name: 'S' }, '', null);
    expect(ui.departureList.querySelector('.departure-line').textContent).toBe('?');
  });

  it('renderArrivals with prodX out of range uses the {} prod fallback', () => {
    const data = {
      jnyL: [{ jid: 'A', prodX: 9, dirTxt: 'X', stbStop: { aTimeS: '120000' } }],
      common: { prodL: [{ nameS: '721' }], locL: [] },
    };
    ui.renderArrivals(data, { name: 'S' }, '', null);
    expect(
      document.getElementById('arrival-list').querySelector('.departure-line').textContent,
    ).toBe('?');
  });

  it('renderDepartures HAFAS-hint uses (data.jnyL || []) — an empty data object shows empty-state, not hint', () => {
    ui.renderDepartures({}, { name: 'S' }, '', null);
    expect(ui.departureList.querySelector('.hafas-hint')).toBeNull();
    expect(ui.departureList.querySelector('.empty-state')).not.toBeNull();
  });
});

describe('applyPushedStationboard — dur fallbacks', () => {
  it('uses the || 60 ARR dur fallback when _stationArrDur is falsy', () => {
    state.selectedStop = { lid: 'A=1@L=1@' };
    state._autoExpandingDep = false;
    state._autoExpandingArr = false;
    state._lastArrSig = null;
    state._stationArrDur = 0; // falsy → 60
    vi.spyOn(ui, 'renderArrivals').mockImplementation(() => {});
    const lm = vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
    ui.applyPushedStationboard(
      { lid: 'A=1@L=1@' },
      { jnyL: [{ jid: 'A', stbStop: {} }], common: {} },
      'ARR',
    );
    expect(lm).toHaveBeenCalledWith('arrival-list', expect.anything(), '1', 60, 'ARR');
  });

  it('signature uses default arms for jnyL null and missing stbStop fields', () => {
    state.selectedStop = { lid: 'A=1@L=1@' };
    state._autoExpandingDep = false;
    state._autoExpandingArr = false;
    state._lastDepSig = 'PREV';
    state._stationDepDur = 60;
    vi.spyOn(ui, 'renderDepartures').mockImplementation(() => {});
    vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
    // data.jnyL undefined → boardSig(undefined) → (jnyL || []) empty → sig ''
    ui.applyPushedStationboard({ lid: 'A=1@L=1@' }, {}, 'DEP');
    expect(state._lastDepSig).toBe('');
  });
});

describe('showStationBoard / loadArrivals — dur + name fallbacks', () => {
  it('showStationBoard uses the stop_fallback name when loc has no name', () => {
    vi.spyOn(ui, '_disableFollow').mockImplementation(() => {});
    vi.spyOn(ui, 'clearRoute').mockImplementation(() => {});
    vi.spyOn(ui, 'setTabMode').mockImplementation(() => {});
    vi.spyOn(ui, 'switchTab').mockImplementation(() => {});
    vi.spyOn(ui, 'hideLineFilter').mockImplementation(() => {});
    vi.spyOn(ui, 'loadDepartures').mockReturnValue({ finally: () => {} });
    state.panelState = 'half';
    ui.showStationBoard({ lid: 'A=1@L=1@' }, true); // no name
    expect(ui.detailDir.textContent.length).toBeGreaterThan(0);
  });

  it('loadArrivals error keeps a shown list using the || dur fallback', async () => {
    const arr = document.getElementById('arrival-list');
    const li = document.createElement('li');
    li.className = 'departure-item';
    arr.appendChild(li);
    state.selectedStop = { lid: 'A=1@L=1@', name: 'S' };
    state._activeStationBoardType = 'ARR';
    state._stationArrDur = 0; // falsy → || dur
    vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
    getStationBoard.mockReturnValueOnce(Promise.reject(new Error('rate')));
    await ui.loadArrivals({ lid: 'A=1@L=1@', name: 'S' }, '', 120, false);
    await settle();
    expect(arr.querySelectorAll('.departure-item').length).toBe(1);
  });
});

describe('discoverPlatforms — loc.name/extId fallbacks', () => {
  it('uses "?" name and "" extId defaults for a nameless physical stop', () => {
    ui.discoverPlatforms({
      common: {
        locL: [
          { lid: 'A=1@L=1@', crd: { x: 8600000, y: 49300000 }, gidL: ['b×foo', 'A×x:y:z:w:5'] }, // no name/extId
        ],
      },
    });
    expect(stopsLayer.addStopMarker).toHaveBeenCalledWith(
      expect.objectContaining({ name: '?', extId: '', platform: '5' }),
    );
  });
});

describe('focusJourneyById — journeyProd / dir / stopL fallbacks (live)', () => {
  beforeEach(() => {
    vi.spyOn(ui, '_disableFollow').mockImplementation(() => {});
    vi.spyOn(ui, 'setTabMode').mockImplementation(() => {});
    vi.spyOn(ui, 'switchTab').mockImplementation(() => {});
    vi.spyOn(ui, 'setPanelState').mockImplementation(() => {});
    vi.spyOn(ui, 'renderJourneyStops').mockImplementation(() => {});
    vi.spyOn(ui, 'drawRoute').mockImplementation(() => {});
    state.panelState = 'half';
  });

  it('live journey with only prod.name (no nameS) and no dirTxt uses those fallbacks', async () => {
    getJourney.mockReturnValueOnce(
      Promise.resolve({
        journey: { pos: { x: 8610000, y: 49310000 }, stopL: [] }, // no prodX, no dirTxt, empty stopL
        common: { prodL: [{ name: 'Bus 9' }] }, // journeyProd = prodL[undefined] || prod || {} = {}, but prod passed below
      }),
    );
    ui.focusJourneyById('J', { name: 'Bus 9' }, true); // prod has name only
    await settle();
    expect(ui.detailLine.textContent).toBe('Bus 9');
    expect(ui.detailDir.textContent).toBe('?');
  });

  it('derives delay from a departure pair when present (dTimeS/dTimeR arm)', async () => {
    getJourney.mockReturnValueOnce(
      Promise.resolve({
        journey: {
          pos: { x: 8610000, y: 49310000 },
          stopL: [{ locX: 0, dTimeS: '100000', dTimeR: '100200' }], // +2 via departure pair
          dirTxt: 'Z',
          prodX: 0,
        },
        common: { prodL: [{ nameS: '721', name: 'Bus 721' }], locL: [{ name: 'A' }] },
      }),
    );
    ui.focusJourneyById('J', {}, true);
    await settle();
    expect(ui.detailDelay.textContent).toContain('+2');
  });
});

describe('search — line-match and combined-score fallbacks', () => {
  beforeEach(() => {
    document.body.innerHTML = '<input id="search-input" /><div id="search-results" hidden></div>';
    search.init();
    state.map = mapStub({ getCenter: () => ({ lat: 49.3, lng: 8.6 }) });
    search._searchSeq = 0;
    window.fetch = vi.fn(() => new Promise(() => {}));
  });

  it('a vehicle matched by exact line (first || arm) is added', () => {
    state.vehicles = new Map([
      ['J', { data: { line: '99', lineFull: 'X', direction: 'D', delay: 0, stops: [] } }],
    ]);
    search.doSearch('99');
    expect(search._localLines.length).toBe(1);
  });

  it('a vehicle matched only by the line substring (third || arm) is added', () => {
    state.vehicles = new Map([
      ['J', { data: { line: 'N7X', lineFull: 'zzz', direction: 'D', delay: 0, stops: [] } }],
    ]);
    // query 'n7' not equal to line, not in lineFull, but in line → third arm
    search.doSearch('n7');
    expect(search._localLines.length).toBe(1);
  });

  it('_renderCombined score comparator uses the || 0 fallbacks for score-less stops', () => {
    search._asyncLines = [];
    search._localLines = [];
    // stops with no score property → sa/sb default to 0
    search._localStops = [
      { type: 'stop', stop: { name: 'A', lat: 1, lon: 2, extId: 'a', platform: '' } },
      { type: 'stop', stop: { name: 'B', lat: 1, lon: 2, extId: 'b', platform: '' } },
    ];
    search._asyncStops = [];
    search._queryWords = [];
    const spy = vi.spyOn(search, 'renderResults').mockImplementation(() => {});
    search._renderCombined();
    expect(spy).toHaveBeenCalled();
  });

  it('remote line_search with no vehicles array uses the || [] fallback', async () => {
    state.vehicles = new Map();
    window.fetch = vi.fn((url) =>
      url.includes('/line_search')
        ? Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) // no vehicles key
        : new Promise(() => {}),
    );
    search.doSearch('99');
    await settle();
    expect(search._asyncLines).toEqual([]);
  });

  it('remote stop search with no results array uses the || [] fallback', async () => {
    state.allStops = new Map();
    window.fetch = vi.fn((url) =>
      url.includes('/search?')
        ? Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) // no results key
        : new Promise(() => {}),
    );
    search.doSearch('walldorf');
    await settle();
    expect(search._asyncStops).toEqual([]);
  });
});
