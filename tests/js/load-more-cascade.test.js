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
