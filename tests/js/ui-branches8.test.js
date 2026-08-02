/**
 * Final reachable-arm sweep for static/ui.js. Targets the remaining OR/ternary
 * arms in updateJourneyStopDelays / updateStopProgress (aTime-only + dTimeR-only
 * + null-time stops), the stationboard filter-path defaults (stbStop/prodX/
 * arrDur/depDur), the clickable-stop synthetic-loc `loc.name || '?'`, the
 * marker-click extId loop guard, the DEP dur ternaries, the focus live-branch
 * name/dir/stopL fallbacks, and the search matchScore / line-match / r.stop
 * arms. Each asserts an observable effect.
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
const subscribeBoard = vi.fn(() => Promise.resolve({}));
vi.mock('../../static/api.js', () => ({
  trackedFetch: (...a) => window.fetch(...a),
  api: {
    subscribeBoard: (...a) => subscribeBoard(...a),
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
  state._stationDepDur = 60;
  state._stationArrDur = 60;
  state._stationDepFetching = false;
  state._stationArrFetching = false;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('updateJourneyStopDelays — aTime-only depTime + null-parse arms', () => {
  function buildRows(n) {
    const list = document.createElement('ol');
    for (let i = 0; i < n; i++) {
      const li = document.createElement('li');
      li.className = 'stop-item';
      const dot = document.createElement('div');
      dot.className = 'stop-dot';
      const times = document.createElement('div');
      times.className = 'stop-times';
      li.append(dot, times);
      list.appendChild(li);
    }
    document.body.appendChild(list);
    ui.stopList = list;
    return list;
  }

  it('derives depTime from aTimeR/aTimeS when dTime is absent (later || arms)', () => {
    const list = buildRows(1);
    const stopL = [{ locX: 0, aTimeS: '095000', aTimeR: '095000' }]; // no dTime → aTimeR arm
    state._renderedStopSig = ui._stopSig(stopL);
    ui.updateJourneyStopDelays({ journey: { stopL } });
    expect(list.querySelector('.stop-dot').classList.contains('stop-dot--passed')).toBe(true);
  });

  it('leaves the dot untouched when the depTime is unparseable (stopMin null arm)', () => {
    const list = buildRows(1);
    const stopL = [{ locX: 0, dTimeS: 'junk' }];
    state._renderedStopSig = ui._stopSig(stopL);
    ui.updateJourneyStopDelays({ journey: { stopL } });
    expect(list.querySelector('.stop-dot').classList.contains('stop-dot--passed')).toBe(false);
  });
});

describe('updateStopProgress — dTimeR-only + aTime-only timeVal arms', () => {
  function buildList(centres) {
    document.body.innerHTML = '';
    const list = document.createElement('ol');
    list.getBoundingClientRect = () => ({ top: 0, left: 0, height: 500, width: 300 });
    centres.forEach((cy) => {
      const li = document.createElement('li');
      li.className = 'stop-item';
      const dot = document.createElement('span');
      dot.className = 'stop-dot';
      dot.getBoundingClientRect = () => ({ top: cy - 4, height: 8, left: 9, width: 8 });
      li.appendChild(dot);
      list.appendChild(li);
    });
    const prog = document.createElement('div');
    prog.id = 'stop-progress';
    list.appendChild(prog);
    document.body.appendChild(list);
    ui.stopList = list;
    return prog;
  }

  it('uses aTimeR/aTimeS for the progress time when dTime is absent', () => {
    const prog = buildList([10, 100]);
    // both times via aTimeS only (later || arm), both past → bar full
    ui.updateStopProgress([{ aTimeS: '090000' }, { aTimeR: '091000' }]);
    expect(prog.style.height).toBe('90px');
  });
});

describe('clickable stop — synthetic loc uses loc.name || "?"', () => {
  beforeEach(() => vi.useFakeTimers());

  it('opens a synthetic station board with "?" name when no cache matches and loc has no name', () => {
    state.allStops = new Map();
    ui.renderJourneyStops({
      journey: {
        stopL: [
          { locX: 0, dTimeS: '100000' },
          { locX: 1, dTimeS: '101000' },
        ],
      },
      // loc has a lid (so it's clickable) but no name → synthetic loc name '?'
      common: {
        locL: [{ lid: 'A=1@L=9@', extId: '', crd: { x: 8600000, y: 49300000 } }, { name: 'B' }],
      },
    });
    const sb = vi.spyOn(ui, 'showStationBoard').mockImplementation(() => {});
    ui.stopList.querySelector('.stop-name').click();
    expect(sb).toHaveBeenCalledWith(expect.objectContaining({ name: '?', lid: 'A=1@L=9@' }));
  });
});

describe('drawRoute marker click — extId loop guard (second same-extId entry)', () => {
  it('keeps the first extId match (guard `!cachedStop` false on the 2nd)', () => {
    const first = { extId: 'E1', name: 'A' };
    state.allStops = new Map([
      ['a', { data: first }],
      ['b', { data: { extId: 'E1', name: 'A2' } }],
    ]);
    const data = {
      common: {
        polyL: [{ crdEncYX: '' }], // empty → stopL >= 2 fallback path
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
    expect(sb).toHaveBeenCalledWith(first);
  });
});

describe('switchTab — re-subscribes the DEP board on move to departures', () => {
  it('re-subscribes the DEP board at the fixed 2h window', () => {
    state.selectedStop = { lid: 'A=1@L=1@' };
    state._activeStationBoardType = 'ARR'; // moving to DEP → newBoardType DEP
    state._stationDepData = { common: {}, jnyL: [] };
    vi.spyOn(ui, 'buildLineFilter').mockImplementation(() => {});
    ui.switchTab('departures');
    expect(subscribeBoard).toHaveBeenCalledWith('A=1@L=1@', 'DEP');
  });
});

describe('applyPushedStationboard — DEP push reconciles and re-renders', () => {
  it('renders a DEP push and adds the (4-arg) load-more button', () => {
    state.selectedStop = { lid: 'A=1@L=1@', extId: 'E1' };
    state._lastDepSig = null;
    state._stationExtId = 'E1';
    state._stationDepData = { jnyL: [], common: {} };
    state.serverTimeMin = 720;
    state.serverTimeStamp = Date.now();
    const render = vi.spyOn(ui, 'renderDepartures').mockImplementation(() => {});
    vi.spyOn(ui, 'buildLineFilter').mockImplementation(() => {});
    const lm = vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
    ui.applyPushedStationboard(
      { lid: 'A=1@L=1@', extId: 'E1' },
      { jnyL: [{ jid: 'A', stbStop: {} }], common: {} },
      'DEP',
    );
    expect(render).toHaveBeenCalled();
    expect(lm).toHaveBeenCalledWith('departure-list', expect.anything(), 'E1', 'DEP');
  });
});

describe('focusJourneyById — live-branch name/dir/stopL fallbacks', () => {
  beforeEach(() => {
    vi.spyOn(ui, '_disableFollow').mockImplementation(() => {});
    vi.spyOn(ui, 'setTabMode').mockImplementation(() => {});
    vi.spyOn(ui, 'switchTab').mockImplementation(() => {});
    vi.spyOn(ui, 'setPanelState').mockImplementation(() => {});
    vi.spyOn(ui, 'renderJourneyStops').mockImplementation(() => {});
    vi.spyOn(ui, 'drawRoute').mockImplementation(() => {});
    state.panelState = 'half';
    state.map = mapStub();
  });

  it('live journey with only prod.name and no dirTxt uses name + "?" fallbacks', async () => {
    getJourney.mockReturnValueOnce(
      Promise.resolve({
        journey: { pos: { x: 8610000, y: 49310000 }, stopL: [{ locX: 0, dTimeS: '100000' }] }, // no prodX, no dirTxt
        common: { prodL: [{ name: 'Bus 9' }], locL: [{ name: 'A' }] }, // journeyProd = prodL[undef]||prod||{}
      }),
    );
    ui.focusJourneyById('J', { name: 'Bus 9' }, true); // prod carries name only
    await settle();
    expect(ui.detailLine.textContent).toBe('Bus 9'); // journeyProd.nameS || journeyProd.name arm
    expect(ui.detailDir.textContent).toBe('?'); // dirTxt || '?'
  });
});

describe('search — matchScore found arm, line match, r.stop guard', () => {
  beforeEach(() => {
    document.body.innerHTML = '<input id="search-input" /><div id="search-results" hidden></div>';
    search.init();
    state.map = mapStub({ getCenter: () => ({ lat: 49.3, lng: 8.6 }) });
    search._searchSeq = 0;
    window.fetch = vi.fn(() => new Promise(() => {}));
  });

  it('matchScore increments for a found word (if true arm) — a matched stop is scored', () => {
    state.allStops = new Map([
      ['a', { data: { name: 'Sandhausen Markt', lat: 49.3, lon: 8.6, extId: 'E1', platform: '' } }],
    ]);
    search.doSearch('sandhausen markt'); // both words found → score 2
    expect(search._localStops[0].score).toBe(2);
  });

  it('a vehicle matching the exact line query is added (first OR arm true)', () => {
    state.vehicles = new Map([
      ['J', { data: { line: '55', lineFull: 'X', direction: 'D', delay: 0, stops: [] } }],
    ]);
    search.doSearch('55');
    expect(search._localLines.length).toBe(1);
  });

  it('remote stop merge records local extIds via the r.stop guard true arm', async () => {
    state.allStops = new Map([
      ['a', { data: { name: 'Sandhausen', lat: 49.34, lon: 8.66, extId: 'E1', platform: '' } }],
    ]);
    window.fetch = vi.fn((url) =>
      url.includes('/search?')
        ? Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                results: [{ name: 'Walldorf', lat: 49.3, lon: 8.64, extId: 'E5' }],
              }),
          })
        : new Promise(() => {}),
    );
    search.doSearch('sand');
    await settle();
    expect(search._asyncStops.map((r) => r.stop.extId)).toEqual(['E5']);
  });
});
