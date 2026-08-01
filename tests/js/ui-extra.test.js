/**
 * Mop-up coverage for the remaining branches/callbacks in static/ui.js that the
 * area-focused files don't reach: banner early-returns, follow/fitroute
 * moveend + timeout callbacks, selectStream .catch no-ops (driven by a rejected
 * subscribe), setTimeout navigating callbacks, midnight-wrap arms in the
 * passed-dot / progress / drawRoute split logic, renderArrivals extId platform
 * filtering + row formatting, and the search tie-break + fetch .catch arms.
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

// selectStream delegates to a reconfigurable impl so tests can force a rejection
// and exercise the many `.catch(function(){})` no-op arms.
let selectStreamImpl = () => Promise.resolve();
const getJourney = vi.fn(() => new Promise(() => {}));
const getStationBoard = vi.fn(() => new Promise(() => {}));
vi.mock('../../static/api.js', () => ({
  api: {
    getStationBoard: (...a) => getStationBoard(...a),
    getJourney: (...a) => getJourney(...a),
    selectStream: (...a) => selectStreamImpl(...a),
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

function settle() {
  return new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  selectStreamImpl = () => Promise.resolve();
  buildPanelDom();
  wireUiRefs(ui);
  state.serverTimeStamp = null;
  state.serverTimeMin = 600;
  state.map = mapStub();
  state.selectedJid = null;
  state.selectedStop = null;
  state._selectedStopMarker = null;
  state.followBus = false;
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

describe('banner early-returns', () => {
  it('showVersionUpdateBanner returns early when the banner is already visible', () => {
    const banner = document.createElement('div');
    banner.id = 'version-banner';
    banner.hidden = false; // already shown
    const reload = document.createElement('button');
    reload.className = 'version-banner__reload';
    banner.appendChild(reload);
    document.body.appendChild(banner);
    ui.showVersionUpdateBanner();
    expect(reload.onclick).toBeNull(); // wiring skipped
  });

  it('showVersionUpdateBanner is a no-op when the banner is absent', () => {
    expect(() => ui.showVersionUpdateBanner()).not.toThrow();
  });

  it('showTerminalBanner returns early when already visible', () => {
    const banner = document.createElement('div');
    banner.id = 'terminal-banner';
    banner.hidden = false;
    const reload = document.createElement('button');
    reload.className = 'version-banner__reload';
    banner.appendChild(reload);
    document.body.appendChild(banner);
    ui.showTerminalBanner();
    expect(reload.onclick).toBeNull();
  });

  it('showTerminalBanner is a no-op when the banner is absent', () => {
    expect(() => ui.showTerminalBanner()).not.toThrow();
  });
});

describe('follow / fitroute deferred callbacks', () => {
  beforeEach(() => {
    buildPanelDom();
    ui.init();
  });

  it('the nearby-bus follow pan clears _followPanning on moveend and after the timeout', () => {
    vi.useFakeTimers();
    state.selectedJid = 'J';
    state.vehicles = new Map([['J', { data: { lat: 49.5, lon: 8.8 } }]]);
    state.map = mapStub({ getCenter: () => ({ distanceTo: () => 1000 }) });
    document.getElementById('btn-follow').click();
    // invoke the registered moveend callback → _followPanning=false
    const cb = state.map.once.mock.calls.find((c) => c[0] === 'moveend')[1];
    state._followPanning = true;
    cb();
    expect(state._followPanning).toBe(false);
    // the 2500ms safety timeout also clears it
    state._followPanning = true;
    vi.advanceTimersByTime(2500);
    expect(state._followPanning).toBe(false);
  });

  it('fitroute clears _navigating on moveend and after its timeout', () => {
    vi.useFakeTimers();
    state.routeCoords = [
      [1, 2],
      [3, 4],
    ];
    window.innerWidth = 1400;
    document.getElementById('detail-panel').getBoundingClientRect = () => ({
      width: 360,
      top: 100,
    });
    document.getElementById('btn-fitroute').click();
    const cb = state.map.once.mock.calls.find((c) => c[0] === 'moveend')[1];
    state._navigating = true;
    cb();
    expect(state._navigating).toBe(false);
    state._navigating = true;
    vi.advanceTimersByTime(3000);
    expect(state._navigating).toBe(false);
  });
});

describe('selectStream .catch no-op arms (rejected subscribe)', () => {
  beforeEach(() => {
    selectStreamImpl = () => Promise.reject(new Error('subscribe failed'));
    vi.spyOn(ui, '_disableFollow').mockImplementation(() => {});
    vi.spyOn(ui, 'setTabMode').mockImplementation(() => {});
    vi.spyOn(ui, 'clearRoute').mockImplementation(() => {});
    vi.spyOn(ui, 'setPanelState').mockImplementation(() => {});
    state.panelState = 'half';
  });

  it('closePanel swallows a rejected unsubscribe', async () => {
    ui.closePanel();
    await settle();
    expect(state.selectedJid).toBeNull();
  });

  it('selectJourney swallows a rejected subscribe', async () => {
    ui.selectJourney({ jid: 'J', line: '721', direction: 'X', delay: null }, true);
    await settle();
    expect(state.selectedJid).toBe('J');
  });

  it('focusJourneyById swallows a rejected subscribe', async () => {
    ui.focusJourneyById('J', {}, true);
    await settle();
    expect(state.selectedJid).toBe('J');
  });

  it('switchTab swallows a rejected board re-subscribe', async () => {
    state.selectedStop = { lid: 'A=1@L=1@' };
    state._activeStationBoardType = 'DEP';
    ui.switchTab('arrivals');
    await settle();
    expect(state._activeStationBoardType).toBe('ARR');
  });
});

describe('navigating setTimeout callbacks', () => {
  beforeEach(() => {
    vi.spyOn(ui, '_disableFollow').mockImplementation(() => {});
    vi.spyOn(ui, 'setTabMode').mockImplementation(() => {});
    vi.spyOn(ui, 'switchTab').mockImplementation(() => {});
    vi.spyOn(ui, 'clearRoute').mockImplementation(() => {});
    vi.spyOn(ui, 'hideLineFilter').mockImplementation(() => {});
    vi.spyOn(ui, 'setPanelState').mockImplementation(() => {});
  });

  it('selectJourney resets _navigating after 600ms', () => {
    vi.useFakeTimers();
    getJourney.mockReturnValueOnce(new Promise(() => {}));
    ui.selectJourney({ jid: 'J', line: '721', direction: 'X', delay: null }, true);
    state._navigating = true;
    vi.advanceTimersByTime(600);
    expect(state._navigating).toBe(false);
  });

  it('showStationBoard resets _navigating after 600ms and removes an old stop marker', () => {
    vi.useFakeTimers();
    const remove = vi.fn();
    state._selectedStopMarker = { remove };
    vi.spyOn(ui, 'loadDepartures').mockReturnValue({ finally: () => {} });
    ui.showStationBoard({ lid: 'A=1@L=1@', name: 'S', lat: 49.3, lon: 8.6 }, true);
    expect(remove).toHaveBeenCalledOnce();
    state._navigating = true;
    vi.advanceTimersByTime(600);
    expect(state._navigating).toBe(false);
  });

  it('focusJourneyById resets _navigating after 600ms', () => {
    vi.useFakeTimers();
    getJourney.mockReturnValueOnce(new Promise(() => {}));
    ui.focusJourneyById('J', {}, true);
    state._navigating = true;
    vi.advanceTimersByTime(600);
    expect(state._navigating).toBe(false);
  });

  it('selectJourney removes an existing selected-stop marker', () => {
    getJourney.mockReturnValueOnce(new Promise(() => {}));
    const remove = vi.fn();
    state._selectedStopMarker = { remove };
    ui.selectJourney({ jid: 'J', line: '721', direction: 'X', delay: null }, true);
    expect(remove).toHaveBeenCalledOnce();
    expect(state._selectedStopMarker).toBeNull();
  });
});

describe('midnight-wrap arms', () => {
  it('renderJourneyStops marks a pre-dawn stop passed when now is late evening', () => {
    // now 23:00 (>1080), stop 00:30 (<360) → +1440 so it is future (not passed)
    state.serverTimeMin = 1380;
    vi.useFakeTimers();
    ui.renderJourneyStops({
      journey: {
        stopL: [
          { locX: 0, dTimeS: '223000' },
          { locX: 1, dTimeS: '003000' },
        ],
      },
      common: { locL: [{ name: 'A' }, { name: 'B' }] },
    });
    const dots = ui.stopList.querySelectorAll('.stop-dot');
    expect(dots[0].classList.contains('stop-dot--passed')).toBe(true); // 22:30 past
    expect(dots[1].classList.contains('stop-dot--passed')).toBe(false); // 00:30 next day
  });

  it('renderJourneyStops handles an early-morning now against a late-evening stop', () => {
    // now 02:00 (<360), stop 23:30 (>1080) → -1440 → treated as passed
    state.serverTimeMin = 120;
    vi.useFakeTimers();
    ui.renderJourneyStops({
      journey: {
        stopL: [
          { locX: 0, dTimeS: '233000' },
          { locX: 1, dTimeS: '021000' },
        ],
      },
      common: { locL: [{ name: 'A' }, { name: 'B' }] },
    });
    const dots = ui.stopList.querySelectorAll('.stop-dot');
    expect(dots[0].classList.contains('stop-dot--passed')).toBe(true);
  });

  it('updateStopProgress applies the late-evening wrap to stop times', () => {
    state.serverTimeMin = 1380; // 23:00
    const list = document.createElement('ol');
    list.getBoundingClientRect = () => ({ top: 0, left: 0, height: 500, width: 300 });
    [10, 100].forEach((cy) => {
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
    // stop 22:30 (past), stop 00:30 (<360 → +1440 future)
    ui.updateStopProgress([{ dTimeS: '223000' }, { dTimeS: '003000' }]);
    expect(list.style.getPropertyValue('--stop-track-top')).toBe('10px');
  });
});

describe('updateJourneyStopDelays — patch details', () => {
  beforeEach(() => {
    state.serverTimeMin = 600;
    state._renderedStopSig = null;
  });

  it('patches dot state + times and drops a legacy stop-delay child', () => {
    const list = document.createElement('ol');
    for (let i = 0; i < 2; i++) {
      const li = document.createElement('li');
      li.className = 'stop-item';
      const dot = document.createElement('div');
      dot.className = 'stop-dot';
      const info = document.createElement('div');
      info.className = 'stop-info';
      const times = document.createElement('div');
      times.className = 'stop-times';
      const dayBadge = document.createElement('span');
      dayBadge.className = 'departure-day-badge';
      times.appendChild(dayBadge);
      const legacy = document.createElement('span');
      legacy.className = 'stop-delay';
      info.append(times, legacy);
      li.append(dot, info);
      list.appendChild(li);
    }
    document.body.appendChild(list);
    ui.stopList = list;
    const stopL = [
      { locX: 0, dTimeS: '095000', dTimeR: '095000' },
      { locX: 1, dTimeS: '100000', dTimeR: '100000' },
    ];
    state._renderedStopSig = ui._stopSig(stopL);
    ui.updateJourneyStopDelays({ journey: { stopL } });
    // legacy direct-child delay removed; day badge preserved
    expect(list.querySelector('.stop-info > .stop-delay')).toBeNull();
    expect(list.querySelector('.departure-day-badge')).not.toBeNull();
    expect(list.querySelectorAll('.stop-dot')[0].classList.contains('stop-dot--passed')).toBe(true);
  });
});

describe('renderArrivals — extId platform filtering (mirror)', () => {
  const arrList = () => document.getElementById('arrival-list');
  beforeEach(() => {
    state._stationArrDur = 60;
    state._autoExpandingArr = false;
    state.vehicles = new Map();
  });

  it('filters to the exact extId when the loc has a platform', () => {
    const data = {
      jnyL: [
        { jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { locX: 0, aTimeS: '120000' } },
        { jid: 'B', prodX: 0, dirTxt: 'Y', stbStop: { locX: 1, aTimeS: '121000' } },
      ],
      common: { prodL: [{ nameS: '721' }], locL: [{ extId: 'E1' }, { extId: 'E2' }] },
    };
    ui.renderArrivals(data, { name: 'S', platform: '2' }, 'E1', null);
    expect(arrList().querySelectorAll('.departure-item').length).toBe(1);
  });

  it('filters when far sibling platforms exist (no explicit platform)', () => {
    const data = {
      jnyL: [{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { locX: 0, aTimeS: '120000' } }],
      common: {
        prodL: [{ nameS: '721' }],
        locL: [
          { extId: 'E1', name: 'S', crd: { x: 8600000, y: 49300000 } },
          { extId: 'E9', name: 'S', crd: { x: 8700000, y: 49400000 } },
        ],
      },
    };
    ui.renderArrivals(data, { name: 'S' }, 'E1', null);
    expect(arrList().querySelectorAll('.departure-item').length).toBe(1);
  });

  it('filters by name when the extId is unknown', () => {
    const data = {
      jnyL: [{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { locX: 0, aTimeS: '120000' } }],
      common: { prodL: [{ nameS: '721' }], locL: [{ extId: 'OTHER', name: 'S' }] },
    };
    ui.renderArrivals(data, { name: 'S' }, 'MISSING', null);
    expect(arrList().querySelector('.empty-state')).not.toBeNull();
  });

  it('applies a line filter to arrivals', () => {
    const data = {
      jnyL: [
        { jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { aTimeS: '120000' } },
        { jid: 'B', prodX: 1, dirTxt: 'Y', stbStop: { aTimeS: '121000' } },
      ],
      common: { prodL: [{ nameS: '721' }, { nameS: '705' }], locL: [] },
    };
    ui.renderArrivals(data, { name: 'S' }, '', '705');
    expect(arrList().querySelectorAll('.departure-item').length).toBe(1);
  });

  it('shows planned+real spans and a day-offset badge for a delayed next-day arrival', () => {
    const data = {
      jnyL: [
        {
          jid: 'A',
          prodX: 0,
          dirTxt: 'X',
          date: '20260201',
          stbStop: { aTimeS: '235500', aTimeR: '000500' },
        },
      ],
      common: { prodL: [{ nameS: '721' }], locL: [] },
      sD: '20260131',
    };
    ui.renderArrivals(data, { name: 'S' }, '', null);
    expect(arrList().querySelector('.stop-time-planned')).not.toBeNull();
    expect(arrList().querySelector('.departure-day-badge')).not.toBeNull();
  });

  it('renders every delay-colour branch (delayed, major, nodata)', () => {
    const data = {
      jnyL: [
        { jid: 'A', prodX: 0, dirTxt: 'D', stbStop: { aTimeS: '120000', aTimeR: '120400' } }, // +4 delayed
        { jid: 'B', prodX: 0, dirTxt: 'M', stbStop: { aTimeS: '121000', aTimeR: '122000' } }, // +10 major
        { jid: 'C', prodX: 0, dirTxt: 'N', stbStop: { aTimeS: '', aTimeR: '' } }, // no data
      ],
      common: { prodL: [{ nameS: '721' }], locL: [] },
    };
    ui.renderArrivals(data, { name: 'S' }, '', null);
    const colors = [...arrList().querySelectorAll('.departure-delay')].map((e) => e.style.color);
    expect(colors.some((c) => c.includes('delayed'))).toBe(true);
    expect(colors.some((c) => c.includes('major-delay'))).toBe(true);
    expect(colors.some((c) => c.includes('secondary'))).toBe(true);
  });

  it('an arrival row for an on-map bus selects it; an off-map one focuses by id', () => {
    state.vehicles = new Map([['ON', { data: { lat: 49.3, lon: 8.6, jid: 'ON' } }]]);
    const sel = vi.spyOn(ui, 'selectJourney').mockImplementation(() => {});
    const foc = vi.spyOn(ui, 'focusJourneyById').mockImplementation(() => {});
    const data = {
      jnyL: [
        { jid: 'ON', prodX: 0, dirTxt: 'X', stbStop: { aTimeS: '120000' } },
        { jid: 'OFF', prodX: 0, dirTxt: 'Y', stbStop: { aTimeS: '121000' } },
      ],
      common: { prodL: [{ nameS: '721' }], locL: [] },
    };
    ui.renderArrivals(data, { name: 'S' }, '', null);
    const rows = arrList().querySelectorAll('.departure-item');
    rows[0].click();
    rows[1].click();
    expect(sel).toHaveBeenCalled();
    expect(foc).toHaveBeenCalledWith('OFF', expect.any(Object));
  });
});

describe('renderDepartures — remaining delay colours', () => {
  it('renders delayed, major and nodata delay colours', () => {
    ui.departureList = document.getElementById('departure-list');
    state.vehicles = new Map();
    const data = {
      jnyL: [
        { jid: 'A', prodX: 0, dirTxt: 'D', stbStop: { dTimeS: '120000', dTimeR: '120400' } },
        { jid: 'B', prodX: 0, dirTxt: 'M', stbStop: { dTimeS: '121000', dTimeR: '122000' } },
        { jid: 'C', prodX: 0, dirTxt: 'N', stbStop: {} },
      ],
      common: { prodL: [{ nameS: '721' }], locL: [] },
    };
    ui.renderDepartures(data, { name: 'S' }, '', null);
    const colors = [...ui.departureList.querySelectorAll('.departure-delay')].map(
      (e) => e.style.color,
    );
    expect(colors.some((c) => c.includes('delayed'))).toBe(true);
    expect(colors.some((c) => c.includes('major-delay'))).toBe(true);
    expect(colors.some((c) => c.includes('secondary'))).toBe(true);
  });
});

describe('loadDepartures / loadArrivals — cascade edge + abort', () => {
  const loc = { lid: 'A=1@L=1@', name: 'S' };
  beforeEach(() => {
    vi.spyOn(ui, 'discoverPlatforms').mockImplementation(() => {});
    vi.spyOn(ui, 'buildLineFilter').mockImplementation(() => {});
    vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
  });

  it('loadDepartures bails when the stop is deselected before the response', async () => {
    // selectedStop changes before the response is consumed → the stop-changed
    // guard returns early and clears the in-flight flag.
    vi.spyOn(ui, 'renderDepartures').mockReturnValue([]);
    state.selectedStop = loc;
    state._stationDepCount = 0;
    getStationBoard.mockImplementation(() => {
      return Promise.resolve({ jnyL: [], common: {} });
    });
    const p = ui.loadDepartures(loc, '', 60, true);
    // flip selection so the guard inside the .then bails
    state.selectedStop = { lid: 'OTHER' };
    await p;
    await settle();
    expect(state._autoExpandingDep).toBe(false);
  });

  it('loadDepartures is silent on an AbortError', async () => {
    ui.departureList = document.getElementById('departure-list');
    getStationBoard.mockReturnValueOnce(Promise.reject({ name: 'AbortError' }));
    state.selectedStop = loc;
    await ui.loadDepartures(loc, '', 60, true);
    expect(ui.departureList.querySelector('.empty-state')).toBeNull();
  });

  it('loadArrivals bails when the stop is deselected before the response', async () => {
    vi.spyOn(ui, 'renderArrivals').mockReturnValue([]);
    state.selectedStop = loc;
    state._stationArrCount = 0;
    getStationBoard.mockResolvedValue({ jnyL: [], common: {} });
    const p = ui.loadArrivals(loc, '', 60, true);
    state.selectedStop = { lid: 'OTHER' };
    await p;
    await settle();
    expect(state._autoExpandingArr).toBe(false);
  });

  it('loadArrivals is silent on an AbortError', async () => {
    getStationBoard.mockReturnValueOnce(Promise.reject({ name: 'AbortError' }));
    state.selectedStop = loc;
    await ui.loadArrivals(loc, '', 60, true);
    expect(document.getElementById('arrival-list').querySelector('.empty-state')).toBeNull();
  });
});

describe('applyPushedStationboard — extId present branch', () => {
  it('uses loc.extId directly when present', () => {
    state.selectedStop = { lid: 'A=1@L=1@', extId: 'E1' };
    state._autoExpandingDep = false;
    state._autoExpandingArr = false;
    state._lastDepSig = null;
    state._stationDepDur = 60;
    const renderSpy = vi.spyOn(ui, 'renderDepartures').mockImplementation(() => {});
    vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
    const stop = { lid: 'A=1@L=1@', extId: 'E1' };
    ui.applyPushedStationboard(stop, { jnyL: [{ jid: 'A', stbStop: {} }], common: {} }, 'DEP');
    expect(renderSpy).toHaveBeenCalledWith(expect.anything(), stop, 'E1', null);
  });
});

describe('search — tie-break + fetch .catch arms', () => {
  beforeEach(() => {
    document.body.innerHTML = '<input id="search-input" /><div id="search-results" hidden></div>';
    search.init();
    state.map = mapStub({ getCenter: () => ({ lat: 49.3, lng: 8.6 }) });
    search._searchSeq = 0;
    window.fetch = vi.fn(() => new Promise(() => {}));
  });

  it('breaks a stop-score tie by distance to the map centre', () => {
    state.vehicles = new Map();
    state.allStops = new Map([
      ['a', { data: { name: 'Markt', lat: 49.9, lon: 8.9, extId: 'FAR', platform: '' } }],
      ['b', { data: { name: 'Markt', lat: 49.31, lon: 8.61, extId: 'NEAR', platform: '' } }],
    ]);
    search.doSearch('markt');
    // both score equally; the nearer stop sorts first
    expect(search._localStops[0].stop.extId).toBe('NEAR');
  });

  it('swallows a rejected line_search fetch', async () => {
    state.vehicles = new Map();
    window.fetch = vi.fn((url) =>
      url.includes('/line_search') ? Promise.reject(new Error('net')) : new Promise(() => {}),
    );
    search.doSearch('99');
    await settle();
    expect(search._asyncLines.length).toBe(0);
  });

  it('swallows a rejected stop search fetch', async () => {
    state.allStops = new Map();
    window.fetch = vi.fn((url) =>
      url.includes('/search?') ? Promise.reject(new Error('net')) : new Promise(() => {}),
    );
    search.doSearch('walldorf');
    await settle();
    expect(search._asyncStops.length).toBe(0);
  });
});

describe('drawRoute — split-index edge branches', () => {
  function encode(points, precision) {
    precision = precision || 1e5;
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
      const lat = Math.round(p[0] * precision);
      const lon = Math.round(p[1] * precision);
      out += enc(lat - last[0]) + enc(lon - last[1]);
      last = [lat, lon];
    });
    return out;
  }
  const coords = [
    [49.3, 8.6],
    [49.31, 8.61],
    [49.32, 8.62],
  ];

  beforeEach(() => {
    state.serverTimeMin = 600;
    state.routeStopMarkers = [];
    state.map = mapStub();
  });

  it('ignores an out-of-range ppLocRefL ppIdx and keeps the default split', () => {
    const data = {
      common: {
        polyL: [{ crdEncYX: encode(coords, 1e5), ppLocRefL: [{ locX: 0, ppIdx: 99 }] }],
        locL: [
          { name: 'A', crd: { x: 8600000, y: 49300000 } },
          { name: 'B', crd: { x: 8620000, y: 49320000 } },
        ],
      },
      journey: {
        stopL: [
          { locX: 0, dTimeS: '094000' },
          { locX: 1, dTimeS: '110000' },
        ],
      },
    };
    ui.drawRoute(data, { lat: 49.305, lon: 8.605, jid: 'J' });
    state.selectedJid = 'J';
    expect(state.routeCoords.length).toBe(3);
  });

  it('uses the nearest-point fallback with a late-evening wrap when ppLocRefL is empty', () => {
    state.serverTimeMin = 1380; // 23:00 → wrap arm for a 00:xx stop
    const data = {
      common: {
        polyL: [{ crdEncYX: encode(coords, 1e5) }], // no ppLocRefL
        locL: [
          { name: 'A', crd: { x: 8600000, y: 49300000 } },
          { name: 'B', crd: { x: 8620000, y: 49320000 } },
        ],
      },
      journey: {
        stopL: [
          { locX: 0, dTimeS: '223000' }, // 22:30 past
          { locX: 1, dTimeS: '003000' }, // 00:30 → +1440 future
        ],
      },
    };
    ui.drawRoute(data, { lat: 49.315, lon: 8.615 });
    expect(state.routeCoords.length).toBe(3);
    expect(L.polyline).toHaveBeenCalled();
  });
});
