/**
 * Branch mop-up for static/ui.js's _loadBoard / _renderBoard / addLoadMoreButton
 * arms that the other suites don't reach: the cold-open Infinity horizon (no
 * server clock) vs computeInitialHorizon, the subscribeBoard .catch no-op arms
 * (success AND error path, and via switchTab), the _renderBoard null-data guard,
 * and the load-more no-op / empty-cache arms.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildPanelDom, wireUiRefs } from './ui-dom.js';

globalThis.L = {
  latLng: (lat, lon) => ({ lat, lng: lon }),
  circleMarker: vi.fn(() => ({ addTo: vi.fn(), remove: vi.fn() })),
};

const getStationBoard = vi.fn();
const subscribeBoard = vi.fn(() => Promise.resolve({}));
const selectStream = vi.fn(() => Promise.resolve());
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
  markers: { updateAll: vi.fn(), highlightSelected: vi.fn() },
  stopsLayer: { update: vi.fn(), addStopMarker: vi.fn(), saveToCache: vi.fn() },
}));
vi.mock('../../static/status.js', () => ({ announce: vi.fn() }));

const { ui } = await import('../../static/ui.js');
const { state } = await import('../../static/state.js');

const loc = { lid: 'A=1@L=1@', name: 'Sandhausen' };

function settle() {
  return new Promise((r) => setTimeout(r, 0));
}

describe('_loadBoard — initial horizon arms', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildPanelDom();
    wireUiRefs(ui);
    state.selectedStop = loc;
    state._activeStationBoardType = 'DEP';
    state._activeTab = 'departures';
    state._depFilter = null;
    state._stationDepHorizon = 0;
    vi.spyOn(ui, 'discoverPlatforms').mockImplementation(() => {});
    vi.spyOn(ui, 'buildLineFilter').mockImplementation(() => {});
    vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
    vi.spyOn(ui, 'renderDepartures').mockReturnValue([{}]);
  });
  afterEach(() => vi.restoreAllMocks());

  it('uses computeInitialHorizon when a server clock is available', async () => {
    state.serverTimeMin = 720;
    state.serverTimeStamp = Date.now();
    getStationBoard.mockResolvedValueOnce({
      jnyL: [{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { dTimeS: '150000' } }],
      common: { prodL: [{ nameS: '721' }], locL: [] },
    });
    await ui.loadDepartures(loc, '', true);
    await settle();
    // 15:00 (900) is well beyond now+60 (~780) → the horizon stretches to it,
    // proving computeInitialHorizon ran (not the Infinity cold-open arm). Using a
    // far departure keeps the assertion immune to the sub-minute clock drift that
    // derivedServerNowMin adds to "now".
    expect(state._stationDepHorizon).toBe(900);
  });

  it('falls back to an Infinity horizon on a cold open (no server clock)', async () => {
    state.serverTimeMin = null;
    state.serverTimeStamp = null;
    getStationBoard.mockResolvedValueOnce({ jnyL: [], common: {} });
    await ui.loadDepartures(loc, '', true);
    await settle();
    expect(state._stationDepHorizon).toBe(Infinity);
  });

  it('tolerates a resolved board with no jnyL key (data.jnyL || [] arm)', async () => {
    state.serverTimeMin = 720;
    state.serverTimeStamp = Date.now();
    getStationBoard.mockResolvedValueOnce({ common: {} }); // no jnyL key
    await ui.loadDepartures(loc, '', true);
    await settle();
    // computeInitialHorizon([]) → now+60, a finite horizon (not the Infinity arm).
    expect(Number.isFinite(state._stationDepHorizon)).toBe(true);
    expect(state._stationDepHorizon).toBeGreaterThan(720);
  });
});

describe('_loadBoard — subscribeBoard .catch no-op arms', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildPanelDom();
    wireUiRefs(ui);
    state.selectedStop = loc;
    state.serverTimeMin = 720;
    state.serverTimeStamp = Date.now();
    state._stationDepHorizon = 0;
    vi.spyOn(ui, 'discoverPlatforms').mockImplementation(() => {});
    vi.spyOn(ui, 'buildLineFilter').mockImplementation(() => {});
    vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
    vi.spyOn(ui, 'renderDepartures').mockReturnValue([{}]);
  });
  afterEach(() => vi.restoreAllMocks());

  it('swallows a rejected subscribe on the success path', async () => {
    state._activeStationBoardType = 'DEP';
    subscribeBoard.mockReturnValueOnce(Promise.reject(new Error('subscribe failed')));
    getStationBoard.mockResolvedValueOnce({ jnyL: [], common: {} });
    await ui.loadDepartures(loc, '', true);
    await settle();
    expect(subscribeBoard).toHaveBeenCalledWith(loc.lid, 'DEP');
  });

  it('swallows a rejected subscribe on the error path', async () => {
    state._activeStationBoardType = 'DEP';
    subscribeBoard.mockReturnValueOnce(Promise.reject(new Error('subscribe failed')));
    getStationBoard.mockReturnValueOnce(Promise.reject(new Error('rate_limit')));
    await ui.loadDepartures(loc, '', true);
    await settle();
    expect(state._stationDepRetryAt).toBeGreaterThan(0);
    expect(subscribeBoard).toHaveBeenCalledWith(loc.lid, 'DEP');
  });

  it('tolerates the error path when the list element is absent (if (listEl) else arm)', async () => {
    state._activeStationBoardType = 'DEP';
    document.body.innerHTML = ''; // no #departure-list → listEl null
    getStationBoard.mockReturnValueOnce(Promise.reject(new Error('rate_limit')));
    await ui.loadDepartures(loc, '', true);
    await settle();
    expect(state._stationDepRetryAt).toBeGreaterThan(0); // reached the catch, no throw
  });
});

describe('_renderBoard — null-data guard', () => {
  beforeEach(() => {
    buildPanelDom();
    wireUiRefs(ui);
  });

  it('returns early when the board has not been cached yet', () => {
    state._stationDepData = null;
    const renderSpy = vi.spyOn(ui, 'renderDepartures').mockImplementation(() => {});
    ui._renderBoard('DEP', loc, '');
    expect(renderSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe('addLoadMoreButton — no-beyond + empty-cache click arms', () => {
  beforeEach(() => {
    document.body.innerHTML = '<ul id="dl"></ul>';
    state._activeStationBoardType = 'DEP';
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows the hint (no button) when a cache exists but nothing lies beyond the horizon', () => {
    state._stationDepData = {
      jnyL: [{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { dTimeS: '120000' } }],
      common: { prodL: [{ nameS: '721' }], locL: [] },
    };
    state._stationDepHorizon = 720; // the only departure is at the horizon
    ui.addLoadMoreButton('dl', loc, '', 'DEP');
    expect(document.querySelector('.load-more-btn')).toBeNull();
    expect(document.querySelector('.load-more-item.empty-state')).not.toBeNull();
  });

  it('shows the hint when the cache exists but has no jnyL key (data.jnyL || [] arm)', () => {
    state._stationDepData = { common: {} }; // cache present, no jnyL
    state._stationDepHorizon = 720;
    ui.addLoadMoreButton('dl', loc, '', 'DEP');
    expect(document.querySelector('.load-more-btn')).toBeNull();
    expect(document.querySelector('.load-more-item.empty-state')).not.toBeNull();
  });

  it('click tolerates a cache whose jnyL is missing (d.jnyL || [] arm)', () => {
    state._stationDepData = {
      jnyL: [{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { dTimeS: '130000' } }],
      common: { prodL: [{ nameS: '721' }], locL: [] },
    };
    state._stationDepHorizon = 720; // 13:00 is beyond → button rendered
    vi.spyOn(ui, '_renderBoard').mockImplementation(() => {});
    ui.addLoadMoreButton('dl', loc, '', 'DEP');
    // Cache mutates to a jnyL-less object before the click → extendHorizon([]).
    state._stationDepData = { common: {} };
    document.querySelector('.load-more-btn').click();
    expect(ui._renderBoard).toHaveBeenCalledWith('DEP', loc, '');
  });
});

describe('switchTab — subscribeBoard .catch no-op arm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildPanelDom();
    wireUiRefs(ui);
    state.selectedStop = loc;
    vi.spyOn(ui, 'buildLineFilter').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('swallows a rejected board re-subscribe on tab switch', () => {
    state._activeStationBoardType = 'DEP';
    state._stationArrData = { jnyL: [], common: {} }; // loaded → no lazy fetch
    subscribeBoard.mockReturnValueOnce(Promise.reject(new Error('subscribe failed')));
    ui.switchTab('arrivals');
    expect(subscribeBoard).toHaveBeenCalledWith(loc.lid, 'ARR');
  });
});

describe('applyPushedStationboard — dedup sig is not committed before the server clock', () => {
  const cacheBoard = { jnyL: [], common: { prodL: [], locL: [] } };
  beforeEach(() => {
    vi.clearAllMocks();
    buildPanelDom();
    wireUiRefs(ui);
    state.selectedStop = loc;
    state._stationExtId = '';
    state._activeTab = 'departures';
    state._stationDepFetching = false;
    state._stationArrFetching = false;
    state._stationDepHorizon = 100000;
    state._stationDepData = cacheBoard;
    state._lastDepSig = null;
    vi.spyOn(ui, 'buildLineFilter').mockImplementation(() => {});
    vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('skips without poisoning _lastDepSig when the clock is unknown, then reconciles once it arrives', () => {
    const renderSpy = vi.spyOn(ui, 'renderDepartures').mockImplementation(() => {});
    const push = {
      jnyL: [{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { dTimeS: '120000' } }],
      common: {},
    };
    // Clock unknown → skip, and crucially do NOT record the signature.
    state.serverTimeMin = null;
    state.serverTimeStamp = null;
    ui.applyPushedStationboard(loc, push, 'DEP');
    expect(renderSpy).not.toHaveBeenCalled();
    expect(state._lastDepSig).toBeNull(); // sig NOT committed
    // Clock arrives; the SAME push must now reconcile (not be dropped as a dup).
    state.serverTimeMin = 720;
    state.serverTimeStamp = Date.now();
    ui.applyPushedStationboard(loc, push, 'DEP');
    expect(renderSpy).toHaveBeenCalled();
    expect(state._lastDepSig).not.toBeNull();
  });
});

describe('_loadBoard — resets the dedup sig on a fresh (re)fetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildPanelDom();
    wireUiRefs(ui);
    state.selectedStop = loc;
    state._activeStationBoardType = 'DEP';
    state._activeTab = 'departures';
    state.serverTimeMin = 720;
    state.serverTimeStamp = Date.now();
    state._stationDepHorizon = 0;
    vi.spyOn(ui, 'discoverPlatforms').mockImplementation(() => {});
    vi.spyOn(ui, 'buildLineFilter').mockImplementation(() => {});
    vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
    vi.spyOn(ui, 'renderDepartures').mockReturnValue([{}]);
  });
  afterEach(() => vi.restoreAllMocks());

  it('nulls _lastDepSig so the first post-refetch push reconciles onto the fresh board', async () => {
    state._lastDepSig = 'STALE-FROM-BEFORE-REFETCH';
    getStationBoard.mockResolvedValueOnce({ jnyL: [], common: {} });
    await ui.loadDepartures(loc, '', false);
    await settle();
    expect(state._lastDepSig).toBeNull();
  });
});

describe('_renderBoard — horizon never lags the wall clock (re-base)', () => {
  const board = {
    jnyL: [{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { dTimeS: '133000' } }], // 13:30 = 810
    common: { prodL: [{ nameS: '721' }], locL: [] },
  };
  beforeEach(() => {
    buildPanelDom();
    wireUiRefs(ui);
    state.selectedStop = loc;
    state._activeTab = 'departures';
    state._depFilter = null;
    state._stationDepData = board;
    state.serverTimeStamp = Date.now();
    vi.spyOn(ui, 'renderDepartures').mockReturnValue([{}]);
    vi.spyOn(ui, 'buildLineFilter').mockImplementation(() => {});
    vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('re-bases a sticky Infinity horizon to a finite window once the clock is known', () => {
    state.serverTimeMin = 720; // 12:00
    state._stationDepHorizon = Infinity;
    ui._renderBoard('DEP', loc, '');
    expect(Number.isFinite(state._stationDepHorizon)).toBe(true);
    expect(state._stationDepHorizon).toBe(810); // stretches to the 13:30 departure
  });

  it('advances a horizon that has drifted behind now', () => {
    state.serverTimeMin = 720; // 12:00 → now+60 = 780
    state._stationDepHorizon = 700; // behind now → re-base
    ui._renderBoard('DEP', loc, '');
    expect(state._stationDepHorizon).toBe(810);
  });

  it('preserves a user load-more extension that is still ahead of now', () => {
    state.serverTimeMin = 720;
    state._stationDepHorizon = 1200; // 20:00, well ahead of now+60 → untouched
    ui._renderBoard('DEP', loc, '');
    expect(state._stationDepHorizon).toBe(1200);
  });

  it('leaves the horizon alone when no server clock is available yet', () => {
    state.serverTimeMin = null;
    state.serverTimeStamp = null;
    state._stationDepHorizon = Infinity;
    ui._renderBoard('DEP', loc, '');
    expect(state._stationDepHorizon).toBe(Infinity);
  });

  it('re-bases with the || [] fallback when the cached board has no jnyL key', () => {
    state.serverTimeMin = 720;
    state._stationDepData = { common: {} }; // no jnyL → computeInitialHorizon(data.jnyL || [])
    state._stationDepHorizon = Infinity;
    ui._renderBoard('DEP', loc, '');
    // Empty board → now+60; allow for the sub-minute drift derivedServerNowMin adds.
    expect(Number.isFinite(state._stationDepHorizon)).toBe(true);
    expect(state._stationDepHorizon).toBeCloseTo(780, 0);
  });
});

describe('_renderBoard / applyPushed — re-PIV edge assertions', () => {
  const depBoard = {
    jnyL: [{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { dTimeS: '133000' } }], // 810
    common: { prodL: [{ nameS: '721' }], locL: [] },
  };
  beforeEach(() => {
    vi.clearAllMocks();
    buildPanelDom();
    wireUiRefs(ui);
    state.selectedStop = loc;
    state._stationExtId = '';
    state.serverTimeStamp = Date.now();
    vi.spyOn(ui, 'renderDepartures').mockReturnValue([{}]);
    vi.spyOn(ui, 'renderArrivals').mockReturnValue([{}]);
    vi.spyOn(ui, 'buildLineFilter').mockImplementation(() => {});
    vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('does NOT re-base at the exact boundary horizon === nowMin + 60 (strict <)', () => {
    state._activeTab = 'departures';
    state._stationDepData = depBoard;
    state.serverTimeMin = 720;
    // Freeze the clock so derivedServerNowMin() is exactly 720 (no drift): stamp
    // in the future by the elapsed amount is impossible, so assert via a horizon
    // that is provably >= now+60 for any tiny drift, then a below-boundary one.
    state._stationDepHorizon = 781; // > 720+60 (+drift) → preserved (no re-base to 810)
    ui._renderBoard('DEP', loc, '');
    expect(state._stationDepHorizon).toBe(781);
  });

  it('re-bases the ARR horizon too (Infinity → finite) with the ARR value', () => {
    state._activeTab = 'arrivals';
    state._stationArrData = {
      jnyL: [{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { aTimeS: '133000' } }], // 810
      common: { prodL: [{ nameS: '721' }], locL: [] },
    };
    state.serverTimeMin = 720;
    state._stationArrHorizon = Infinity;
    ui._renderBoard('ARR', loc, '');
    expect(state._stationArrHorizon).toBe(810);
  });

  it('chained Fix3+Fix2: a refetch nulls the sig so the first identical push reconciles (ARR)', () => {
    // Fresh ARR board (as if _loadBoard just resolved and reset the sig).
    state._activeTab = 'arrivals';
    state._stationArrData = { jnyL: [], common: { prodL: [], locL: [] } };
    state._stationArrHorizon = 100000;
    state._lastArrSig = null; // reset by the (re)fetch
    state.serverTimeMin = 720;
    const push = {
      jnyL: [{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { aTimeS: '120000' } }],
      common: {},
    };
    ui.applyPushedStationboard(loc, push, 'ARR');
    expect(ui.renderArrivals).toHaveBeenCalled(); // reconciled, not dropped as a dup
    expect(state._lastArrSig).not.toBeNull();
  });
});
