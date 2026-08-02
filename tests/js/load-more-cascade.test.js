/**
 * Tests for the departure-board load-more path.
 *
 * Window-widening is now fully CLIENT-side: the board is fetched ONCE at
 * dur=1440 and paginated by extending a local horizon. A load-more click
 * extends the horizon and re-renders the already-cached board — it fires NO
 * new fetch. The old server-side auto_expand/min_results/ext_id cascade and the
 * `settledDur` handshake are gone; the realtime SSE window is subscribed via
 * api.subscribeBoard (the fixed 2h window), never selectStream at the fetch dur.
 *
 * These tests drive the REAL ui.loadDepartures and the REAL addLoadMoreButton
 * click handler; only the DOM-heavy leaf renderers are spied on the ui object
 * (restored after each test) so the displayed count is controllable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

globalThis.L = { latLng: (lat, lon) => ({ lat, lng: lon }) };

const getStationBoard = vi.fn((...a) => Promise.resolve({ jnyL: [], common: {} }));
const selectStream = vi.fn(() => Promise.resolve({}));
const subscribeBoard = vi.fn(() => Promise.resolve({}));
vi.mock('../../static/api.js', () => ({
  trackedFetch: (...a) => window.fetch(...a),
  api: {
    subscribeBoard: (...a) => subscribeBoard(...a),
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

describe('load-more departure board — one plain full-window fetch, no cascade', () => {
  beforeEach(() => {
    getStationBoard.mockClear();
    selectStream.mockClear();
    subscribeBoard.mockClear();
    state.selectedStop = loc;
    state._depFilter = null;
    state._stationDepFetching = false;
    state._activeStationBoardType = 'DEP';
    state._activeTab = 'departures';
    state._stationExtId = '';
    state._stationDepHorizon = 0;
    state.serverTimeMin = null;
    state.serverTimeStamp = null;
    vi.spyOn(ui, 'discoverPlatforms').mockImplementation(function () {});
    vi.spyOn(ui, 'buildLineFilter').mockImplementation(function () {});
    vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(function () {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches once at dur=1440 and subscribes the SSE realtime window (not the fetch dur)', async () => {
    vi.spyOn(ui, 'renderDepartures').mockReturnValue([{}, {}, {}]);
    getStationBoard.mockResolvedValueOnce({ jnyL: [], common: {} });
    // The `dur` arg is vestigial — the loader always fetches the full window.
    await ui.loadDepartures(loc, '', false);

    expect(getStationBoard).toHaveBeenCalledTimes(1);
    const args = getStationBoard.mock.calls[0];
    expect(args[2]).toBe(1440); // always the full window, never the caller's dur
    expect(state._stationDepDur).toBe(1440);
    // The realtime SSE subscription goes through subscribeBoard (fixed 2h),
    // NOT selectStream at the 1440 fetch dur.
    expect(subscribeBoard).toHaveBeenCalledWith(loc.lid, 'DEP');
    expect(selectStream).not.toHaveBeenCalled();
    expect(state._stationDepFetching).toBe(false); // .finally cleared it
  });

  it('records the fetch timestamp and clears the retry gate on success', async () => {
    vi.spyOn(ui, 'renderDepartures').mockReturnValue([{}]);
    state._stationDepRetryAt = 999;
    getStationBoard.mockResolvedValueOnce({ jnyL: [], common: {} });
    await ui.loadDepartures(loc, '', true);
    expect(state._stationDepFetchedAt).not.toBeNull();
    expect(state._stationDepRetryAt).toBe(0);
  });
});

describe('load-more button click — pure client pagination, no fetch', () => {
  beforeEach(() => {
    document.body.innerHTML = '<ul id="departure-list"></ul>';
    getStationBoard.mockClear();
    state.selectedStop = loc;
    state._depFilter = null;
    state._stationDepFetching = false;
    state._activeStationBoardType = 'DEP';
    state._activeTab = 'departures';
    state._stationExtId = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('extends the horizon and re-renders WITHOUT a new stationboard fetch', () => {
    // Cached board has a departure at eff=780 (13:00); horizon is 720 (12:00),
    // so a departure lies beyond it → the button is shown.
    state._stationDepData = {
      jnyL: [{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { dTimeS: '130000' } }],
      common: { prodL: [{ nameS: '721' }], locL: [] },
    };
    state._stationDepHorizon = 720;
    const renderSpy = vi.spyOn(ui, '_renderBoard').mockImplementation(function () {});
    ui.addLoadMoreButton('departure-list', loc, '', 'DEP');

    const btn = document.querySelector('.load-more-btn');
    expect(btn).not.toBeNull();
    btn.click();

    expect(state._stationDepHorizon).toBeGreaterThan(720); // horizon widened
    expect(renderSpy).toHaveBeenCalledWith('DEP', loc, ''); // re-render the wider slice
    expect(getStationBoard).not.toHaveBeenCalled(); // NO fetch
  });

  it('shows the max-timeframe hint (no button) when nothing lies beyond the horizon', () => {
    state._stationDepData = {
      jnyL: [{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { dTimeS: '120000' } }],
      common: { prodL: [{ nameS: '721' }], locL: [] },
    };
    state._stationDepHorizon = 720; // 12:00 — the only departure is at/under it
    ui.addLoadMoreButton('departure-list', loc, '', 'DEP');
    expect(document.querySelector('.load-more-btn')).toBeNull();
    expect(document.querySelector('.load-more-item.empty-state')).not.toBeNull();
  });

  it('is a no-op click when the cache was torn down between render and click', () => {
    state._stationDepData = {
      jnyL: [{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { dTimeS: '130000' } }],
      common: { prodL: [{ nameS: '721' }], locL: [] },
    };
    state._stationDepHorizon = 720;
    const renderSpy = vi.spyOn(ui, '_renderBoard').mockImplementation(function () {});
    ui.addLoadMoreButton('departure-list', loc, '', 'DEP');
    const btn = document.querySelector('.load-more-btn');
    state._stationDepData = null; // closePanel / refetch cleared it
    btn.click();
    expect(renderSpy).not.toHaveBeenCalled();
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
    state._stationDepFetching = false;
    state.vehicles = new Map();
    state._stationDepData = { jnyL: [], common: { prodL: [], locL: [] } };
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
    state._stationDepFetching = true; // cascade walking a service gap
    ui.renderDepartures({ jnyL: [], common: {} }, null);
    expect(ui.departureList.querySelectorAll('.departure-item').length).toBe(3);
    expect(ui.departureList.querySelector('.empty-state')).toBeNull();
  });

  it('clears to empty-state when a NON-expanding render empties a wide board', () => {
    // e.g. a steady-state SSE push at dur>60 after end-of-service — must not
    // freeze departed buses on screen (the architect-flagged stale-board path).
    populate(3);
    state._stationDepDur = 480;
    state._stationDepFetching = false;
    ui.renderDepartures({ jnyL: [], common: {} }, null);
    expect(ui.departureList.querySelector('.empty-state')).not.toBeNull();
  });

  it('shows the empty-state at the default window when nothing is upcoming', () => {
    populate(0);
    state._stationDepDur = 60;
    ui.renderDepartures({ jnyL: [], common: {} }, null);
    expect(ui.departureList.querySelector('.empty-state')).not.toBeNull();
  });

  it('clears a populated board at dur=60 when not expanding (gate is the flag, not dur)', () => {
    populate(3);
    state._stationDepDur = 60;
    state._stationDepFetching = false;
    ui.renderDepartures({ jnyL: [], common: {} }, null);
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
    ui.renderDepartures(data, null);
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
    state._stationArrFetching = false;
    state.vehicles = new Map();
    state._stationArrData = { jnyL: [], common: { prodL: [], locL: [] } };
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
    state._stationArrFetching = true;
    ui.renderArrivals({ jnyL: [], common: {} }, null);
    expect(arrList.querySelectorAll('.departure-item').length).toBe(2);
    expect(arrList.querySelector('.empty-state')).toBeNull();
  });

  it('clears to empty-state when a non-expanding render empties a wide board', () => {
    populate(2);
    state._stationArrDur = 480;
    state._stationArrFetching = false;
    ui.renderArrivals({ jnyL: [], common: {} }, null);
    expect(arrList.querySelector('.empty-state')).not.toBeNull();
  });
});

describe('applyPushedStationboard — an empty SSE push reconciles a wide board empty (Bug 3 x SSE)', () => {
  beforeEach(() => {
    document.body.innerHTML = '<ul id="departure-list"></ul><div id="line-filter" hidden></div>';
    ui.departureList = document.getElementById('departure-list');
    state.selectedStop = loc;
    state._depFilter = null;
    state._stationDepFetching = false;
    state._stationArrFetching = false;
    state._lastDepSig = null;
    state._stationExtId = '';
    state._stationDepDur = 1440;
    state._activeTab = 'departures';
    state.vehicles = new Map();
    // Server clock at 12:00 so the reconcile window (Soll ≤ now+120) is defined.
    state.serverTimeMin = 720;
    state.serverTimeStamp = Date.now();
    vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(function () {});
    vi.spyOn(ui, 'buildLineFilter').mockImplementation(function () {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops an in-window cached departure when the push no longer carries it', () => {
    // Cache holds one 12:00 departure (in the 12:00→14:00 authoritative window);
    // an empty push means HAFAS removed it → reconcile clears it → empty-state.
    state._stationDepData = {
      jnyL: [{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { dTimeS: '120000' } }],
      common: { prodL: [{ nameS: '721' }], locL: [] },
    };
    state._stationDepHorizon = 780;
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
    state._stationArrFetching = false;
    state._activeStationBoardType = 'ARR';
    state._stationArrDur = 300;
    getStationBoard.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not wipe shown arrivals when the fetch rejects', async () => {
    const li = document.createElement('li');
    li.className = 'departure-item';
    document.getElementById('arrival-list').appendChild(li);
    getStationBoard.mockImplementationOnce(() => Promise.reject(new Error('rate_limit')));
    await ui.loadArrivals(loc, '');
    expect(document.getElementById('arrival-list').querySelectorAll('.departure-item').length).toBe(
      1,
    );
    expect(document.getElementById('arrival-list').querySelector('.empty-state')).toBeNull();
    // Backoff gate is armed so the 1s TTL ticker can't hammer HAFAS.
    expect(state._stationArrRetryAt).toBeGreaterThan(0);
  });

  it('shows the error state when nothing was displayed yet', async () => {
    getStationBoard.mockImplementationOnce(() => Promise.reject(new Error('rate_limit')));
    await ui.loadArrivals(loc, '');
    expect(document.getElementById('arrival-list').querySelector('.empty-state')).not.toBeNull();
  });
});

describe('loadDepartures error — keeps a populated list instead of wiping it', () => {
  beforeEach(() => {
    document.body.innerHTML = '<ul id="departure-list"></ul>';
    ui.departureList = document.getElementById('departure-list');
    state.selectedStop = loc;
    state._stationDepFetching = false;
    state._activeStationBoardType = 'DEP';
    state._stationDepDur = 300;
    getStationBoard.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not wipe shown departures when the fetch rejects (e.g. 429)', async () => {
    const li = document.createElement('li');
    li.className = 'departure-item';
    ui.departureList.appendChild(li);
    getStationBoard.mockImplementationOnce(() => Promise.reject(new Error('rate_limit')));
    await ui.loadDepartures(loc, '', true);
    expect(ui.departureList.querySelectorAll('.departure-item').length).toBe(1);
    expect(ui.departureList.querySelector('.empty-state')).toBeNull();
    expect(state._stationDepRetryAt).toBeGreaterThan(0);
  });

  it('shows the error state when nothing was displayed yet', async () => {
    getStationBoard.mockImplementationOnce(() => Promise.reject(new Error('rate_limit')));
    await ui.loadDepartures(loc, '', true);
    expect(ui.departureList.querySelector('.empty-state')).not.toBeNull();
  });
});

describe('applyPushedStationboard — next-day entries survive the reconcile (day-offset fix)', () => {
  const SD = '20260801';
  beforeEach(() => {
    document.body.innerHTML = '<ul id="departure-list"></ul><div id="line-filter" hidden></div>';
    ui.departureList = document.getElementById('departure-list');
    state.selectedStop = loc;
    state._depFilter = null;
    state._stationDepFetching = false;
    state._stationArrFetching = false;
    state._lastDepSig = null;
    state._stationExtId = '';
    state._stationDepDur = 1440;
    state._activeTab = 'departures';
    state.vehicles = new Map();
    state._boardHorizonLog = [];
    state.serverTimeStamp = 0; // deterministic derivedServerNowMin
    vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(function () {});
    vi.spyOn(ui, 'buildLineFilter').mockImplementation(function () {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const today = { jid: 'today', prodX: 0, dirTxt: 'X', date: SD, stbStop: { dTimeS: '120000' } };
  const nextMorning = {
    jid: 'nextmorning',
    prodX: 0,
    dirTxt: 'X',
    date: '20260802',
    stbStop: { dTimeS: '050000' },
  };
  const common = { prodL: [{ nameS: '721' }], locL: [] };

  it('keeps a paged next-day departure when the 2h push carries only today', () => {
    state.serverTimeMin = 720; // 12:00
    state.serverDate = SD;
    state._stationDepData = { jnyL: [today, nextMorning], common, sD: SD };
    state._stationDepHorizon = 1800; // paged past midnight
    ui.applyPushedStationboard(loc, { jnyL: [today], common }, 'DEP');
    // Without the day-offset fix the next-day entry (raw Soll 300 ≤ winTop 720) would
    // be dropped as "departed"; with it, Soll 1740 > winTop → kept in the tail.
    expect(state._stationDepData.jnyL.map((j) => j.jid)).toContain('nextmorning');
    const rec = state._boardHorizonLog.filter((e) => e.cause === 'reconcile').pop();
    expect(rec.keptBefore).toBe(2);
    expect(rec.keptAfter).toBe(2);
  });

  it('over local midnight (sD=yesterday, serverDate=today) still keeps the next-day entry', () => {
    state.serverTimeMin = 1; // 00:01
    state.serverDate = '20260802';
    state._stationDepData = { jnyL: [nextMorning], common, sD: SD };
    state._stationDepHorizon = 3000;
    ui.applyPushedStationboard(loc, { jnyL: [], common }, 'DEP');
    // nowMinRel = 1 + 1 day = 1441; next-morning Soll = 300 + 1440 = 1740 > winTop → tail.
    expect(state._stationDepData.jnyL.map((j) => j.jid)).toContain('nextmorning');
  });

  it('tolerates a cache without jnyL (keptBefore falls back to 0)', () => {
    state.serverTimeMin = 720;
    state.serverDate = null;
    state._stationDepData = { common }; // no jnyL
    state._stationDepHorizon = 900;
    const p = { jid: 'p', prodX: 0, dirTxt: 'X', stbStop: { dTimeS: '120000' } };
    ui.applyPushedStationboard(loc, { jnyL: [p], common }, 'DEP');
    expect(state._stationDepData.jnyL.map((j) => j.jid)).toEqual(['p']);
    const rec = state._boardHorizonLog.filter((e) => e.cause === 'reconcile').pop();
    expect(rec.keptBefore).toBe(0);
  });
});
