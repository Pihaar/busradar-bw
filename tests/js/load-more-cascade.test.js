/**
 * Regression tests for the departure-board load-more cascade (v1.2.10).
 *
 * Bug: HAFAS stationboard `dur` is cumulative-from-now, so the old
 * single-step load-more (+60 min per click) re-rendered an identical list
 * when the next hour was empty. Crossing a service gap (e.g. SAP-Allee:
 * departures until 20:43, then nothing until 05:39 next day) took ~9
 * no-op clicks. Fix: load-more cascades like the initial auto-expand until
 * the departure count actually grows or dur hits 1440.
 *
 * These tests drive the REAL ui.loadDepartures cascade loop and the REAL
 * addLoadMoreButton click handler; only the DOM-heavy leaf renderers are
 * spied on the ui object (restored after each test) so the count curve is
 * controllable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

globalThis.L = { latLng: (lat, lon) => ({ lat, lng: lon }) };

const getStationBoard = vi.fn((lid, type, dur) => Promise.resolve({ dur: dur }));
vi.mock('../../static/api.js', () => ({
  api: {
    getStationBoard: (lid, type, dur) => getStationBoard(lid, type, dur),
    selectStream: vi.fn(() => Promise.resolve({})),
  },
  urlState: { push: vi.fn(), replace: vi.fn() },
}));
vi.mock('../../static/map.js', () => ({
  markers: { updateAll: vi.fn() },
  stopsLayer: { update: vi.fn(), addStopMarker: vi.fn() },
}));
vi.mock('../../static/status.js', () => ({ announce: vi.fn() }));

const { ui } = await import('../../static/ui.js');
const { state } = await import('../../static/state.js');

// Drain the microtask/macrotask queue until the cascade settles (it
// recurses via un-awaited promise chains, so a single await isn't enough).
async function settleCascade() {
  for (let i = 0; i < 100 && state._autoExpandingDep; i++) {
    await new Promise(function (r) { setTimeout(r, 0); });
  }
}

// SAP-Allee curve: 25 departures until the window reaches ~960 min
// (the 05:39 next-day departures), then 31.
function countForDur(dur) {
  return dur >= 960 ? 31 : 25;
}

const loc = { lid: 'A=1@O=SAP-Allee@L=4407160@', name: 'SAP-Allee' };

describe('load-more departure cascade', () => {
  beforeEach(() => {
    getStationBoard.mockClear();
    state.selectedStop = loc;
    state._depFilter = null;
    state._stationDepCount = 0;
    state._depExpandCount = 0;
    state._autoExpandingDep = false;
    state._activeStationBoardType = 'DEP';
    vi.spyOn(ui, 'discoverPlatforms').mockImplementation(function () {});
    vi.spyOn(ui, 'buildLineFilter').mockImplementation(function () {});
    vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(function () {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('cascades across empty hours until the departure count grows', async () => {
    vi.spyOn(ui, 'renderDepartures').mockImplementation(function (data) {
      return new Array(countForDur(data.dur)).fill({});
    });
    // Board already shows 25 (up to 20:43); user clicks load-more at dur=480.
    state._stationDepCount = 25;
    ui.loadDepartures(loc, '', 480, true);
    await settleCascade();

    const durs = getStationBoard.mock.calls.map(function (c) { return c[2]; });
    expect(durs[0]).toBe(480);
    expect(Math.max.apply(null, durs)).toBe(960);  // stops once count grows
    expect(state._stationDepCount).toBe(31);
    expect(state._autoExpandingDep).toBe(false);
  });

  it('stops at the 1440 cap if the count never grows', async () => {
    vi.spyOn(ui, 'renderDepartures').mockImplementation(function () {
      return new Array(3).fill({});
    });
    state._stationDepCount = 3;
    ui.loadDepartures(loc, '', 60, true);
    await settleCascade();

    const durs = getStationBoard.mock.calls.map(function (c) { return c[2]; });
    expect(Math.max.apply(null, durs)).toBe(1440);
    expect(durs.every(function (d) { return d <= 1440; })).toBe(true);
  });
});

describe('load-more button click triggers a cascade', () => {
  beforeEach(() => {
    document.body.innerHTML = '<ul id="departure-list"></ul>';
    state._depExpandCount = 7;  // pre-consumed by the initial stop-open
    state._arrExpandCount = 0;
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('resets the expand counter and calls loadDepartures with autoExpand=true', () => {
    const spy = vi.spyOn(ui, 'loadDepartures').mockImplementation(() => Promise.resolve());
    ui.addLoadMoreButton('departure-list', loc, '', 480, 'DEP');

    const btn = document.querySelector('.load-more-btn');
    expect(btn).not.toBeNull();
    btn.click();

    expect(state._depExpandCount).toBe(0);  // reset → manual walk gets full budget
    expect(spy).toHaveBeenCalledTimes(1);
    const args = spy.mock.calls[0];
    expect(args[2]).toBe(540);   // currentDur 480 + 60
    expect(args[3]).toBe(true);  // autoExpand — the fix (was false)
  });
});

// === Bug 3: empty/errored render must NOT wipe an already-shown list ===
describe('renderDepartures — never wipes a populated list on an empty expand', () => {
  beforeEach(() => {
    document.body.innerHTML = '<ul id="departure-list"></ul>';
    ui.departureList = document.getElementById('departure-list');
    state.selectedStop = loc;
    state._depFilter = null;
    state.vehicles = new Map();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  function populate(n) {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < n; i++) {
      const li = document.createElement('li');
      li.className = 'departure-item';
      frag.appendChild(li);
    }
    ui.departureList.replaceChildren(frag);
  }

  it('keeps the shown departures when a widened window (dur>60) returns none', () => {
    populate(3);
    state._stationDepDur = 480;
    ui.renderDepartures({ jnyL: [], common: {} }, loc, '', null);
    expect(ui.departureList.querySelectorAll('.departure-item').length).toBe(3);
    expect(ui.departureList.querySelector('.empty-state')).toBeNull();
  });

  it('shows the empty-state at the default window (dur=60) when nothing is upcoming', () => {
    populate(0);
    state._stationDepDur = 60;
    ui.renderDepartures({ jnyL: [], common: {} }, loc, '', null);
    expect(ui.departureList.querySelector('.empty-state')).not.toBeNull();
  });

  it('shows the empty-state on a wide empty window when nothing was shown yet', () => {
    populate(0);
    state._stationDepDur = 480;
    ui.renderDepartures({ jnyL: [], common: {} }, loc, '', null);
    expect(ui.departureList.querySelector('.empty-state')).not.toBeNull();
  });

  it('replaces the list with fresh departures when results arrive', () => {
    populate(1);
    state._stationDepDur = 240;
    const data = { jnyL: [
      { jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { dTimeS: '120000' } },
      { jid: 'B', prodX: 0, dirTxt: 'Y', stbStop: { dTimeS: '121000' } },
    ], common: { prodL: [{ nameS: '721' }], locL: [] } };
    ui.renderDepartures(data, loc, '', null);
    expect(ui.departureList.querySelectorAll('.departure-item').length).toBe(2);
    expect(ui.departureList.querySelector('.empty-state')).toBeNull();
  });
});

describe('loadDepartures error — keeps a populated list instead of wiping it', () => {
  beforeEach(() => {
    document.body.innerHTML = '<ul id="departure-list"></ul>';
    ui.departureList = document.getElementById('departure-list');
    state.selectedStop = loc;
    state._autoExpandingDep = false;
    state._stationDepDur = 300;
    getStationBoard.mockClear();
    vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(function () {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('does not wipe shown departures when the fetch rejects (e.g. 429)', async () => {
    const li = document.createElement('li');
    li.className = 'departure-item';
    ui.departureList.appendChild(li);
    getStationBoard.mockImplementationOnce(() => Promise.reject(new Error('rate_limit')));
    await ui.loadDepartures(loc, '', 300, true);
    expect(ui.departureList.querySelectorAll('.departure-item').length).toBe(1);
    expect(ui.departureList.querySelector('.empty-state')).toBeNull();
    expect(ui.addLoadMoreButton).toHaveBeenCalled();
  });

  it('shows the error state when nothing was displayed yet', async () => {
    getStationBoard.mockImplementationOnce(() => Promise.reject(new Error('rate_limit')));
    await ui.loadDepartures(loc, '', 60, true);
    expect(ui.departureList.querySelector('.empty-state')).not.toBeNull();
  });
});
