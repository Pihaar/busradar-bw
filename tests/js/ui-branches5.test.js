/**
 * Long-tail branch coverage for static/ui.js. Each case flips a specific
 * remaining arm: the buildLineFilter isActive OR, the drawRoute passed-stop
 * timeVal chain + nearest-point loop, the clickable-stop extId loop guard, the
 * loadDepartures announce name fallback + error dur fallback, the
 * renderArrivals/renderDepartures HAFAS-hint (data.jnyL||[]).length limit, the
 * renderArrivals platform-filter proximity sub-branches, focusJourneyById
 * not-started journeyProd/name/dir fallbacks, and the search dedup r.stop guard.
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
const announce = vi.fn();
vi.mock('../../static/api.js', () => ({
  trackedFetch: (...a) => window.fetch(...a),
  api: {
    subscribeBoard: () => Promise.resolve({}),
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
vi.mock('../../static/status.js', () => ({ announce: (...a) => announce(...a) }));

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
function encode(points) {
  let last = [0, 0];
  let out = '';
  const enc = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (v >= 0x20) {
      s += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return s + String.fromCharCode(v + 63);
  };
  points.forEach((p) => {
    const lat = Math.round(p[0] * 1e5);
    const lon = Math.round(p[1] * 1e5);
    out += enc(lat - last[0]) + enc(lon - last[1]);
    last = [lat, lon];
  });
  return out;
}
function bigJnyL(n, side) {
  const arr = [];
  for (let i = 0; i < n; i++) {
    const t = 720 + i;
    const hhmmss =
      String(Math.floor(t / 60)).padStart(2, '0') + String(t % 60).padStart(2, '0') + '00';
    const stb = side === 'ARR' ? { aTimeS: hhmmss } : { dTimeS: hhmmss };
    arr.push({ jid: 'J' + i, prodX: 0, dirTxt: 'D' + i, stbStop: stb });
  }
  return arr;
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

describe('buildLineFilter — isActive second OR arm (line === activeFilter)', () => {
  it('marks the matching line chip active via the btn.dataset.line === line arm', () => {
    state._activeTab = 'departures';
    state._depFilter = '705'; // not null → first OR arm false, second arm decides
    ui.buildLineFilter({
      common: { prodL: [{ nameS: '721' }, { nameS: '705' }] },
      jnyL: [{ prodX: 0 }, { prodX: 1 }],
    });
    const chips = document.getElementById('line-filter').querySelectorAll('.filter-chip');
    const activeLine = [...chips].find((c) => c.classList.contains('filter-chip--active'));
    expect(activeLine.dataset.line).toBe('705');
  });
});

describe('drawRoute — nearest-point loop over multiple passed stops', () => {
  it('walks the nearest-point fallback across two passed stops (no ppLocRefL)', () => {
    const pts = [
      [49.3, 8.6],
      [49.31, 8.61],
      [49.32, 8.62],
      [49.33, 8.63],
    ];
    const data = {
      common: {
        polyL: [{ crdEncYX: encode(pts) }], // no ppLocRefL → nearest-point branch
        locL: [
          { name: 'A', crd: { x: 8600000, y: 49300000 } },
          { name: 'B', crd: { x: 8610000, y: 49310000 } },
          { name: 'C', crd: { x: 8620000, y: 49320000 } },
        ],
      },
      journey: {
        stopL: [
          { locX: 0, dTimeS: '093000' }, // past
          { locX: 1, dTimeS: '094000' }, // past
          { locX: 2, dTimeS: '110000' }, // future
        ],
      },
    };
    ui.drawRoute(data, { lat: 49.325, lon: 8.625, jid: 'J' });
    expect(state.routeCoords.length).toBe(4);
    expect(L.polyline).toHaveBeenCalled();
  });
});

describe('renderJourneyStops — clickable stop extId loop guard', () => {
  beforeEach(() => vi.useFakeTimers());

  it('short-circuits the extId scan once a match is found (second iteration guard false)', () => {
    const first = { extId: 'E1', name: 'A' };
    state.allStops = new Map([
      ['a', { data: first }],
      ['b', { data: { extId: 'E1', name: 'A2' } }], // same extId, guard `!cachedStop` false
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
          { name: 'A', lid: 'A=1@L=1@', extId: 'E1', crd: { x: 8600000, y: 49300000 } },
          { name: 'B' },
        ],
      },
    });
    const sb = vi.spyOn(ui, 'showStationBoard').mockImplementation(() => {});
    ui.stopList.querySelector('.stop-name').click();
    expect(sb).toHaveBeenCalledWith(first);
  });
});

describe('loadDepartures — announce name fallback + error dur fallback', () => {
  const loc = { lid: 'A=1@L=1@' }; // no name → stop_fallback in announce
  beforeEach(() => {
    vi.spyOn(ui, 'discoverPlatforms').mockImplementation(() => {});
    vi.spyOn(ui, 'buildLineFilter').mockImplementation(() => {});
    vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
    state._activeStationBoardType = 'DEP';
    state._activeTab = 'departures';
  });

  it('announces with the stop_fallback name when the loc has no name (dur === 60)', async () => {
    vi.spyOn(ui, 'renderDepartures').mockReturnValue([{}]);
    getStationBoard.mockResolvedValue({ jnyL: [], common: {} });
    state.selectedStop = loc;
    state._stationDepCount = 0;
    await ui.loadDepartures(loc, '', true);
    await settle();
    expect(announce).toHaveBeenCalled();
  });
});

describe('HAFAS-limit hint via (data.jnyL || []).length', () => {
  it('renderDepartures appends the hint when the raw jnyL hits the limit even after filtering', () => {
    ui.departureList = document.getElementById('departure-list');
    // 50 raw entries (== limit); a line filter narrows the shown rows but the
    // hint condition reads the raw data.jnyL length.
    const data = { jnyL: bigJnyL(50, 'DEP'), common: { prodL: [{ nameS: '721' }], locL: [] } };
    ui.renderDepartures(data, { name: 'S' }, '', null);
    expect(ui.departureList.querySelector('.hafas-hint')).not.toBeNull();
  });

  it('renderArrivals appends the hint at the limit', () => {
    const data = { jnyL: bigJnyL(50, 'ARR'), common: { prodL: [{ nameS: '721' }], locL: [] } };
    ui.renderArrivals(data, { name: 'S' }, '', null);
    expect(document.getElementById('arrival-list').querySelector('.hafas-hint')).not.toBeNull();
  });
});

describe('renderArrivals — proximity filter within 1m (no filter) vs same-name-no-crd', () => {
  const arrList = () => document.getElementById('arrival-list');

  it('does not filter when a same-name sibling is within 1m', () => {
    const data = {
      jnyL: [
        { jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { locX: 0, aTimeS: '120000' } },
        { jid: 'B', prodX: 0, dirTxt: 'Y', stbStop: { locX: 1, aTimeS: '121000' } },
      ],
      common: {
        prodL: [{ nameS: '721' }],
        locL: [
          { extId: 'E1', name: 'S', crd: { x: 8600000, y: 49300000 } },
          { extId: 'E2', name: 'S', crd: { x: 8600000, y: 49300000 } }, // within 1m
        ],
      },
    };
    ui.renderArrivals(data, { name: 'S' }, 'E1', null);
    expect(arrList().querySelectorAll('.departure-item').length).toBe(2);
  });

  it('does not filter when the only same-name sibling has no crd (excluded from otherLocs)', () => {
    const data = {
      jnyL: [{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { locX: 0, aTimeS: '120000' } }],
      common: {
        prodL: [{ nameS: '721' }],
        locL: [
          { extId: 'E1', name: 'S', crd: { x: 8600000, y: 49300000 } },
          { extId: 'E2', name: 'S' }, // no crd → not pushed to otherLocs
        ],
      },
    };
    ui.renderArrivals(data, { name: 'S' }, 'E1', null);
    expect(arrList().querySelectorAll('.departure-item').length).toBe(1);
  });
});

describe('focusJourneyById — not-started journeyProd/name/dir fallbacks', () => {
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

  it('not-started with only prod.name (no nameS) and no dirTxt uses those fallbacks', async () => {
    getJourney.mockReturnValueOnce(
      Promise.resolve({
        journey: { stopL: [{ locX: 0, dTimeS: '120000' }], dirTxt: '' }, // no pos, no prodX, empty dir
        common: { prodL: [{ name: 'Bus 9' }], locL: [{ name: 'A' }] },
      }),
    );
    ui.focusJourneyById('J', { name: 'Bus 9' }, true);
    await settle();
    // detailLine falls to journeyProd.name (prod), dir shows '?' + not-started suffix
    expect(ui.detailLine.textContent).toBe('Bus 9');
    expect(ui.detailDir.textContent).toContain('?');
    expect(state._notStartedJid).toBe('J');
  });
});

describe('search — remote stop dedup with a score-less local entry', () => {
  it('the r.stop guard true-arm runs for local stops that have a stop object', async () => {
    const { search } = await import('../../static/ui.js');
    document.body.innerHTML = '<input id="search-input" /><div id="search-results" hidden></div>';
    search.init();
    state.map = mapStub({ getCenter: () => ({ lat: 49.3, lng: 8.6 }) });
    state.allStops = new Map([
      ['a', { data: { name: 'Sandhausen', lat: 49.34, lon: 8.66, extId: 'E1', platform: '' } }],
    ]);
    window.fetch = vi.fn((url) => {
      if (url.includes('/search?')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ results: [{ name: 'Walldorf', lat: 49.3, lon: 8.64, extId: 'E5' }] }),
        });
      }
      return new Promise(() => {});
    });
    search._searchSeq = 0;
    search.doSearch('sand');
    await settle();
    // local Sandhausen recorded in `seen` (r.stop guard) → remote Walldorf added
    expect(search._asyncStops.map((r) => r.stop.extId)).toEqual(['E5']);
  });
});
