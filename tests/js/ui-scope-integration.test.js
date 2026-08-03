/**
 * Integration coverage for the scope-early stationboard render path (bugs B/C):
 * that _renderBoard renders the platform-SCOPED view (own-platform entries shown,
 * same-station base/foreign entries hidden), that applyLineFilter delegates to
 * _renderBoard without rebuilding the chip strip (skipFilterRebuild), plus the
 * ARR cascade-keep guard and the dur=0 empty-state fallbacks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildPanelDom, wireUiRefs } from './ui-dom.js';

globalThis.L = {
  latLng: (lat, lon) => ({ lat, lng: lon }),
  circleMarker: vi.fn(() => ({ addTo: vi.fn(), remove: vi.fn() })),
};

const subscribeBoard = vi.fn(() => Promise.resolve({}));
const getStationBoard = vi.fn();
vi.mock('../../static/api.js', () => ({
  trackedFetch: (...a) => window.fetch(...a),
  api: {
    subscribeBoard: (...a) => subscribeBoard(...a),
    getStationBoard: (...a) => getStationBoard(...a),
    getJourney: vi.fn(() => new Promise(() => {})),
    selectStream: vi.fn(() => Promise.resolve()),
  },
  urlState: { push: vi.fn(), replace: vi.fn() },
}));
vi.mock('../../static/map.js', () => ({
  markers: { updateAll: vi.fn(), highlightSelected: vi.fn() },
  stopsLayer: { update: vi.fn(), addStopMarker: vi.fn(), saveToCache: vi.fn() },
}));
vi.mock('../../static/status.js', () => ({ announce: vi.fn() }));

const { ui } = await import('../../static/ui.js');
const { state } = await import('../../static/state.js');

// A Wiesloch-Walldorf-Bahnhof-shaped board: a base-station departure (locX 0)
// EARLIER than the chosen platform's own departure (locX 1). Both locs share the
// stop name; a same-name sibling > 1 m apart makes computeScopeActive scope. No
// server clock is set → serverNowMinRel returns null → _renderBoard skips the
// horizon rebase and uses the horizon we set, isolating the scope behaviour.
const wieslochBoard = () => ({
  sD: '20260802',
  common: {
    prodL: [{ nameS: '721' }, { nameS: '705' }],
    locL: [
      { extId: 'BASE', name: 'Wiesloch-Walldorf Bahnhof', crd: { x: 8600000, y: 49000000 } },
      { extId: 'OWN', name: 'Wiesloch-Walldorf Bahnhof', crd: { x: 8600000, y: 49001000 } },
    ],
  },
  jnyL: [
    { jid: 'base1', prodX: 0, dirTxt: 'Leimen Friedhof', stbStop: { locX: 0, dTimeS: '100000' } },
    { jid: 'own1', prodX: 1, dirTxt: 'HD Hbf', stbStop: { locX: 1, dTimeS: '130000' } },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  buildPanelDom();
  wireUiRefs(ui);
  state.vehicles = new Map();
  state.allStops = new Map();
  state.map = { setView: vi.fn() };
  state._depFilter = null;
  state._arrFilter = null;
  state._activeTab = 'departures';
  state._stationDepFetching = false;
  state._stationArrFetching = false;
  state._stationDepDur = 1440;
  state._stationArrDur = 1440;
  state._stationArrData = null;
  state.serverTimeMin = null;
  state.serverTimeStamp = null;
  state.serverDate = null;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('scope-early render (bug B/C)', () => {
  it('renders only the chosen platform, hiding the same-station base departure', () => {
    state._stationDepData = wieslochBoard();
    state._stationLoc = { lid: 'A=1@L=OWN@', name: 'Wiesloch-Walldorf Bahnhof', platform: '' };
    state._stationExtId = 'OWN';
    // Horizon covers BOTH the earlier base (10:00) and the later own (13:00) dep,
    // so anything hidden is hidden by SCOPING, not the slice.
    state._stationDepHorizon = 900;

    ui._renderBoard('DEP', state._stationLoc, 'OWN');

    const items = ui.departureList.querySelectorAll('.departure-item');
    expect(items.length).toBe(1);
    const txt = ui.departureList.textContent;
    expect(txt).toContain('HD Hbf'); // own platform (locX 1)
    expect(txt).not.toContain('Leimen Friedhof'); // base station (locX 0), scoped out
  });

  it('applyLineFilter delegates to _renderBoard without rebuilding the chip strip', () => {
    state._stationDepData = wieslochBoard();
    state._stationLoc = { lid: 'A=1@L=OWN@', name: 'Wiesloch-Walldorf Bahnhof', platform: '' };
    state._stationExtId = 'OWN';
    state._stationDepHorizon = 900;
    const blf = vi.spyOn(ui, 'buildLineFilter');
    const rb = vi.spyOn(ui, '_renderBoard');

    ui.applyLineFilter('705');

    expect(state._depFilter).toBe('705');
    expect(rb).toHaveBeenCalledWith('DEP', state._stationLoc, 'OWN', true);
    expect(blf).not.toHaveBeenCalled(); // skipFilterRebuild → no chip rebuild / flicker
  });
});

describe('scope-early horizon (bug C, scope ACTIVE with a server clock)', () => {
  // base-station dep 09:30 (locX 0), own-platform dep 11:00 (locX 1). With a
  // server clock at 09:00, a FULL-board horizon lands on the 09:30 base dep
  // (~10:00) and would slice the scoped 11:00 own dep away → empty. Scope-early
  // computes the horizon on the OWN entry → 11:00 is covered → shown. A mutation
  // of the scoped jnyL back to the full data.jnyL is caught by these tests.
  const depBoard = () => ({
    sD: '20260802',
    common: {
      prodL: [{ nameS: '721' }, { nameS: '705' }],
      locL: [
        { extId: 'BASE', name: 'Wiesloch-Walldorf Bahnhof', crd: { x: 8600000, y: 49000000 } },
        { extId: 'OWN', name: 'Wiesloch-Walldorf Bahnhof', crd: { x: 8600000, y: 49001000 } },
      ],
    },
    jnyL: [
      { jid: 'base1', prodX: 0, dirTxt: 'Leimen Friedhof', stbStop: { locX: 0, dTimeS: '093000' } },
      { jid: 'own1', prodX: 1, dirTxt: 'HD Hbf', stbStop: { locX: 1, dTimeS: '110000' } },
    ],
  });
  const arrBoard = () => {
    const b = depBoard();
    b.jnyL = [
      { jid: 'b', prodX: 0, dirTxt: 'from Leimen', stbStop: { locX: 0, aTimeS: '093000' } },
      { jid: 'o', prodX: 1, dirTxt: 'from HD', stbStop: { locX: 1, aTimeS: '110000' } },
    ];
    return b;
  };
  const ownLoc = { lid: 'A=1@L=OWN@', name: 'Wiesloch-Walldorf Bahnhof', platform: '' };

  it('_loadBoard computes the initial horizon on the SCOPED board (own dep not sliced away)', async () => {
    state.serverTimeMin = 540; // 09:00
    state.serverTimeStamp = Date.now();
    state.selectedStop = ownLoc;
    state._stationLoc = ownLoc;
    state._stationExtId = 'OWN';
    getStationBoard.mockResolvedValue(depBoard());

    await ui.loadDepartures(ownLoc, 'OWN', true);

    const items = ui.departureList.querySelectorAll('.departure-item');
    expect(items.length).toBe(1);
    expect(ui.departureList.textContent).toContain('HD Hbf');
    expect(ui.departureList.textContent).not.toContain('Leimen Friedhof');
  });

  it('_renderBoard rebases the stale horizon on the SCOPED board', () => {
    state.serverTimeMin = 540; // 09:00
    state.serverTimeStamp = Date.now();
    state._stationDepData = depBoard();
    state._stationLoc = ownLoc;
    state._stationExtId = 'OWN';
    state._stationDepHorizon = 500; // stale (< now+60=600) → forces rebase

    ui._renderBoard('DEP', ownLoc, 'OWN');

    expect(ui.departureList.querySelectorAll('.departure-item').length).toBe(1);
    expect(ui.departureList.textContent).toContain('HD Hbf');
  });

  it('bug B: applyLineFilter(null) keeps the base station hidden (scoped view == initial)', () => {
    state._stationDepData = depBoard();
    state._stationLoc = ownLoc;
    state._stationExtId = 'OWN';
    state._stationDepHorizon = 900; // covers both; no server clock → no rebase
    state._activeTab = 'departures';

    ui.applyLineFilter(null);

    expect(ui.departureList.querySelectorAll('.departure-item').length).toBe(1);
    expect(ui.departureList.textContent).toContain('HD Hbf');
    expect(ui.departureList.textContent).not.toContain('Leimen Friedhof');
  });

  it('_renderBoard(ARR) renders only the chosen platform (mirror of DEP)', () => {
    state._stationArrData = arrBoard();
    state._stationLoc = ownLoc;
    state._stationExtId = 'OWN';
    state._stationArrHorizon = 900;
    state._activeTab = 'arrivals';

    ui._renderBoard('ARR', ownLoc, 'OWN');

    const arrList = document.getElementById('arrival-list');
    expect(arrList.querySelectorAll('.departure-item').length).toBe(1);
    expect(arrList.textContent).toContain('from HD');
    expect(arrList.textContent).not.toContain('from Leimen');
  });

  it('switchTab builds the ARR line filter from the SCOPED board (foreign line absent)', () => {
    state._stationArrData = arrBoard();
    state.selectedStop = { lid: 'A=1@L=OWN@' };
    state._stationLoc = ownLoc;
    state._stationExtId = 'OWN';
    const blf = vi.spyOn(ui, 'buildLineFilter').mockImplementation(() => {});

    ui.switchTab('arrivals');

    const passed = blf.mock.calls[0][0];
    expect(passed.jnyL.map((j) => j.prodX)).toEqual([1]); // only own platform (prodX 1)
  });

  it('HAFAS-limit hint reflects the full board (>=50), not the small scoped slice', () => {
    state._stationDepData = {
      common: { prodL: [{ nameS: '721' }], locL: [] },
      jnyL: Array.from({ length: 50 }, (_, i) => ({
        jid: 'j' + i,
        prodX: 0,
        dirTxt: 'D' + i,
        stbStop: { dTimeS: '1200' + String(i).padStart(2, '0') },
      })),
    };
    // Render a tiny (1-entry) sliced view: the hint must still appear because it
    // reads state._stationDepData (50), not the passed slice.
    ui.renderDepartures(
      {
        common: { prodL: [{ nameS: '721' }], locL: [] },
        jnyL: [{ jid: 'x', prodX: 0, dirTxt: 'own', stbStop: { dTimeS: '120000' } }],
      },
      null,
    );
    expect(ui.departureList.querySelector('.hafas-hint')).not.toBeNull();
  });
});

describe('renderArrivals / renderDepartures empty-state edges', () => {
  it('ARR keeps the shown list while a fetch is in flight (cascade-keep)', () => {
    const arrList = document.getElementById('arrival-list');
    const li = document.createElement('li');
    li.className = 'departure-item';
    arrList.appendChild(li);
    state._stationArrFetching = true;
    state._stationArrDur = 60;

    ui.renderArrivals({ jnyL: [], common: {} }, null);

    expect(arrList.querySelectorAll('.departure-item').length).toBe(1); // kept
    expect(arrList.querySelector('.empty-state')).toBeNull();
  });

  it('ARR empty-state falls back to a 60-min window when arrDur is 0', () => {
    state._stationArrFetching = false;
    state._stationArrDur = 0; // exercises `state._stationArrDur || 60`

    ui.renderArrivals({ jnyL: [], common: {} }, null);

    expect(document.getElementById('arrival-list').querySelector('.empty-state')).not.toBeNull();
  });

  it('DEP empty-state falls back to a 60-min window when depDur is 0', () => {
    state._stationDepFetching = false;
    state._stationDepDur = 0; // exercises `state._stationDepDur || 60`

    ui.renderDepartures({ jnyL: [], common: {} }, null);

    expect(ui.departureList.querySelector('.empty-state')).not.toBeNull();
  });

  it('ARR dedups entries with identical line/time/direction', () => {
    const dup = {
      common: { prodL: [{ nameS: '721' }], locL: [] },
      jnyL: [
        { jid: 'a', prodX: 0, dirTxt: 'HD', stbStop: { aTimeS: '120000' } },
        { jid: 'b', prodX: 0, dirTxt: 'HD', stbStop: { aTimeS: '120000' } }, // dup → dropped
      ],
    };
    state._stationArrData = dup; // read by the HAFAS-limit hint (length < 50 → no hint)
    ui.renderArrivals(dup, null);
    expect(document.getElementById('arrival-list').querySelectorAll('.departure-item').length).toBe(
      1,
    );
  });
});

describe('Steig-unknown hint (Drehscheibe fail-open filter)', () => {
  // A platform-tagged (Drehscheibe) board. locL is empty so computeScopeActive
  // stays false and _scopedStationBoard reduces to platformScopedBoard, isolating
  // the Steig-tag path. dTimeS 12:00 sits inside the horizon; no server clock so
  // there is no rebase.
  const taggedBoard = (platforms) => ({
    _platformTagged: true,
    common: { prodL: [{ nameS: '721' }], locL: [] },
    jnyL: platforms.map((p, i) => ({
      jid: 'j' + i,
      prodX: 0,
      dirTxt: 'D' + i,
      _platformExtId: p,
      stbStop: { dTimeS: '1200' + String(i).padStart(2, '0') },
    })),
  });
  const ownLoc = { name: 'Walldorf-Drehscheibe', platform: '' };

  it('DEP shows the hint when no shown row resolved to the opened Steig', () => {
    state._stationDepData = taggedBoard([null, null]); // all fail-open
    state._stationLoc = ownLoc;
    state._stationExtId = '4466864';
    state._stationDepHorizon = 900;

    ui._renderBoard('DEP', ownLoc, '4466864');

    const hint = ui.departureList.querySelector('.platform-unknown-hint');
    expect(hint).not.toBeNull();
    expect(hint.textContent).toContain('Steig nicht bestimmbar');
    // Prepended above the departures.
    expect(ui.departureList.firstChild).toBe(hint);
    expect(ui.departureList.querySelectorAll('.departure-item').length).toBe(2); // both shown
  });

  it('DEP omits the hint once a row resolved to the opened Steig', () => {
    state._stationDepData = taggedBoard(['4466864', null]);
    state._stationLoc = ownLoc;
    state._stationExtId = '4466864';
    state._stationDepHorizon = 900;

    ui._renderBoard('DEP', ownLoc, '4466864');

    expect(ui.departureList.querySelector('.platform-unknown-hint')).toBeNull();
  });

  it('ARR shows the hint on the arrival list (isArr branch)', () => {
    const b = taggedBoard([null, null]);
    b.jnyL.forEach((j) => {
      j.stbStop = { aTimeS: j.stbStop.dTimeS };
    });
    state._stationArrData = b;
    state._stationLoc = ownLoc;
    state._stationExtId = '4407123';
    state._stationArrHorizon = 900;
    state._activeTab = 'arrivals';

    ui._renderBoard('ARR', ownLoc, '4407123');

    const arrList = document.getElementById('arrival-list');
    expect(arrList.querySelector('.platform-unknown-hint')).not.toBeNull();
  });

  it('ordinary (untagged) board never shows the hint', () => {
    state._stationDepData = {
      common: { prodL: [{ nameS: '721' }], locL: [] },
      jnyL: [{ jid: 'x', prodX: 0, dirTxt: 'HD', stbStop: { dTimeS: '120000' } }],
    };
    state._stationLoc = ownLoc;
    state._stationExtId = 'OWN';
    state._stationDepHorizon = 900;

    ui._renderBoard('DEP', ownLoc, 'OWN');

    expect(ui.departureList.querySelector('.platform-unknown-hint')).toBeNull();
  });

  it('does not stack duplicate hints across re-renders (cascade-keep path)', () => {
    state._stationDepData = taggedBoard([null, null]);
    state._stationLoc = ownLoc;
    state._stationExtId = '4466864';
    state._stationDepHorizon = 900;

    // First render: both rows inside the horizon → 2 departure-items + one hint.
    ui._renderBoard('DEP', ownLoc, '4466864');
    expect(ui.departureList.querySelectorAll('.departure-item').length).toBe(2);
    expect(ui.departureList.querySelectorAll('.platform-unknown-hint').length).toBe(1);

    // Mid-fetch re-render with a collapsed horizon → the SLICE is empty so
    // renderDepartures takes the cascade-keep early return (fetching + rows still
    // present) and does NOT clear the list, while the unsliced `view` still holds
    // the unresolved rows → the hint is re-evaluated. Without the dedup guard the
    // prepend would stack a second hint. No server clock → no horizon rebase.
    state._stationDepFetching = true;
    state._stationDepHorizon = 0;
    ui._renderBoard('DEP', ownLoc, '4466864');
    expect(ui.departureList.querySelectorAll('.platform-unknown-hint').length).toBe(1);
  });
});
