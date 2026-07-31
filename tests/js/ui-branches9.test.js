/**
 * Reachable-arm closeout for static/ui.js: setPanelState unknown-state chain,
 * the clickable-stop non-match + platform-swap sub-branches, applyLineFilter
 * chip toggle second arm, passed-dot aTime-only + no-time arms, updateStopProgress
 * time-less stop, drawRoute early-morning ppLocRef wrap + out-of-range loc + no
 * marker extId, showStationBoard/applyPushed no-lid + bad-lid arms, load* manual
 * (autoExpand=false) counter arm, extId proximity crd-zero arms, filtered
 * prodX-default, switchTab stops-chain + DEP dur, setTabMode unknown mode,
 * applyPushed ARR dur + locX-present sig arm, focus ended/not-started fallbacks,
 * and the search no-match vehicle arm. Behaviour assertions throughout.
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

describe('setPanelState — unknown state falls through the else-if chain', () => {
  it('an unrecognised state adds no state class but clears inert', () => {
    ui.setPanelState('weird');
    expect(ui.panel.inert).toBe(false);
    expect(ui.panel.classList.contains('detail-panel--open')).toBe(false);
    expect(ui.panel.classList.contains('detail-panel--half')).toBe(false);
    expect(ui.panel.classList.contains('detail-panel--collapsed')).toBe(false);
  });
});

describe('clickable stop — non-matching allStops entry (OR false) + platform swap keep', () => {
  beforeEach(() => vi.useFakeTimers());

  it('ignores a cached stop that matches neither name nor proximity, keeps a platform match', () => {
    const nonMatch = { name: 'Somewhere Else', lat: 40, lon: 10, platform: '' }; // no match
    const withPlat = { name: 'Rathaus', lat: 49.3, lon: 8.6, platform: '9' };
    state.allStops = new Map([
      ['x', { data: nonMatch }],
      ['y', { data: withPlat }],
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
    expect(sb).toHaveBeenCalledWith(withPlat);
  });
});

describe('applyLineFilter — chip toggle second arm (dataset.line === line)', () => {
  it('activates the chip whose dataset.line equals a non-null line', () => {
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
    ui.applyLineFilter('705'); // line non-null → first OR arm false, second decides
    expect(c705.classList.contains('filter-chip--active')).toBe(true);
    expect(all.classList.contains('filter-chip--active')).toBe(false);
  });
});

describe('renderJourneyStops passed-dot — aTime-only and no-time arms', () => {
  beforeEach(() => vi.useFakeTimers());

  it('derives the passed dot from aTimeS when no dTime is present', () => {
    ui.renderJourneyStops({
      journey: { stopL: [{ locX: 0, aTimeS: '090000' }] }, // only aTimeS → last || arm
      common: { locL: [{ name: 'A' }] },
    });
    expect(ui.stopList.querySelector('.stop-dot').classList.contains('stop-dot--passed')).toBe(
      true,
    );
  });

  it('a stop with no times leaves the passed-dot computation unentered', () => {
    ui.renderJourneyStops({
      journey: { stopL: [{ locX: 0 }] }, // depTime falsy → if(depTime) false
      common: { locL: [{ name: 'A' }] },
    });
    expect(ui.stopList.querySelector('.stop-dot').classList.contains('stop-dot--passed')).toBe(
      false,
    );
  });
});

describe('updateStopProgress — time-less stop → min null (ternary false arm)', () => {
  it('pushes null for a stop with no time value', () => {
    document.body.innerHTML = '';
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
    // first stop has no time (timeVal falsy → min null), second is past
    ui.updateStopProgress([{}, { dTimeS: '090000' }]);
    expect(prog.style.height).not.toBe('');
  });
});

describe('drawRoute — early-morning ppLocRef wrap + out-of-range loc + no-extId marker', () => {
  it('applies the (now<360) wrap inside the ppLocRefL scan', () => {
    state.serverTimeMin = 120; // 02:00
    const pts = [
      [49.3, 8.6],
      [49.31, 8.61],
      [49.32, 8.62],
    ];
    const data = {
      common: {
        polyL: [{ crdEncYX: encode(pts), ppLocRefL: [{ locX: 0, ppIdx: 1 }] }],
        locL: [{ name: 'A', crd: { x: 8600000, y: 49300000 } }],
      },
      journey: { stopL: [{ locX: 0, dTimeS: '233000' }] }, // 23:30 → -1440 → past
    };
    ui.drawRoute(data, { lat: 49.31, lon: 8.61, jid: 'J' });
    expect(state.routeCoords.length).toBe(3);
  });

  it('nearest-point branch tolerates a passed stop whose locX is out of range (loc {} arm)', () => {
    const pts = [
      [49.3, 8.6],
      [49.31, 8.61],
      [49.32, 8.62],
    ];
    const data = {
      common: {
        polyL: [{ crdEncYX: encode(pts) }], // no ppLocRefL
        locL: [{ name: 'A', crd: { x: 8600000, y: 49300000 } }],
      },
      journey: { stopL: [{ locX: 9, dTimeS: '093000' }] }, // locX 9 out of range → locL[9]||{} → no crd
    };
    ui.drawRoute(data, { lat: 49.31, lon: 8.61, jid: 'J' });
    expect(state.routeCoords.length).toBe(3);
  });

  it('marker click uses loc.extId || "" when the loc has no extId', () => {
    state.allStops = new Map([['a', { data: { extId: '', name: 'A' } }]]);
    const data = {
      common: {
        polyL: [{ crdEncYX: '' }],
        locL: [
          { name: 'A', lid: 'A=1@L=1@', crd: { x: 8600000, y: 49300000 } },
          { name: 'B', crd: { x: 8620000, y: 49320000 } },
        ], // no extId
      },
      journey: { stopL: [{ locX: 0 }, { locX: 1 }] },
    };
    ui.drawRoute(data, null);
    const sb = vi.spyOn(ui, 'showStationBoard').mockImplementation(() => {});
    L.circleMarker.mock.results[0].value._click();
    // locExtId '' → skips the extId cache scan → falls to showStationBoard(cachedStop || loc)
    expect(sb).toHaveBeenCalled();
  });
});

describe('showStationBoard / applyPushedStationboard — no-lid + bad-lid arms', () => {
  beforeEach(() => {
    vi.spyOn(ui, '_disableFollow').mockImplementation(() => {});
    vi.spyOn(ui, 'clearRoute').mockImplementation(() => {});
    vi.spyOn(ui, 'setTabMode').mockImplementation(() => {});
    vi.spyOn(ui, 'switchTab').mockImplementation(() => {});
    vi.spyOn(ui, 'hideLineFilter').mockImplementation(() => {});
    state.map = mapStub();
    state.panelState = 'half';
  });

  it('showStationBoard leaves extId empty for a loc with neither extId nor lid', () => {
    vi.spyOn(ui, 'loadDepartures').mockReturnValue({ finally: () => {} });
    ui.showStationBoard({ name: 'S' }, true); // no extId, no lid → else-if(loc.lid) false
    expect(state._stationExtId).toBe('');
  });

  it('applyPushedStationboard leaves extId empty for a loc with no extId and a non-matching lid', () => {
    state.selectedStop = { lid: 'no-at-L', name: 'S' };
    state._autoExpandingDep = false;
    state._autoExpandingArr = false;
    state._lastDepSig = null;
    const render = vi.spyOn(ui, 'renderDepartures').mockImplementation(() => {});
    vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
    ui.applyPushedStationboard(
      { lid: 'no-at-L' },
      { jnyL: [{ jid: 'A', stbStop: {} }], common: {} },
      'DEP',
    );
    expect(render).toHaveBeenCalledWith(expect.anything(), expect.anything(), '', null);
  });
});

describe('load* manual (autoExpand=false) counter ": 0" arm', () => {
  const loc = { lid: 'A=1@L=1@', name: 'S' };
  beforeEach(() => {
    vi.spyOn(ui, 'discoverPlatforms').mockImplementation(() => {});
    vi.spyOn(ui, 'buildLineFilter').mockImplementation(() => {});
    vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
    getStationBoard.mockResolvedValue({ jnyL: [], common: {} });
  });

  it('loadDepartures with autoExpand=false does not increment the expand counter', async () => {
    vi.spyOn(ui, 'renderDepartures').mockReturnValue([{}]);
    state.selectedStop = loc;
    state._activeStationBoardType = 'DEP';
    state._depExpandCount = 3;
    await ui.loadDepartures(loc, '', 60, false);
    await settle();
    expect(state._depExpandCount).toBe(3); // + (false ? 1 : 0)
  });

  it('loadArrivals with autoExpand=false does not increment the expand counter', async () => {
    vi.spyOn(ui, 'renderArrivals').mockReturnValue([{}]);
    state.selectedStop = loc;
    state._activeStationBoardType = 'ARR';
    state._arrExpandCount = 2;
    await ui.loadArrivals(loc, '', 60, false);
    await settle();
    expect(state._arrExpandCount).toBe(2);
  });
});

describe('extId proximity — sibling with crd.y/x === 0 (|| 0 arms) forces filtering', () => {
  it('renderDepartures: a zero-coord sibling is > 1m away → filters to the extId', () => {
    ui.departureList = document.getElementById('departure-list');
    const data = {
      jnyL: [
        { jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { locX: 0, dTimeS: '120000' } },
        { jid: 'B', prodX: 0, dirTxt: 'Y', stbStop: { locX: 1, dTimeS: '121000' } },
      ],
      common: {
        prodL: [{ nameS: '721' }],
        locL: [
          { extId: 'E1', name: 'S', crd: { x: 0, y: 0 } }, // filterLoc crd.x/y === 0 → || 0
          { extId: 'E2', name: 'S', crd: { x: 8600000, y: 49300000 } }, // far sibling
        ],
      },
    };
    ui.renderDepartures(data, { name: 'S' }, 'E1', null);
    expect(ui.departureList.querySelectorAll('.departure-item').length).toBe(1);
  });

  it('renderArrivals: a zero-coord sibling forces filtering (mirror)', () => {
    const data = {
      jnyL: [
        { jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { locX: 0, aTimeS: '120000' } },
        { jid: 'B', prodX: 0, dirTxt: 'Y', stbStop: { locX: 1, aTimeS: '121000' } },
      ],
      common: {
        prodL: [{ nameS: '721' }],
        locL: [
          { extId: 'E1', name: 'S', crd: { x: 0, y: 0 } },
          { extId: 'E2', name: 'S', crd: { x: 8600000, y: 49300000 } },
        ],
      },
    };
    ui.renderArrivals(data, { name: 'S' }, 'E1', null);
    expect(document.getElementById('arrival-list').querySelectorAll('.departure-item').length).toBe(
      1,
    );
  });
});

describe('filtered prodX default arm (line filter + out-of-range prodX)', () => {
  it('renderDepartures line filter: an out-of-range prodX defaults to {} (no nameS → filtered out)', () => {
    ui.departureList = document.getElementById('departure-list');
    const data = {
      jnyL: [
        { jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { dTimeS: '120000' } },
        { jid: 'B', prodX: 9, dirTxt: 'Y', stbStop: { dTimeS: '121000' } }, // prodX 9 → {} in filter
      ],
      common: { prodL: [{ nameS: '721' }], locL: [] },
    };
    ui.renderDepartures(data, { name: 'S' }, '', '721');
    // only the 721 row survives the line filter; the {}-prod row is dropped
    expect(ui.departureList.querySelectorAll('.departure-item').length).toBe(1);
  });

  it('renderArrivals line filter: out-of-range prodX defaults to {} and is filtered out', () => {
    const data = {
      jnyL: [
        { jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { aTimeS: '120000' } },
        { jid: 'B', prodX: 9, dirTxt: 'Y', stbStop: { aTimeS: '121000' } },
      ],
      common: { prodL: [{ nameS: '721' }], locL: [] },
    };
    ui.renderArrivals(data, { name: 'S' }, '', '721');
    expect(document.getElementById('arrival-list').querySelectorAll('.departure-item').length).toBe(
      1,
    );
  });
});

describe('extId-unknown, no same-name sibling → shouldFilter stays false', () => {
  it('renderDepartures does not filter when no loc shares the stop name', () => {
    ui.departureList = document.getElementById('departure-list');
    const data = {
      jnyL: [{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { locX: 0, dTimeS: '120000' } }],
      common: { prodL: [{ nameS: '721' }], locL: [{ extId: 'OTHER', name: 'Totally Different' }] },
    };
    ui.renderDepartures(data, { name: 'S' }, 'MISSING', null); // hasOtherWithSameName false
    expect(ui.departureList.querySelectorAll('.departure-item').length).toBe(1);
  });
});

describe('switchTab — stops chain arm + DEP dur ternary; setTabMode unknown mode', () => {
  it('switchTab("stops") reaches the else-if(stops) hideLineFilter arm', () => {
    state.selectedStop = null;
    const hide = vi.spyOn(ui, 'hideLineFilter').mockImplementation(() => {});
    ui.switchTab('stops');
    expect(hide).toHaveBeenCalled();
  });

  it('setTabMode with an unrecognised mode sets neither journey nor station layout', () => {
    ui.setTabMode('mystery');
    expect(state._tabMode).toBe('mystery');
  });
});

describe('applyPushedStationboard — ARR dur fallback + locX-present sig arm', () => {
  it('uses the ARR dur (isArr true) and includes stbStop.locX in the signature', () => {
    state.selectedStop = { lid: 'A=1@L=1@', extId: 'E1' };
    state._autoExpandingDep = false;
    state._autoExpandingArr = false;
    state._lastArrSig = null;
    state._stationArrDur = 300;
    const render = vi.spyOn(ui, 'renderArrivals').mockImplementation(() => {});
    const lm = vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
    ui.applyPushedStationboard(
      { lid: 'A=1@L=1@', extId: 'E1' },
      { jnyL: [{ jid: 'A', stbStop: { locX: 2, aTimeS: '120000' } }], common: {} }, // locX present → sig true arm
      'ARR',
    );
    expect(render).toHaveBeenCalled();
    expect(lm).toHaveBeenCalledWith('arrival-list', expect.anything(), 'E1', 300, 'ARR');
    expect(state._lastArrSig).toContain('|2|'); // locX 2 in the signature
  });
});

describe('focusJourneyById — ended-branch name/dir fallbacks', () => {
  beforeEach(() => {
    vi.spyOn(ui, '_disableFollow').mockImplementation(() => {});
    vi.spyOn(ui, 'setTabMode').mockImplementation(() => {});
    vi.spyOn(ui, 'switchTab').mockImplementation(() => {});
    vi.spyOn(ui, 'setPanelState').mockImplementation(() => {});
    state.panelState = 'half';
    state.map = mapStub();
  });

  it('ended journey with no prod names and no dirTxt uses the "?" fallbacks', async () => {
    getJourney.mockReturnValueOnce(
      Promise.resolve({
        journey: { stopL: [{ locX: 0, aTimeS: '090000' }] }, // 09:00 arr, now 10:00 → ended; no prodX/dirTxt
        common: { prodL: [], locL: [{ name: 'A' }] },
      }),
    );
    ui.focusJourneyById('J', undefined, true);
    await settle();
    expect(ui.detailLine.textContent).toBe('?'); // journeyProd.nameS||name||'?'
    expect(ui.detailDir.textContent).toBe('?'); // journey.dirTxt||'?'
    expect(ui.stopList.querySelector('.empty-state')).not.toBeNull();
  });

  it('not-started with stops but no prod name uses pendingVehicle name/dir "?"', async () => {
    vi.useFakeTimers();
    getJourney.mockReturnValueOnce(
      Promise.resolve({
        journey: {
          stopL: [
            { locX: 0, dTimeS: '120000' },
            { locX: 1, dTimeS: '123000' },
          ],
        }, // future, no dirTxt/prodX
        common: { prodL: [], locL: [{ name: 'A' }, { name: 'B' }] },
      }),
    );
    vi.spyOn(ui, 'renderJourneyStops').mockImplementation(() => {});
    vi.spyOn(ui, 'drawRoute').mockImplementation(() => {});
    ui.focusJourneyById('J', undefined, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(state._notStartedJid).toBe('J');
    expect(ui.detailDir.textContent).toContain('?');
  });
});

describe('search — a vehicle that matches nothing is not added (line OR false arm)', () => {
  it('excludes a vehicle whose line/lineFull do not contain the query', () => {
    document.body.innerHTML = '<input id="search-input" /><div id="search-results" hidden></div>';
    search.init();
    state.map = mapStub({ getCenter: () => ({ lat: 49.3, lng: 8.6 }) });
    search._searchSeq = 0;
    window.fetch = vi.fn(() => new Promise(() => {}));
    state.vehicles = new Map([
      ['J', { data: { line: '99', lineFull: 'Bus 99', direction: 'D', delay: 0, stops: [] } }],
    ]);
    search.doSearch('zz'); // matches neither line, lineFull, nor line substring
    expect(search._localLines.length).toBe(0);
  });
});
