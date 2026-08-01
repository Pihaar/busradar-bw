/**
 * Reachable-arm closeout (round 10) for static/ui.js: the platform-swap
 * short-circuit (cachedStop already has a platform), applyLineFilter's
 * `line === null && dataset.line === ''` first-OR-arm, updateJourneyStopDelays
 * aTimeR-only + no-time dot arms, renderArrivals extId-unknown no-same-name
 * (shouldFilter stays false), switchTab unknown-tab (arrivals else-if false),
 * applyPushedStationboard loc with neither extId nor lid + ARR dur fallback,
 * and focusJourneyById live-position with no stopL. Behaviour assertions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildPanelDom, wireUiRefs } from './ui-dom.js';

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

const getJourney = vi.fn(() => new Promise(() => {}));
const getStationBoard = vi.fn(() => new Promise(() => {}));
const selectStream = vi.fn(() => Promise.resolve());
vi.mock('../../static/api.js', () => ({
  trackedFetch: (...a) => window.fetch(...a),
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

const { ui } = await import('../../static/ui.js');
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
  state._autoExpandingDep = false;
  state._autoExpandingArr = false;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('clickable stop — platform-swap short-circuit (cachedStop already has platform)', () => {
  beforeEach(() => vi.useFakeTimers());

  it('keeps the first platform-bearing match when a later match is also platform-bearing', () => {
    // Both candidates match by proximity+prefix and BOTH have a platform. After
    // the first sets cachedStop (with platform), the second hits
    // `!cachedStop || !cachedStop.platform` → both false → keep the first.
    const first = { name: 'Rathaus', lat: 49.3, lon: 8.6, platform: '1' };
    const second = { name: 'Rathaus', lat: 49.3, lon: 8.6, platform: '2' };
    state.allStops = new Map([
      ['a', { data: first }],
      ['b', { data: second }],
    ]);
    ui.renderJourneyStops({
      journey: {
        stopL: [
          { locX: 0, dTimeS: '100000' },
          { locX: 1, dTimeS: '101000' },
        ],
      },
      common: {
        locL: [
          { name: 'Rathaus', lid: 'A=1@L=1@', extId: '', crd: { x: 8600000, y: 49300000 } },
          { name: 'B' },
        ],
      },
    });
    const sb = vi.spyOn(ui, 'showStationBoard').mockImplementation(() => {});
    ui.stopList.querySelector('.stop-name').click();
    expect(sb).toHaveBeenCalledWith(first); // first kept, not overwritten
  });
});

describe('applyLineFilter — All chip active via (line === null && dataset.line === "")', () => {
  it('activates the empty-dataset All chip when line is null', () => {
    state._activeTab = 'departures';
    state._stationDepData = { jnyL: [] };
    state._stationLoc = { lid: 'A' };
    state._stationExtId = '1';
    vi.spyOn(ui, 'renderDepartures').mockImplementation(() => {});
    vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
    const filterEl = document.getElementById('line-filter');
    const all = document.createElement('button');
    all.className = 'filter-chip';
    all.dataset.line = '';
    const c705 = document.createElement('button');
    c705.className = 'filter-chip';
    c705.dataset.line = '705';
    filterEl.append(all, c705);
    ui.applyLineFilter(null);
    expect(all.classList.contains('filter-chip--active')).toBe(true);
    expect(c705.classList.contains('filter-chip--active')).toBe(false);
  });
});

describe('updateJourneyStopDelays — aTimeR-only depTime + no-time dot arms', () => {
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

  it('derives depTime from aTimeR when only it is set (third || arm)', () => {
    const list = buildRows(1);
    const stopL = [{ locX: 0, aTimeR: '095000' }]; // only aTimeR
    state._renderedStopSig = ui._stopSig(stopL);
    ui.updateJourneyStopDelays({ journey: { stopL } });
    expect(list.querySelector('.stop-dot').classList.contains('stop-dot--passed')).toBe(true);
  });

  it('leaves the dot untouched when the stop has no time at all (if(depTime) false)', () => {
    const list = buildRows(1);
    const stopL = [{ locX: 0 }]; // no time
    state._renderedStopSig = ui._stopSig(stopL);
    ui.updateJourneyStopDelays({ journey: { stopL } });
    expect(list.querySelector('.stop-dot').classList.contains('stop-dot--passed')).toBe(false);
  });
});

describe('renderArrivals — extId unknown, no same-name loc (shouldFilter stays false)', () => {
  it('does not filter when no loc shares the stop name', () => {
    const data = {
      jnyL: [{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { locX: 0, aTimeS: '120000' } }],
      common: { prodL: [{ nameS: '721' }], locL: [{ extId: 'OTHER', name: 'Different' }] },
    };
    ui.renderArrivals(data, { name: 'S' }, 'MISSING', null);
    expect(document.getElementById('arrival-list').querySelectorAll('.departure-item').length).toBe(
      1,
    );
  });
});

describe('switchTab — an unknown tab leaves all three panels hidden (arrivals else-if false)', () => {
  it('does not activate any tab for a bogus name', () => {
    ui.switchTab('bogus');
    expect(document.getElementById('tabpanel-stops').hidden).toBe(true);
    expect(document.getElementById('tabpanel-departures').hidden).toBe(true);
    expect(document.getElementById('tabpanel-arrivals').hidden).toBe(true);
    expect(state._activeTab).toBe('bogus');
  });
});

describe('applyPushedStationboard — loc with neither extId nor lid + ARR dur fallback', () => {
  it('leaves extId empty (else-if(loc.lid) false) and uses the ARR || 60 dur', () => {
    const stop = { name: 'S' }; // no extId, no lid → but selectedStop must match by lid
    state.selectedStop = stop; // selectedStop.lid === loc.lid (both undefined) → equal
    state._autoExpandingDep = false;
    state._autoExpandingArr = false;
    state._lastArrSig = null;
    state._stationArrDur = 0; // falsy → || 60
    const render = vi.spyOn(ui, 'renderArrivals').mockImplementation(() => {});
    const lm = vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
    ui.applyPushedStationboard(stop, { jnyL: [{ jid: 'A', stbStop: {} }], common: {} }, 'ARR');
    expect(render).toHaveBeenCalledWith(expect.anything(), stop, '', null);
    expect(lm).toHaveBeenCalledWith('arrival-list', stop, '', 60, 'ARR');
  });
});

describe('focusJourneyById — live position with no stopL (stopL || [] fallback)', () => {
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

  it('a live journey with a position but no stopL array uses the [] fallback (delay stays null)', async () => {
    getJourney.mockReturnValueOnce(
      Promise.resolve({
        journey: { pos: { x: 8610000, y: 49310000 }, dirTxt: 'Z', prodX: 0 }, // no stopL
        common: { prodL: [{ nameS: '721', name: 'Bus 721' }], locL: [] },
      }),
    );
    ui.focusJourneyById('J', {}, true);
    await settle();
    expect(state.map.setView).toHaveBeenCalledWith([49.31, 8.61], 15);
    expect(ui.renderJourneyStops).toHaveBeenCalled();
    expect(state._selectedHadPosJid).toBe('J');
  });
});
