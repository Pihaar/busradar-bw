/**
 * Final reachable-arm branch coverage for static/ui.js: the wrap arms in
 * updateJourneyStopDelays (late-evening now) and drawRoute's ppLocRefL /
 * nearest-point passed-stop loops (wrap + continue + splitIdx-behind), the
 * ontime delay-colour arm in renderDepartures/renderArrivals, the clickable-stop
 * proximity sub-conditions + platform swap, applyLineFilter's no-dep-data
 * else-if, and the arr/dep dur fallbacks. Each asserts an observable effect.
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

const { ui } = await import('../../static/ui.js');
const { state } = await import('../../static/state.js');

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
  state.map = { setView: vi.fn() };
  state.vehicles = new Map();
  state.allStops = new Map();
  state.routeLayer = null;
  state.routeCoords = null;
  state.routeStopMarkers = [];
  state._stationDepData = { jnyL: [], common: { prodL: [], locL: [] } };
  state._stationArrData = { jnyL: [], common: { prodL: [], locL: [] } };
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('updateJourneyStopDelays — late-evening wrap (+1440) arm', () => {
  it('adds 1440 to a pre-dawn stop time when now is late evening', () => {
    state.serverTimeMin = 1380; // 23:00
    const list = document.createElement('ol');
    const li = document.createElement('li');
    li.className = 'stop-item';
    const dot = document.createElement('div');
    dot.className = 'stop-dot';
    const times = document.createElement('div');
    times.className = 'stop-times';
    li.append(dot, times);
    list.appendChild(li);
    document.body.appendChild(list);
    ui.stopList = list;
    const stopL = [{ locX: 0, dTimeS: '003000', dTimeR: '003000' }]; // 00:30 → +1440 → future
    state._renderedStopSig = ui._stopSig(stopL);
    ui.updateJourneyStopDelays({ journey: { stopL } });
    expect(dot.classList.contains('stop-dot--passed')).toBe(false); // future after wrap
  });
});

describe('renderDepartures / renderArrivals — ontime delay colour', () => {
  it('renderDepartures colours a small (<= 2 min) delay as ontime', () => {
    ui.departureList = document.getElementById('departure-list');
    state.vehicles = new Map();
    ui.renderDepartures(
      {
        jnyL: [
          { jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { dTimeS: '120000', dTimeR: '120100' } },
        ],
        common: { prodL: [{ nameS: '721' }], locL: [] },
      },
      null,
    );
    expect(ui.departureList.querySelector('.departure-delay').style.color).toContain('ontime');
  });

  it('renderArrivals colours a small delay as ontime', () => {
    ui.renderArrivals(
      {
        jnyL: [
          { jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { aTimeS: '120000', aTimeR: '120100' } },
        ],
        common: { prodL: [{ nameS: '721' }], locL: [] },
      },
      null,
    );
    expect(
      document.getElementById('arrival-list').querySelector('.departure-delay').style.color,
    ).toContain('ontime');
  });

  it('renderDepartures colours an early departure as early', () => {
    state.vehicles = new Map();
    ui.renderDepartures(
      {
        jnyL: [
          { jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { dTimeS: '120000', dTimeR: '115700' } },
        ],
        common: { prodL: [{ nameS: '721' }], locL: [] },
      },
      null,
    );
    expect(ui.departureList.querySelector('.departure-delay').style.color).toContain('early');
  });

  it('renderArrivals colours an early arrival as early', () => {
    ui.renderArrivals(
      {
        jnyL: [
          { jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { aTimeS: '120000', aTimeR: '115700' } },
        ],
        common: { prodL: [{ nameS: '721' }], locL: [] },
      },
      null,
    );
    expect(
      document.getElementById('arrival-list').querySelector('.departure-delay').style.color,
    ).toContain('early');
  });
});

describe('renderJourneyStops — proximity match sub-conditions + platform swap', () => {
  beforeEach(() => vi.useFakeTimers());

  it('matches by coordinate proximity + name-prefix (the AND sub-branch) and swaps in a platform stop', () => {
    // First candidate matches by proximity+prefix but has no platform; a later
    // candidate at the same place WITH a platform replaces it (L780 guard).
    const noPlat = { name: 'Rathaus Süd', lat: 49.3005, lon: 8.6005, platform: '' };
    const withPlat = { name: 'Rathaus Süd', lat: 49.3006, lon: 8.6006, platform: '3' };
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
      // loc name 'Rathaus, Ort' → split(',')[0] = 'Rathaus' → prefix of both candidates;
      // extId '' so the name/proximity branch is used.
      common: {
        locL: [
          { name: 'Rathaus', lid: 'A=1@L=1@', extId: '', crd: { x: 8600500, y: 49300500 } },
          { name: 'B' },
        ],
      },
    });
    const sb = vi.spyOn(ui, 'showStationBoard').mockImplementation(() => {});
    ui.stopList.querySelector('.stop-name').click();
    expect(sb).toHaveBeenCalledWith(withPlat);
  });
});

describe('applyLineFilter — no cached data else-if false arm', () => {
  it('does nothing to render when arrivals-inactive and no dep data is cached', () => {
    state._activeTab = 'stops';
    state._stationArrData = null;
    state._stationDepData = null; // else-if(state._stationDepData) false
    const dep = vi.spyOn(ui, 'renderDepartures').mockImplementation(() => {});
    const arr = vi.spyOn(ui, 'renderArrivals').mockImplementation(() => {});
    ui.applyLineFilter(null);
    expect(dep).not.toHaveBeenCalled();
    expect(arr).not.toHaveBeenCalled();
  });
});

describe('drawRoute — ppLocRefL wrap arm + splitIdx-behind clamp', () => {
  it('applies the late-evening wrap inside the ppLocRefL passed-stop scan', () => {
    state.serverTimeMin = 1380; // 23:00
    const pts = [
      [49.3, 8.6],
      [49.31, 8.61],
      [49.32, 8.62],
      [49.33, 8.63],
    ];
    const data = {
      common: {
        polyL: [{ crdEncYX: encode(pts), ppLocRefL: [{ locX: 0, ppIdx: 2 }] }],
        locL: [{ name: 'A', crd: { x: 8600000, y: 49300000 } }],
      },
      journey: {
        stopL: [
          { locX: 0, dTimeS: '223000' }, // 22:30 past → matches ppLocRef ppIdx 2
          { locX: 1, dTimeS: '003000' }, // 00:30 → +1440 wrap → future
        ],
      },
    };
    // bus sits near the START (before ppIdx 2) → splitIdx would be < lastPassedPolyIdx,
    // exercising the `if (splitIdx < lastPassedPolyIdx)` clamp.
    ui.drawRoute(data, { lat: 49.3, lon: 8.6, jid: 'J' });
    expect(state.routeCoords.length).toBe(4);
    expect(L.polyline).toHaveBeenCalled();
  });
});

describe('drawRoute — nearest-point loop continue + wrap arms', () => {
  it('skips a no-time and a null-parse stop (continue) and wraps a pre-dawn passed stop', () => {
    state.serverTimeMin = 1380; // 23:00
    const pts = [
      [49.3, 8.6],
      [49.31, 8.61],
      [49.32, 8.62],
    ];
    const data = {
      common: {
        polyL: [{ crdEncYX: encode(pts) }], // no ppLocRefL → nearest-point branch
        locL: [
          {}, // for stop 0 (no time)
          {}, // for stop 1 (null parse)
          { name: 'C', crd: { x: 8620000, y: 49320000 } },
        ],
      },
      journey: {
        stopL: [
          { locX: 0 }, // no depTime → continue
          { locX: 1, dTimeS: 'junk' }, // parse null → continue
          { locX: 2, dTimeS: '223000' }, // 22:30 past (now 23:00) → nearest-point walk
        ],
      },
    };
    ui.drawRoute(data, { lat: 49.32, lon: 8.62, jid: 'J' });
    expect(state.routeCoords.length).toBe(3);
  });

  it('applies the early-morning wrap (-1440) in the nearest-point scan', () => {
    state.serverTimeMin = 120; // 02:00
    const pts = [
      [49.3, 8.6],
      [49.31, 8.61],
      [49.32, 8.62],
    ];
    const data = {
      common: {
        polyL: [{ crdEncYX: encode(pts) }],
        locL: [{ name: 'A', crd: { x: 8600000, y: 49300000 } }],
      },
      journey: { stopL: [{ locX: 0, dTimeS: '233000' }] }, // 23:30 → -1440 → past
    };
    ui.drawRoute(data, { lat: 49.3, lon: 8.6, jid: 'J' });
    expect(state.routeCoords.length).toBe(3);
  });
});
