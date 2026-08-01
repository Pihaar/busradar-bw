/**
 * Regression tests for the departure-board load-more path.
 *
 * The window-widening across a service gap now happens SERVER-side: the client
 * fires a single /stationboard request (auto_expand=true, min_results = the
 * count already shown) and the server returns the window it settled on as
 * `settledDur`. There is no client-side 60→1440 cascade any more — one request
 * per board, one loadDepartures call per load-more click.
 *
 * These tests drive the REAL ui.loadDepartures and the REAL addLoadMoreButton
 * click handler; only the DOM-heavy leaf renderers are spied on the ui object
 * (restored after each test) so the displayed count is controllable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

globalThis.L = { latLng: (lat, lon) => ({ lat, lng: lon }) };

const getStationBoard = vi.fn((...a) => Promise.resolve({ jnyL: [], common: {} }));
const selectStream = vi.fn(() => Promise.resolve({}));
vi.mock('../../static/api.js', () => ({
  trackedFetch: (...a) => window.fetch(...a),
  api: {
    getStationBoard: (...a) => getStationBoard(...a),
    selectStream: (...a) => selectStream(...a),
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

const loc = { lid: 'A=1@O=SAP-Allee@L=4407160@', name: 'SAP-Allee' };

describe('load-more departure board — single request, server settledDur', () => {
  beforeEach(() => {
    getStationBoard.mockClear();
    selectStream.mockClear();
    state.selectedStop = loc;
    state._depFilter = null;
    state._stationDepCount = 0;
    state._autoExpandingDep = false;
    state._activeStationBoardType = 'DEP';
    vi.spyOn(ui, 'discoverPlatforms').mockImplementation(function () {});
    vi.spyOn(ui, 'buildLineFilter').mockImplementation(function () {});
    vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(function () {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('issues exactly one request and adopts the server-settled window', async () => {
    // Board already shows 25 (up to 20:43); user clicks load-more at dur=480.
    // The server widens internally to 960 (05:39 next day) and reports it back.
    vi.spyOn(ui, 'renderDepartures').mockReturnValue(new Array(31).fill({}));
    state._stationDepCount = 25;
    getStationBoard.mockResolvedValueOnce({ jnyL: [], common: {}, settledDur: 960 });
    await ui.loadDepartures(loc, '', 480, false);

    expect(getStationBoard).toHaveBeenCalledTimes(1);
    const args = getStationBoard.mock.calls[0];
    expect(args[2]).toBe(480); // requested dur — no client cascade past it
    expect(state._stationDepDur).toBe(960); // adopted the server's window
    expect(state._stationDepCount).toBe(31);
    expect(selectStream).toHaveBeenCalledWith('stationboard', loc.lid, 'DEP', 960);
    expect(state._autoExpandingDep).toBe(false);
  });

  it('falls back to the requested dur when settledDur is absent', async () => {
    // Legacy / error response with no settledDur → keep the dur we asked for.
    vi.spyOn(ui, 'renderDepartures').mockReturnValue(new Array(3).fill({}));
    state._stationDepCount = 3;
    getStationBoard.mockResolvedValueOnce({ jnyL: [], common: {} });
    await ui.loadDepartures(loc, '', 60, false);

    expect(getStationBoard).toHaveBeenCalledTimes(1);
    expect(state._stationDepDur).toBe(60);
    expect(selectStream).toHaveBeenCalledWith('stationboard', loc.lid, 'DEP', 60);
  });
});

describe('load-more button click — one loadDepartures call with the next window', () => {
  beforeEach(() => {
    document.body.innerHTML = '<ul id="departure-list"></ul>';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls loadDepartures once with newDur and isInitial=false', () => {
    const spy = vi.spyOn(ui, 'loadDepartures').mockImplementation(() => Promise.resolve());
    ui.addLoadMoreButton('departure-list', loc, '', 480, 'DEP');

    const btn = document.querySelector('.load-more-btn');
    expect(btn).not.toBeNull();
    btn.click();

    expect(spy).toHaveBeenCalledTimes(1);
    const args = spy.mock.calls[0];
    expect(args[0]).toBe(loc);
    expect(args[2]).toBe(540); // currentDur 480 + 60
    expect(args[3]).toBe(false); // isInitial — a manual load-more, not the stop-open
  });

  it('propagates min_results and ext_id through to the stationboard request body', async () => {
    // Drive the click WITHOUT mocking loadDepartures so the real getStationBoard
    // args are observable: min_results = the count already shown, ext_id = stop.
    vi.spyOn(ui, 'discoverPlatforms').mockImplementation(function () {});
    vi.spyOn(ui, 'buildLineFilter').mockImplementation(function () {});
    vi.spyOn(ui, 'renderDepartures').mockReturnValue([{}, {}, {}]);
    getStationBoard.mockClear();
    getStationBoard.mockResolvedValue({ jnyL: [], common: {} });
    state.selectedStop = loc;
    state._depFilter = null;
    state._autoExpandingDep = false;
    state._activeStationBoardType = 'DEP';
    state._stationDepCount = 25;

    ui.addLoadMoreButton('departure-list', loc, '6003411', 480, 'DEP');
    document.querySelector('.load-more-btn').click();
    await new Promise(function (r) {
      setTimeout(r, 0);
    });

    const args = getStationBoard.mock.calls[0];
    expect(args[2]).toBe(540); // newDur
    expect(args[4]).toBe(25); // min_results = state._stationDepCount
    expect(args[5]).toBe('6003411'); // ext_id = stopExtId
  });
});

// === Bug 3: empty/errored render must NOT wipe an already-shown list, but a
// non-expanding (steady-state SSE push / filter) empty MUST still clear. ===
describe('renderDepartures — keeps list only while an expand cascade is in flight', () => {
  beforeEach(() => {
    document.body.innerHTML = '<ul id="departure-list"></ul>';
    ui.departureList = document.getElementById('departure-list');
    state.selectedStop = loc;
    state._depFilter = null;
    state._autoExpandingDep = false;
    state.vehicles = new Map();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function populate(n) {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < n; i++) {
      const li = document.createElement('li');
      li.className = 'departure-item';
      frag.appendChild(li);
    }
    ui.departureList.replaceChildren(frag);
  }

  it('keeps the shown departures while an expand cascade returns none', () => {
    populate(3);
    state._stationDepDur = 480;
    state._autoExpandingDep = true; // cascade walking a service gap
    ui.renderDepartures({ jnyL: [], common: {} }, loc, '', null);
    expect(ui.departureList.querySelectorAll('.departure-item').length).toBe(3);
    expect(ui.departureList.querySelector('.empty-state')).toBeNull();
  });

  it('clears to empty-state when a NON-expanding render empties a wide board', () => {
    // e.g. a steady-state SSE push at dur>60 after end-of-service — must not
    // freeze departed buses on screen (the architect-flagged stale-board path).
    populate(3);
    state._stationDepDur = 480;
    state._autoExpandingDep = false;
    ui.renderDepartures({ jnyL: [], common: {} }, loc, '', null);
    expect(ui.departureList.querySelector('.empty-state')).not.toBeNull();
  });

  it('shows the empty-state at the default window when nothing is upcoming', () => {
    populate(0);
    state._stationDepDur = 60;
    ui.renderDepartures({ jnyL: [], common: {} }, loc, '', null);
    expect(ui.departureList.querySelector('.empty-state')).not.toBeNull();
  });

  it('clears a populated board at dur=60 when not expanding (gate is the flag, not dur)', () => {
    populate(3);
    state._stationDepDur = 60;
    state._autoExpandingDep = false;
    ui.renderDepartures({ jnyL: [], common: {} }, loc, '', null);
    expect(ui.departureList.querySelector('.empty-state')).not.toBeNull();
  });

  it('replaces the list with fresh departures when results arrive', () => {
    populate(1);
    state._stationDepDur = 240;
    const data = {
      jnyL: [
        { jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { dTimeS: '120000' } },
        { jid: 'B', prodX: 0, dirTxt: 'Y', stbStop: { dTimeS: '121000' } },
      ],
      common: { prodL: [{ nameS: '721' }], locL: [] },
    };
    ui.renderDepartures(data, loc, '', null);
    expect(ui.departureList.querySelectorAll('.departure-item').length).toBe(2);
    expect(ui.departureList.querySelector('.empty-state')).toBeNull();
  });
});

describe('renderArrivals — same keep-only-while-expanding rule (mirror)', () => {
  let arrList;
  beforeEach(() => {
    document.body.innerHTML = '<ul id="arrival-list"></ul>';
    arrList = document.getElementById('arrival-list');
    state.selectedStop = loc;
    state._arrFilter = null;
    state._autoExpandingArr = false;
    state.vehicles = new Map();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function populate(n) {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < n; i++) {
      const li = document.createElement('li');
      li.className = 'departure-item'; // arrival rows reuse this class
      frag.appendChild(li);
    }
    arrList.replaceChildren(frag);
  }

  it('keeps the shown arrivals while an expand cascade returns none', () => {
    populate(2);
    state._stationArrDur = 480;
    state._autoExpandingArr = true;
    ui.renderArrivals({ jnyL: [], common: {} }, loc, '', null);
    expect(arrList.querySelectorAll('.departure-item').length).toBe(2);
    expect(arrList.querySelector('.empty-state')).toBeNull();
  });

  it('clears to empty-state when a non-expanding render empties a wide board', () => {
    populate(2);
    state._stationArrDur = 480;
    state._autoExpandingArr = false;
    ui.renderArrivals({ jnyL: [], common: {} }, loc, '', null);
    expect(arrList.querySelector('.empty-state')).not.toBeNull();
  });
});

describe('applyPushedStationboard — an empty SSE push clears a wide board (Bug 3 x SSE)', () => {
  beforeEach(() => {
    document.body.innerHTML = '<ul id="departure-list"></ul>';
    ui.departureList = document.getElementById('departure-list');
    state.selectedStop = loc;
    state._depFilter = null;
    state._autoExpandingDep = false;
    state._autoExpandingArr = false;
    state._lastDepSig = null;
    state._stationDepDur = 480;
    state.vehicles = new Map();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clears the frozen list when the real push handler delivers an empty wide board', () => {
    const li = document.createElement('li');
    li.className = 'departure-item';
    ui.departureList.appendChild(li);
    ui.applyPushedStationboard(loc, { jnyL: [], common: {} }, 'DEP');
    expect(ui.departureList.querySelector('.empty-state')).not.toBeNull();
  });
});

describe('loadArrivals error — keeps a populated list instead of wiping it (mirror)', () => {
  beforeEach(() => {
    document.body.innerHTML = '<ul id="arrival-list"></ul>';
    state.selectedStop = loc;
    state._autoExpandingArr = false;
    state._stationArrDur = 300;
    getStationBoard.mockClear();
    vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(function () {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not wipe shown arrivals when the fetch rejects', async () => {
    const li = document.createElement('li');
    li.className = 'departure-item';
    document.getElementById('arrival-list').appendChild(li);
    getStationBoard.mockImplementationOnce(() => Promise.reject(new Error('rate_limit')));
    await ui.loadArrivals(loc, '', 300, true);
    expect(document.getElementById('arrival-list').querySelectorAll('.departure-item').length).toBe(
      1,
    );
    expect(document.getElementById('arrival-list').querySelector('.empty-state')).toBeNull();
    expect(ui.addLoadMoreButton).toHaveBeenCalled();
  });

  it('shows the error state when nothing was displayed yet', async () => {
    getStationBoard.mockImplementationOnce(() => Promise.reject(new Error('rate_limit')));
    await ui.loadArrivals(loc, '', 60, true);
    expect(document.getElementById('arrival-list').querySelector('.empty-state')).not.toBeNull();
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
