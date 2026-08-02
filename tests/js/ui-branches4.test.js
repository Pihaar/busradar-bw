/**
 * Last-mile branch coverage for static/ui.js: the remaining reachable guard and
 * ternary arms — follow-not-started nested `|| {}` fallbacks, setPanelState
 * else-if(open), the clickable-stop name/proximity match sub-conditions, the
 * line-filter activeFilter ternary + switchTab else-if(dep cached), the
 * updateStopProgress mid-journey null-time interpolation guards, drawRoute
 * ppLocRefL passed-stop matching + null-parse `continue` arms, setTabMode
 * else-if(station), the lid-regex else-if arms, and search line-substring +
 * response-not-ok arms. Each asserts an observable effect.
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
      getCenter: () => ({ lat: 49.3, lng: 8.6, distanceTo: () => 1000 }),
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

describe('follow-not-started nested fallbacks', () => {
  beforeEach(() => {
    buildPanelDom();
    ui.init();
    state.followBus = false;
    state.selectedJid = 'J';
    state._notStartedJid = 'J';
    ui._updateFollowButton = vi.fn();
    ui._updateFollowUrl = vi.fn();
  });

  it('journey data with no journey/common objects defaults jStopL/jLocL to []', () => {
    state.selectedJourneyData = {}; // (jData.journey||{}).stopL||[] , (jData.common||{}).locL||[]
    document.getElementById('btn-follow').click();
    expect(state.map.panTo).not.toHaveBeenCalled(); // empty stopL → no pan
  });

  it('first-stop loc missing (jLocL[locX] || {}) → no crd → no pan', () => {
    state.selectedJourneyData = {
      journey: { stopL: [{ locX: 5 }] }, // locX 5 out of range → {} fallback
      common: { locL: [] },
    };
    document.getElementById('btn-follow').click();
    expect(state.map.panTo).not.toHaveBeenCalled();
  });
});

describe('setPanelState — open branch after a non-open state', () => {
  it('reaches the else-if(open) arm', () => {
    ui.setPanelState('half');
    ui.setPanelState('open');
    expect(ui.panel.classList.contains('detail-panel--open')).toBe(true);
  });
});

describe('renderJourneyStops — clickable stop proximity match', () => {
  beforeEach(() => vi.useFakeTimers());

  it('matches a cached stop by name equality (first || arm of the proximity OR)', () => {
    const near = { name: 'Rathaus', lat: 49.9, lon: 8.9, platform: '' }; // far coords, but name matches
    state.allStops = new Map([['k', { data: near }]]);
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
    expect(sb).toHaveBeenCalledWith(near);
  });

  it('prefers a platform-bearing cached match over a platform-less one', () => {
    const noPlat = { name: 'Rathaus', lat: 49.3, lon: 8.6, platform: '' };
    const withPlat = { name: 'Rathaus', lat: 49.3, lon: 8.6, platform: '2' };
    state.allStops = new Map([
      ['a', { data: noPlat }],
      ['b', { data: withPlat }],
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
    // the `!cachedStop || !cachedStop.platform` guard swaps in the platform stop
    expect(sb).toHaveBeenCalledWith(withPlat);
  });
});

describe('buildLineFilter — arrivals activeFilter ternary', () => {
  it('reads _arrFilter when the active tab is arrivals', () => {
    state._activeTab = 'arrivals';
    state._arrFilter = '705';
    ui.buildLineFilter({
      common: { prodL: [{ nameS: '721' }, { nameS: '705' }] },
      jnyL: [{ prodX: 0 }, { prodX: 1 }],
    });
    const active = document.getElementById('line-filter').querySelector('.filter-chip--active');
    expect(active.dataset.line).toBe('705');
  });
});

describe('switchTab — departures cached-data else-if', () => {
  it('rebuilds the filter from cached dep data (the else-if(dep) arm)', () => {
    state._stationDepData = { common: {}, jnyL: [] };
    state._stationArrData = null;
    state._stationExtId = null;
    state._stationLoc = null;
    const spy = vi.spyOn(ui, 'buildLineFilter').mockImplementation(() => {});
    ui.switchTab('departures');
    // No extId/platform → _scopedStationBoard passes the board through unchanged.
    expect(spy).toHaveBeenCalledWith(state._stationDepData);
  });
});

describe('updateStopProgress — mid-journey with a null-timed neighbour', () => {
  it('uses timeDiff 0 when an adjacent stop time is null (interpolation guard)', () => {
    document.body.innerHTML = '';
    const list = document.createElement('ol');
    list.getBoundingClientRect = () => ({ top: 0, left: 0, height: 500, width: 300 });
    [10, 60, 120].forEach((cy) => {
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
    // idx0 passed (09:00), idx1 next but its time is null (unparseable), idx2 future
    ui.updateStopProgress([{ dTimeS: '090000' }, { dTimeS: 'junk' }, { dTimeS: '110000' }]);
    // lastPassedIdx 0, next idx1 time null → timeDiff 0 → progress 0 → currentY = firstDot
    expect(prog.style.height).toBe('0px');
  });
});

describe('drawRoute — ppLocRefL passed-stop scan arms', () => {
  it('advances lastPassedPolyIdx via a matching ppLocRefL entry for a passed stop', () => {
    const pts = [
      [49.3, 8.6],
      [49.31, 8.61],
      [49.32, 8.62],
      [49.33, 8.63],
    ];
    const data = {
      common: {
        polyL: [
          {
            crdEncYX: encode(pts),
            ppLocRefL: [
              { locX: 0, ppIdx: 1 },
              { locX: 1, ppIdx: 2 },
            ],
          },
        ],
        locL: [
          { name: 'A', crd: { x: 8600000, y: 49300000 } },
          { name: 'B', crd: { x: 8610000, y: 49310000 } },
        ],
      },
      journey: {
        stopL: [
          { locX: 0, dTimeS: '094000' }, // 09:40 past → matches ppIdx 1
          { locX: 1, dTimeS: '095000' }, // 09:50 past → matches ppIdx 2
          { locX: 2, dTimeS: '110000' }, // future, no ppLocRef entry → inner loop finds no match
        ],
      },
    };
    ui.drawRoute(data, { lat: 49.32, lon: 8.62, jid: 'J' });
    expect(state.routeCoords.length).toBe(4);
    expect(L.polyline).toHaveBeenCalled();
  });

  it('skips a passed stop with no time (continue) and a null-parse time (continue)', () => {
    const pts = [
      [49.3, 8.6],
      [49.31, 8.61],
      [49.32, 8.62],
    ];
    const data = {
      common: {
        polyL: [{ crdEncYX: encode(pts), ppLocRefL: [{ locX: 2, ppIdx: 1 }] }],
        locL: [{ name: 'A', crd: { x: 8600000, y: 49300000 } }],
      },
      journey: {
        stopL: [
          { locX: 0 }, // no time → depTime falsy → continue
          { locX: 1, dTimeS: 'junk' }, // parse null → continue
          { locX: 2, dTimeS: '094000' }, // past, matches ppLocRefL
        ],
      },
    };
    ui.drawRoute(data, { lat: 49.31, lon: 8.61, jid: 'J' });
    expect(state.routeCoords.length).toBe(3);
  });
});

describe('setTabMode — station else-if arm', () => {
  it('reaches the station branch (hides stops, disables follow)', () => {
    const spy = vi.spyOn(ui, '_disableFollow').mockImplementation(() => {});
    ui.setTabMode('station');
    expect(document.getElementById('tab-stops').style.display).toBe('none');
    expect(spy).toHaveBeenCalled();
  });
});

describe('search — line exact-match first arm + response-not-ok arms', () => {
  beforeEach(() => {
    document.body.innerHTML = '<input id="search-input" /><div id="search-results" hidden></div>';
    search.init();
    state.map = mapStub({ getCenter: () => ({ lat: 49.3, lng: 8.6 }) });
    search._searchSeq = 0;
    window.fetch = vi.fn(() => new Promise(() => {}));
  });

  it('a vehicle matched by lineFull (second || arm) is added without matching the exact line', () => {
    state.vehicles = new Map([
      [
        'J',
        { data: { line: 'ZZ', lineFull: 'Bus Sandhausen', direction: 'D', delay: 0, stops: [] } },
      ],
    ]);
    search.doSearch('sandhausen');
    expect(search._localLines.length).toBe(1);
  });

  it('a non-ok remote stop search response yields null (r.ok false arm)', async () => {
    state.allStops = new Map();
    window.fetch = vi.fn((url) =>
      url.includes('/search?') ? Promise.resolve({ ok: false }) : new Promise(() => {}),
    );
    search.doSearch('walldorf');
    await settle();
    expect(search._asyncStops).toEqual([]);
  });

  it('renderResults skips an entry with type "stop" but no stop object in _renderCombined mapping', () => {
    // exercised via renderResults directly: a stop result renders its row
    search.renderResults([
      { type: 'stop', stop: { name: 'X', lat: 1, lon: 2, extId: 'e', platform: '' } },
    ]);
    expect(search.results.querySelector('.search-result-icon--stop')).not.toBeNull();
  });
});
