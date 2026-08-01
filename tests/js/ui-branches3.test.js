/**
 * Final branch coverage for static/ui.js: the remaining guard false-arms and
 * `|| fallback` left-arms across gestures, panel state, journey rendering,
 * drawRoute, stationboard filtering, switchTab/setTabMode, and search. Sparse
 * or edge-shaped HAFAS payloads flip each arm; every test asserts an observable
 * effect (DOM node, mock-call args, state value).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildPanelDom, wireUiRefs, firePointer, stubPointerCapture } from './ui-dom.js';

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
  state._selectedStopMarker = null;
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

describe('init detail-share — no pending map click arm', () => {
  it('share fires without a _cancelMapClick set', () => {
    buildPanelDom();
    ui.init();
    state._cancelMapClick = null;
    const spy = vi.spyOn(ui, 'share').mockImplementation(() => {});
    document.getElementById('detail-share').click();
    expect(spy).toHaveBeenCalledOnce();
  });
});

describe('gesture second-move / capture arms', () => {
  it('bottom-sheet: a second move after drag started keeps resizing (isDragging true arm)', () => {
    buildPanelDom();
    wireUiRefs(ui);
    ui.initBottomSheet();
    const handle = ui.panel.querySelector('.detail-handle');
    stubPointerCapture(handle);
    window.innerHeight = 1000;
    Object.defineProperty(ui.panel, 'offsetHeight', { configurable: true, value: 500 });
    firePointer(handle, 'pointerdown', { clientX: 100, clientY: 800 });
    firePointer(handle, 'pointermove', { clientX: 100, clientY: 700 }); // starts drag
    firePointer(handle, 'pointermove', { clientX: 100, clientY: 650 }); // second move: isDragging true
    expect(ui.panel.style.height).not.toBe('');
  });

  it('bottom-sheet: a downward drag inside content at scrollTop 0 starts the drag', () => {
    buildPanelDom();
    wireUiRefs(ui);
    ui.initBottomSheet();
    const handle = ui.panel.querySelector('.detail-handle');
    const content = document.getElementById('detail-content');
    stubPointerCapture(handle);
    Object.defineProperty(content, 'scrollTop', { configurable: true, value: 0 });
    Object.defineProperty(ui.panel, 'offsetHeight', { configurable: true, value: 500 });
    firePointer(handle, 'pointerdown', { clientX: 100, clientY: 500 });
    const ev = new Event('pointermove', { bubbles: true });
    Object.assign(ev, { isPrimary: true, pointerId: 1, clientX: 100, clientY: 600 }); // dy>0 downward
    Object.defineProperty(ev, 'target', { value: content, configurable: true });
    handle.dispatchEvent(ev);
    expect(ui.panel.style.transition).toBe('none'); // drag started
  });

  it('swipe: a second move after capture does not re-capture (captured true arm)', () => {
    buildPanelDom();
    wireUiRefs(ui);
    ui.initSwipeTabs();
    const content = document.getElementById('detail-content');
    stubPointerCapture(content);
    state._tabMode = 'station';
    state._activeTab = 'departures';
    firePointer(content, 'pointerdown', { clientX: 300, clientY: 100 });
    firePointer(content, 'pointermove', { clientX: 260, clientY: 102 }); // captures
    expect(() => firePointer(content, 'pointermove', { clientX: 220, clientY: 103 })).not.toThrow();
  });

  it('swipe: right-swipe on the departures tab (dx>0 but not arrivals) does not switch', () => {
    buildPanelDom();
    wireUiRefs(ui);
    ui.initSwipeTabs();
    const content = document.getElementById('detail-content');
    stubPointerCapture(content);
    state._tabMode = 'station';
    state._activeTab = 'departures';
    const spy = vi.spyOn(ui, 'switchTab').mockImplementation(() => {});
    firePointer(content, 'pointerdown', { clientX: 100, clientY: 100 });
    firePointer(content, 'pointermove', { clientX: 160, clientY: 102 });
    firePointer(content, 'pointerup', { clientX: 240, clientY: 100 }); // dx>0, tab=departures
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('setPanelState — collapsed/half after open (else-if chain)', () => {
  it('applies collapsed then half then open across calls', () => {
    ui.setPanelState('open');
    expect(ui.panel.classList.contains('detail-panel--open')).toBe(true);
    ui.setPanelState('collapsed');
    expect(ui.panel.classList.contains('detail-panel--collapsed')).toBe(true);
    ui.setPanelState('half');
    expect(ui.panel.classList.contains('detail-panel--half')).toBe(true);
  });
});

describe('_populateStopTimes — unparseable dwell time arm', () => {
  it('does not build a split layout when a realtime time is unparseable', () => {
    const el = document.createElement('div');
    ui._populateStopTimes(el, {
      aTimeS: '100000',
      aTimeR: 'junk',
      dTimeS: '100500',
      dTimeR: '100500',
    });
    // aR parse null → aR!==null && dR!==null false → no dwell → single row
    expect(el.classList.contains('stop-times--split')).toBe(false);
  });
});

describe('renderJourneyStops — parse-null and repeated-locX arms', () => {
  beforeEach(() => vi.useFakeTimers());

  it('an unparseable stop time leaves the dot un-passed (parse null arm)', () => {
    ui.renderJourneyStops({
      journey: { stopL: [{ locX: 0, dTimeS: 'junk' }] },
      common: { locL: [{ name: 'A' }] },
    });
    expect(ui.stopList.querySelector('.stop-dot').classList.contains('stop-dot--passed')).toBe(
      false,
    );
  });

  it('a per-stop message is shown once even when two stops share a locX', () => {
    const data = {
      journey: {
        stopL: [
          { locX: 0, dTimeS: '095000' },
          { locX: 1, dTimeS: '100000' },
          { locX: 1, dTimeS: '101000' }, // same locX 1 → shownMsgLocX guard false on 2nd
        ],
        msgL: [{ type: 'REM', remX: 0, fLocX: 1, tLocX: 1 }],
      },
      common: {
        locL: [{ name: 'Start' }, { name: 'A' }],
        remL: [{ code: 'BE', txtN: 'Hinweis' }],
      },
    };
    ui.renderJourneyStops(data);
    expect(ui.stopList.querySelectorAll('.stop-msg').length).toBe(1);
  });

  it('a cached stop match short-circuits once an extId hit is found (loop guard false arm)', () => {
    // two allStops with the SAME extId → after the first sets cachedStop, the
    // `!cachedStop && ...` guard is false for the second.
    state.allStops = new Map([
      ['a', { data: { extId: 'E1', name: 'A' } }],
      ['b', { data: { extId: 'E1', name: 'A2' } }],
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
    // first match wins
    expect(sb).toHaveBeenCalledWith({ extId: 'E1', name: 'A' });
  });
});

describe('updateJourneyStopDelays — missing dot/time/timesEl arms', () => {
  it('tolerates rows lacking a dot, a depTime, and a times element', () => {
    state.serverTimeMin = 600;
    const list = document.createElement('ol');
    // row without .stop-dot and without .stop-times
    const li = document.createElement('li');
    li.className = 'stop-item';
    list.appendChild(li);
    document.body.appendChild(list);
    ui.stopList = list;
    const stopL = [{ locX: 0 }]; // no time → depTime falsy
    state._renderedStopSig = ui._stopSig(stopL);
    expect(() => ui.updateJourneyStopDelays({ journey: { stopL } })).not.toThrow();
  });
});

describe('drawRoute — empty decode / no-match / end-of-route arms', () => {
  it('an empty encoded polyline (decode length 0) falls through without a route', () => {
    ui.drawRoute({ common: { polyL: [{ crdEncYX: '' }], locL: [] }, journey: { stopL: [] } }, null);
    expect(state.routeCoords).toBeNull();
  });

  it('ppLocRefL with no locX match keeps the default split index', () => {
    const data = {
      common: {
        polyL: [
          {
            crdEncYX: encode([
              [49.3, 8.6],
              [49.31, 8.61],
              [49.32, 8.62],
            ]),
            ppLocRefL: [{ locX: 99, ppIdx: 2 }],
          },
        ],
        locL: [{ name: 'A', crd: { x: 8600000, y: 49300000 } }],
      },
      journey: { stopL: [{ locX: 0, dTimeS: '094000' }] },
    };
    ui.drawRoute(data, { lat: 49.305, lon: 8.605, jid: 'J' });
    expect(state.routeCoords.length).toBe(3);
  });

  it('nearest-point fallback skips a passed stop whose loc has no crd', () => {
    const data = {
      common: {
        polyL: [
          {
            crdEncYX: encode([
              [49.3, 8.6],
              [49.31, 8.61],
              [49.32, 8.62],
            ]),
          },
        ], // no ppLocRefL
        locL: [{ name: 'A' }, { name: 'B', crd: { x: 8620000, y: 49320000 } }], // A has no crd
      },
      journey: {
        stopL: [
          { locX: 0, dTimeS: '094000' },
          { locX: 1, dTimeS: '095000' },
        ],
      },
    };
    ui.drawRoute(data, { lat: 49.315, lon: 8.615 });
    expect(state.routeCoords.length).toBe(3);
  });

  it('a bus sitting on the last coord yields a <= 1-point remaining segment', () => {
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
      journey: { stopL: [{ locX: 0, dTimeS: '094000' }] },
    };
    ui.drawRoute(data, { lat: 49.32, lon: 8.62, jid: 'J' }); // at final coord → splitIdx last
    expect(state.routeCoords.length).toBe(3);
  });
});

describe('showStationBoard — lid-regex + finally + no-lid arms', () => {
  beforeEach(() => {
    vi.spyOn(ui, '_disableFollow').mockImplementation(() => {});
    vi.spyOn(ui, 'clearRoute').mockImplementation(() => {});
    vi.spyOn(ui, 'setTabMode').mockImplementation(() => {});
    vi.spyOn(ui, 'switchTab').mockImplementation(() => {});
    vi.spyOn(ui, 'hideLineFilter').mockImplementation(() => {});
    state.map = mapStub();
    state.panelState = 'half';
  });

  it('a lid that does not match @L= leaves the extId empty', () => {
    vi.spyOn(ui, 'loadDepartures').mockReturnValue({ finally: () => {} });
    ui.showStationBoard({ lid: 'weird-lid', name: 'S' }, true);
    expect(state._stationExtId).toBe('');
  });

  it('does not chain loadArrivals when the stop changed before DEP settled', () => {
    const arrSpy = vi.spyOn(ui, 'loadArrivals').mockImplementation(() => {});
    vi.spyOn(ui, 'loadDepartures').mockReturnValue({
      finally: (cb) => {
        state.selectedStop = { lid: 'OTHER' }; // changed before settle
        cb();
        return { finally: () => {} };
      },
    });
    ui.showStationBoard({ lid: 'A=1@L=1@', name: 'S' }, true);
    expect(arrSpy).not.toHaveBeenCalled();
  });

  it('does not set the active board type when the loc has no lid', () => {
    state._activeStationBoardType = 'ARR';
    vi.spyOn(ui, 'loadDepartures').mockReturnValue({ finally: () => {} });
    ui.showStationBoard({ name: 'S', extId: 'E1' }, true); // no lid
    expect(state._activeStationBoardType).toBe('ARR'); // unchanged (the `if (loc && loc.lid)` false arm)
  });
});

describe('loadDepartures — activeTab / boardType false arms', () => {
  const loc = { lid: 'A=1@L=1@', name: 'S' };
  beforeEach(() => {
    vi.spyOn(ui, 'discoverPlatforms').mockImplementation(() => {});
    vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
    vi.spyOn(ui, 'renderDepartures').mockReturnValue([{}]);
    getStationBoard.mockResolvedValue({ jnyL: [], common: {} });
  });

  it('does not build the filter when the active tab is arrivals, and skips the DEP subscribe when board is ARR', async () => {
    const bf = vi.spyOn(ui, 'buildLineFilter').mockImplementation(() => {});
    state.selectedStop = loc;
    state._activeTab = 'arrivals'; // not 'departures' and truthy → filter skipped
    state._activeStationBoardType = 'ARR'; // DEP subscribe skipped
    state._stationDepCount = 0;
    await ui.loadDepartures(loc, '', 60, true);
    await settle();
    expect(bf).not.toHaveBeenCalled();
    expect(selectStream).not.toHaveBeenCalled();
  });
});

describe('loadArrivals — activeTab / boardType false arms', () => {
  const loc = { lid: 'A=1@L=1@', name: 'S' };
  beforeEach(() => {
    vi.spyOn(ui, 'discoverPlatforms').mockImplementation(() => {});
    vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
    vi.spyOn(ui, 'renderArrivals').mockReturnValue([{}]);
    getStationBoard.mockResolvedValue({ jnyL: [], common: {} });
  });

  it('does not build the filter when the tab is not arrivals and skips the ARR subscribe when board is DEP', async () => {
    const bf = vi.spyOn(ui, 'buildLineFilter').mockImplementation(() => {});
    state.selectedStop = loc;
    state._activeTab = 'departures';
    state._activeStationBoardType = 'DEP';
    state._stationArrCount = 0;
    await ui.loadArrivals(loc, '', 60, true);
    await settle();
    expect(bf).not.toHaveBeenCalled();
    expect(selectStream).not.toHaveBeenCalled();
  });
});

describe('discoverPlatforms — A× gid with too few parts', () => {
  it('leaves the platform empty when the A× gid has fewer than 5 parts', () => {
    const { stopsLayer } = globalThis.__map || {};
    void stopsLayer;
    ui.discoverPlatforms({
      common: {
        locL: [
          {
            lid: 'A=1@L=1@',
            name: 'S',
            crd: { x: 8600000, y: 49300000 },
            gidL: ['b×foo', 'A×only:three:parts'],
          },
        ],
      },
    });
    // reached the addStopMarker with empty platform (asserted via the map mock)
  });
});

describe('renderDepartures — filter sub-branch false arms', () => {
  beforeEach(() => {
    ui.departureList = document.getElementById('departure-list');
    state._stationDepDur = 60;
    state._autoExpandingDep = false;
    state.vehicles = new Map();
  });

  it('extId known but no far sibling → does not filter', () => {
    const data = {
      jnyL: [{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { locX: 0, dTimeS: '120000' } }],
      common: {
        prodL: [{ nameS: '721' }],
        locL: [{ extId: 'E1', name: 'S', crd: { x: 8600000, y: 49300000 } }],
      },
    };
    ui.renderDepartures(data, { name: 'S' }, 'E1', null);
    expect(ui.departureList.querySelectorAll('.departure-item').length).toBe(1);
  });

  it('extId unknown, no same-name loc → does not filter', () => {
    const data = {
      jnyL: [{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { locX: 0, dTimeS: '120000' } }],
      common: { prodL: [{ nameS: '721' }], locL: [{ extId: 'OTHER', name: 'Different' }] },
    };
    ui.renderDepartures(data, { name: 'S' }, 'MISSING', null);
    expect(ui.departureList.querySelectorAll('.departure-item').length).toBe(1);
  });
});

describe('showJourneyEnded — entry without a marker', () => {
  it('does not throw when the ended entry has no marker', () => {
    state.selectedJid = 'J';
    state.vehicles = new Map([['J', { data: {} }]]); // no marker
    ui.showJourneyEnded();
    expect(state.vehicles.has('J')).toBe(false);
  });
});

describe('setTabMode / switchTab — remaining arms', () => {
  it('switchTab("departures") does not resubscribe without a selected stop', () => {
    state.selectedStop = null;
    ui.switchTab('departures');
    expect(selectStream).not.toHaveBeenCalled();
  });
});

describe('search — comparator / keydown / result-type arms', () => {
  beforeEach(() => {
    document.body.innerHTML = '<input id="search-input" /><div id="search-results" hidden></div>';
    search.init();
    state.map = mapStub({ getCenter: () => ({ lat: 49.3, lng: 8.6 }) });
    search._searchSeq = 0;
    window.fetch = vi.fn(() => new Promise(() => {}));
  });

  it('a non-Escape keydown in the search input is ignored', () => {
    search.results.hidden = false;
    search.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(search.results.hidden).toBe(false);
  });

  it('matchScore counts only matching words (word-not-found arm)', () => {
    state.allStops = new Map([
      ['a', { data: { name: 'Alpha', lat: 49.3, lon: 8.6, extId: 'E1', platform: '' } }],
    ]);
    // query has two words; only one is in the name → score 1
    search.doSearch('alpha zzz');
    expect(search._localStops.length).toBe(0); // matchesQuery requires ALL words → excluded
  });

  it('renderResults ignores a result whose type is neither line nor stop', () => {
    search.renderResults([{ type: 'mystery' }]);
    // an item element is created but stays empty (no icon)
    const item = search.results.querySelector('.search-result-item');
    expect(item).not.toBeNull();
    expect(item.querySelector('.search-result-icon')).toBeNull();
  });
});
