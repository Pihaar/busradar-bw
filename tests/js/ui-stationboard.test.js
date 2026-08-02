/**
 * Coverage for the stationboard side of static/ui.js: renderDepartures /
 * renderArrivals (extId platform filtering, line filtering, dedup, day-offset,
 * delay colours, HAFAS-limit hint, row-click → selectJourney/focusJourneyById),
 * discoverPlatforms, applyPushedStationboard (DEP/ARR + de-dup signature),
 * showStationBoard, and the loadDepartures/loadArrivals happy paths.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildPanelDom, wireUiRefs } from './ui-dom.js';

globalThis.L = {
  latLng: (lat, lon) => ({ lat, lng: lon }),
  circleMarker: vi.fn(() => ({ addTo: vi.fn(), remove: vi.fn() })),
};

const selectStream = vi.fn(() => Promise.resolve());
const subscribeBoard = vi.fn(() => Promise.resolve({}));
const getStationBoard = vi.fn();
vi.mock('../../static/api.js', () => ({
  trackedFetch: (...a) => window.fetch(...a),
  api: {
    subscribeBoard: (...a) => subscribeBoard(...a),
    getStationBoard: (...a) => getStationBoard(...a),
    getJourney: vi.fn(() => new Promise(() => {})),
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
const { stopsLayer } = await import('../../static/map.js');
const { urlState } = await import('../../static/api.js');

beforeEach(() => {
  vi.clearAllMocks();
  buildPanelDom();
  wireUiRefs(ui);
  state.selectedStop = { lid: 'A=1@L=1@' };
  state._depFilter = null;
  state._arrFilter = null;
  state._stationDepFetching = false;
  state._stationArrFetching = false;
  state._stationDepDur = 60;
  state._stationArrDur = 60;
  // The hint check at the tail of renderDepartures/renderArrivals reads the full
  // board length off state; give it an empty board so a normal render sees < limit.
  state._stationDepData = { jnyL: [], common: { prodL: [], locL: [] } };
  state._stationArrData = { jnyL: [], common: { prodL: [], locL: [] } };
  state.vehicles = new Map();
  state.allStops = new Map();
  state.map = { setView: vi.fn() };
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const loc = { lid: 'A=1@L=1@', name: 'Sandhausen' };

function depData(jnyL, extra) {
  return Object.assign(
    { jnyL, common: { prodL: [{ nameS: '721', name: 'Bus 721' }], locL: [] } },
    extra || {},
  );
}

describe('ui.renderDepartures — rows & formatting', () => {
  it('renders a row per departure with line, dest, time', () => {
    const data = depData([
      { jid: 'A', prodX: 0, dirTxt: 'Ziel 1', stbStop: { dTimeS: '120000' } },
      { jid: 'B', prodX: 0, dirTxt: 'Ziel 2', stbStop: { dTimeS: '121000' } },
    ]);
    ui.renderDepartures(data, null);
    expect(ui.departureList.querySelectorAll('.departure-item').length).toBe(2);
    expect(ui.departureList.querySelector('.departure-line').textContent).toBe('721');
  });

  it('shows planned + real spans when the departure is delayed', () => {
    const data = depData([
      { jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { dTimeS: '120000', dTimeR: '120500' } },
    ]);
    ui.renderDepartures(data, null);
    expect(ui.departureList.querySelector('.stop-time-planned')).not.toBeNull();
    expect(ui.departureList.querySelector('.stop-time-real')).not.toBeNull();
  });

  it('falls back to "?" for a missing product name', () => {
    const data = {
      jnyL: [{ jid: 'A', dirTxt: 'X', stbStop: { dTimeS: '120000' } }],
      common: { prodL: [], locL: [] },
    };
    ui.renderDepartures(data, null);
    expect(ui.departureList.querySelector('.departure-line').textContent).toBe('?');
  });

  it('dedups identical prodX|time|dir entries', () => {
    const data = depData([
      { jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { dTimeS: '120000' } },
      { jid: 'B', prodX: 0, dirTxt: 'X', stbStop: { dTimeS: '120000' } },
    ]);
    ui.renderDepartures(data, null);
    expect(ui.departureList.querySelectorAll('.departure-item').length).toBe(1);
  });

  it('adds a day-offset badge when jny.date is after data.sD', () => {
    const data = depData(
      [{ jid: 'A', prodX: 0, dirTxt: 'X', date: '20260201', stbStop: { dTimeS: '000500' } }],
      { sD: '20260131' },
    );
    ui.renderDepartures(data, null);
    expect(ui.departureList.querySelector('.departure-day-badge')).not.toBeNull();
  });

  it('applies the line filter', () => {
    const data = {
      jnyL: [
        { jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { dTimeS: '120000' } },
        { jid: 'B', prodX: 1, dirTxt: 'Y', stbStop: { dTimeS: '121000' } },
      ],
      common: { prodL: [{ nameS: '721' }, { nameS: '705' }], locL: [] },
    };
    ui.renderDepartures(data, '705');
    expect(ui.departureList.querySelectorAll('.departure-item').length).toBe(1);
    expect(ui.departureList.querySelector('.departure-line').textContent).toBe('705');
  });

  it('appends the HAFAS-limit hint when jnyL hits the limit', () => {
    const jnyL = [];
    for (let i = 0; i < 50; i++)
      jnyL.push({ jid: 'J' + i, prodX: 0, dirTxt: 'D' + i, stbStop: { dTimeS: hhmmssI(i) } });
    // The hint reads the full board length off state, not the passed data.
    state._stationDepData = depData(jnyL);
    ui.renderDepartures(depData(jnyL), null);
    expect(ui.departureList.querySelector('.hafas-hint')).not.toBeNull();
  });

  it('row click on a bus already on the map selects the journey', () => {
    state.vehicles = new Map([['A', { data: { lat: 49.3, lon: 8.6, jid: 'A' } }]]);
    const sel = vi.spyOn(ui, 'selectJourney').mockImplementation(() => {});
    ui.renderDepartures(
      depData([{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { dTimeS: '120000' } }]),
      null,
    );
    ui.departureList.querySelector('.departure-item').click();
    expect(state.map.setView).toHaveBeenCalled();
    expect(sel).toHaveBeenCalled();
  });

  it('row click on a bus not on the map focuses by id', () => {
    const foc = vi.spyOn(ui, 'focusJourneyById').mockImplementation(() => {});
    ui.renderDepartures(
      depData([{ jid: 'Z', prodX: 0, dirTxt: 'X', stbStop: { dTimeS: '120000' } }]),
      null,
    );
    ui.departureList.querySelector('.departure-item').click();
    expect(foc).toHaveBeenCalledWith('Z', expect.any(Object));
  });

  it('a departure without a jid is not clickable (no cursor pointer)', () => {
    ui.renderDepartures(depData([{ prodX: 0, dirTxt: 'X', stbStop: { dTimeS: '120000' } }]), null);
    expect(ui.departureList.querySelector('.departure-item').style.cursor).toBe('');
  });
});

describe('ui.renderArrivals', () => {
  function arrData(jnyL, extra) {
    return Object.assign(
      { jnyL, common: { prodL: [{ nameS: '721', name: 'Bus 721' }], locL: [] } },
      extra || {},
    );
  }

  it('renders arrival rows with the from-prefix', () => {
    ui.renderArrivals(
      arrData([{ jid: 'A', prodX: 0, dirTxt: 'Herkunft', stbStop: { aTimeS: '120000' } }]),
      null,
    );
    const dest = document.getElementById('arrival-list').querySelector('.departure-dest');
    expect(dest.textContent).toContain('Herkunft');
  });

  it('shows an empty-state (minutes) when no arrivals', () => {
    ui.renderArrivals(arrData([]), null);
    expect(document.getElementById('arrival-list').querySelector('.empty-state')).not.toBeNull();
  });

  it('shows the 24h empty-state at dur >= 1440', () => {
    state._stationArrDur = 1440;
    ui.renderArrivals(arrData([]), null);
    expect(document.getElementById('arrival-list').querySelector('.empty-state')).not.toBeNull();
  });

  it('shows the hours empty-state at dur >= 120', () => {
    state._stationArrDur = 180;
    ui.renderArrivals(arrData([]), null);
    expect(document.getElementById('arrival-list').querySelector('.empty-state')).not.toBeNull();
  });

  it('keeps a shown list while an expand cascade returns none', () => {
    const arrList = document.getElementById('arrival-list');
    const li = document.createElement('li');
    li.className = 'departure-item';
    arrList.appendChild(li);
    state._stationArrFetching = true;
    state._stationArrDur = 480;
    ui.renderArrivals(arrData([]), null);
    expect(arrList.querySelectorAll('.departure-item').length).toBe(1);
  });

  it('row click on an on-map bus selects the journey', () => {
    state.vehicles = new Map([['A', { data: { lat: 49.3, lon: 8.6, jid: 'A' } }]]);
    const sel = vi.spyOn(ui, 'selectJourney').mockImplementation(() => {});
    ui.renderArrivals(
      arrData([{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { aTimeS: '120000' } }]),
      null,
    );
    document.getElementById('arrival-list').querySelector('.departure-item').click();
    expect(sel).toHaveBeenCalled();
  });

  it('appends the HAFAS-limit hint at the arrival limit', () => {
    const jnyL = [];
    for (let i = 0; i < 50; i++)
      jnyL.push({ jid: 'J' + i, prodX: 0, dirTxt: 'D' + i, stbStop: { aTimeS: hhmmssI(i) } });
    // The hint reads the full board length off state, not the passed data.
    state._stationArrData = arrData(jnyL);
    ui.renderArrivals(arrData(jnyL), null);
    expect(document.getElementById('arrival-list').querySelector('.hafas-hint')).not.toBeNull();
  });
});

describe('ui.discoverPlatforms', () => {
  it('adds a platform marker for a physical stop and saves the cache', () => {
    const data = {
      common: {
        locL: [
          {
            lid: 'A=1@L=2@',
            name: 'S Steig 2',
            extId: 'E2',
            crd: { x: 8600000, y: 49300000 },
            gidL: ['b×foo', 'A×x:y:z:w:2'],
          },
        ],
      },
    };
    ui.discoverPlatforms(data);
    expect(stopsLayer.addStopMarker).toHaveBeenCalledWith(
      expect.objectContaining({ platform: '2' }),
    );
    expect(stopsLayer.saveToCache).toHaveBeenCalled();
  });

  it('skips a loc already known, without a physical-stop gid, or at 0/0', () => {
    state.allStops = new Map([['A=1@L=known@', {}]]);
    const data = {
      common: {
        locL: [
          { lid: 'A=1@L=known@', crd: { x: 1, y: 1 } }, // already known
          { lid: 'A=1@L=nophys@', crd: { x: 8600000, y: 49300000 }, gidL: ['x×foo'] }, // no b×
          { lid: 'A=1@L=zero@', crd: { x: 0, y: 0 }, gidL: ['b×foo'] }, // 0/0
          { name: 'no lid', crd: { x: 1, y: 1 } }, // no lid
        ],
      },
    };
    ui.discoverPlatforms(data);
    expect(stopsLayer.addStopMarker).not.toHaveBeenCalled();
    expect(stopsLayer.saveToCache).not.toHaveBeenCalled();
  });
});

describe('ui.applyPushedStationboard', () => {
  beforeEach(() => {
    state._lastDepSig = null;
    state._lastArrSig = null;
    // The push now RECONCILES into a cached full-day board, so a base cache and
    // a server clock (for the Soll ≤ now+120 window) must exist; the stop's
    // extId comes from state._stationExtId (set by showStationBoard), not loc.
    state._stationExtId = '1';
    state._stationDepHorizon = 100000;
    state._stationArrHorizon = 100000;
    state._activeTab = 'departures';
    state.serverTimeMin = 720;
    state.serverTimeStamp = Date.now();
    state._stationDepData = { jnyL: [], common: { prodL: [], locL: [] } };
    state._stationArrData = { jnyL: [], common: { prodL: [], locL: [] } };
    vi.spyOn(ui, 'buildLineFilter').mockImplementation(() => {});
  });

  it('reconciles a DEP push and remembers its signature', () => {
    const renderSpy = vi.spyOn(ui, 'renderDepartures').mockImplementation(() => {});
    const lmSpy = vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
    const data = {
      jnyL: [{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { dTimeS: '120000' } }],
      common: { prodL: [], locL: [] },
    };
    ui.applyPushedStationboard(loc, data, 'DEP');
    expect(renderSpy).toHaveBeenCalled();
    expect(lmSpy).toHaveBeenCalledWith('departure-list', loc, '1', 'DEP');
    expect(state._lastDepSig).not.toBeNull();
  });

  it('skips a duplicate DEP push (same signature)', () => {
    const data = {
      jnyL: [{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { dTimeS: '120000' } }],
      common: { prodL: [], locL: [] },
    };
    ui.applyPushedStationboard(loc, data, 'DEP');
    const renderSpy = vi.spyOn(ui, 'renderDepartures').mockImplementation(() => {});
    ui.applyPushedStationboard(loc, data, 'DEP'); // identical → skipped
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('reconciles an ARR push', () => {
    state._activeTab = 'arrivals';
    const renderSpy = vi.spyOn(ui, 'renderArrivals').mockImplementation(() => {});
    vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
    const data = {
      jnyL: [{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { aTimeS: '120000' } }],
      common: { prodL: [], locL: [] },
    };
    ui.applyPushedStationboard(loc, data, 'ARR');
    expect(renderSpy).toHaveBeenCalled();
  });

  it('skips a duplicate ARR push', () => {
    state._activeTab = 'arrivals';
    const data = {
      jnyL: [{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { aTimeS: '120000' } }],
      common: { prodL: [], locL: [] },
    };
    ui.applyPushedStationboard(loc, data, 'ARR');
    const renderSpy = vi.spyOn(ui, 'renderArrivals').mockImplementation(() => {});
    ui.applyPushedStationboard(loc, data, 'ARR');
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('bails out while a full (re)fetch is in flight', () => {
    state._stationDepFetching = true;
    const renderSpy = vi.spyOn(ui, 'renderDepartures').mockImplementation(() => {});
    ui.applyPushedStationboard(loc, { jnyL: [], common: {} }, 'DEP');
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('bails out when the pushed stop is no longer selected', () => {
    state.selectedStop = { lid: 'OTHER' };
    const renderSpy = vi.spyOn(ui, 'renderDepartures').mockImplementation(() => {});
    ui.applyPushedStationboard(loc, { jnyL: [], common: {} }, 'DEP');
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('bails out when the base board has not been fetched yet (cache null)', () => {
    state._stationDepData = null;
    const renderSpy = vi.spyOn(ui, 'renderDepartures').mockImplementation(() => {});
    ui.applyPushedStationboard(loc, { jnyL: [], common: {} }, 'DEP');
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('bails out when no server clock has arrived (would be a NaN window)', () => {
    state.serverTimeMin = null;
    state.serverTimeStamp = null;
    const renderSpy = vi.spyOn(ui, 'renderDepartures').mockImplementation(() => {});
    ui.applyPushedStationboard(loc, { jnyL: [], common: {} }, 'DEP');
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('renders with the extId held in state (set by showStationBoard), not re-derived from loc', () => {
    state._stationExtId = '6003411';
    const renderSpy = vi.spyOn(ui, 'renderDepartures').mockImplementation(() => {});
    const lmSpy = vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
    const stop = { lid: 'A=1@L=6003411@', name: 'S' };
    state.selectedStop = stop;
    ui.applyPushedStationboard(stop, { jnyL: [{ jid: 'A', stbStop: {} }], common: {} }, 'DEP');
    expect(renderSpy).toHaveBeenCalled();
    // The state-held extId flows through _renderBoard to the load-more button.
    expect(lmSpy).toHaveBeenCalledWith('departure-list', stop, '6003411', 'DEP');
  });
});

describe('ui.showStationBoard', () => {
  beforeEach(() => {
    getStationBoard.mockReturnValue(new Promise(() => {}));
    state.map = {
      setView: vi.fn(),
      getCenter: () => ({ lat: 49.3, lng: 8.6 }),
      getZoom: () => 14,
    };
    state.panelState = 'hidden';
    vi.spyOn(ui, '_disableFollow').mockImplementation(() => {});
    vi.spyOn(ui, 'clearRoute').mockImplementation(() => {});
    vi.spyOn(ui, 'setTabMode').mockImplementation(() => {});
    vi.spyOn(ui, 'switchTab').mockImplementation(() => {});
    vi.spyOn(ui, 'hideLineFilter').mockImplementation(() => {});
    vi.spyOn(ui, 'loadDepartures').mockReturnValue({ finally: (cb) => cb() });
    vi.spyOn(ui, 'loadArrivals').mockImplementation(() => {});
  });

  it('sets the header to the stop name and half-opens the panel', () => {
    ui.showStationBoard({ lid: 'A=1@L=1@', name: 'Sandhausen', extId: 'E1', lat: 49.3, lon: 8.6 });
    expect(ui.detailDir.textContent).toContain('Sandhausen');
    expect(state.selectedStop.name).toBe('Sandhausen');
    expect(ui.loadDepartures).toHaveBeenCalled();
  });

  it('appends the platform label when present', () => {
    ui.showStationBoard({ lid: 'A=1@L=1@', name: 'S', platform: '3', lat: 49.3, lon: 8.6 });
    expect(ui.detailDir.textContent).toContain('3');
  });

  it('derives the extId from the lid when none is given', () => {
    ui.showStationBoard({ lid: 'A=1@L=6003411@', name: 'S' });
    expect(state._stationExtId).toBe('6003411');
  });

  it('pushes history when an extId is present and skipHistory is falsy', () => {
    ui.showStationBoard({ lid: 'A=1@L=1@', name: 'S', extId: 'E1', lat: 49.3, lon: 8.6 });
    expect(urlState.push).toHaveBeenCalled();
  });

  it('does NOT eagerly load arrivals on open (ARR is lazy, loaded on first tab switch)', () => {
    const stop = { lid: 'A=1@L=1@', name: 'S', extId: 'E1' };
    ui.showStationBoard(stop);
    expect(ui.loadDepartures).toHaveBeenCalled();
    expect(ui.loadArrivals).not.toHaveBeenCalled();
  });
});

describe('ui.loadDepartures / loadArrivals happy path', () => {
  beforeEach(() => {
    vi.spyOn(ui, 'renderDepartures').mockReturnValue([{}, {}]);
    vi.spyOn(ui, 'renderArrivals').mockReturnValue([{}]);
    vi.spyOn(ui, 'discoverPlatforms').mockImplementation(() => {});
    vi.spyOn(ui, 'buildLineFilter').mockImplementation(() => {});
    vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
    state._activeStationBoardType = 'DEP';
    state._activeTab = 'departures';
  });

  it('loadDepartures renders, builds the filter, and subscribes the SSE board', async () => {
    getStationBoard.mockResolvedValue(depData([]));
    state.selectedStop = loc;
    await ui.loadDepartures(loc, '1', true);
    expect(ui.renderDepartures).toHaveBeenCalled();
    expect(ui.addLoadMoreButton).toHaveBeenCalled();
    expect(subscribeBoard).toHaveBeenCalledWith(loc.lid, 'DEP');
  });

  it('loadDepartures bails when the stop was deselected before the response', async () => {
    getStationBoard.mockResolvedValue(depData([]));
    state.selectedStop = { lid: 'OTHER' };
    await ui.loadDepartures(loc, '1', true);
    expect(ui.renderDepartures).not.toHaveBeenCalled();
    expect(state._stationDepFetching).toBe(false);
  });

  it('loadArrivals renders and subscribes when ARR is active', async () => {
    getStationBoard.mockResolvedValue({ jnyL: [], common: { prodL: [], locL: [] } });
    state.selectedStop = loc;
    state._activeStationBoardType = 'ARR';
    state._activeTab = 'arrivals';
    await ui.loadArrivals(loc, '1');
    expect(ui.renderArrivals).toHaveBeenCalled();
    expect(subscribeBoard).toHaveBeenCalledWith(loc.lid, 'ARR');
  });

  it('loadArrivals bails when the stop was deselected', async () => {
    getStationBoard.mockResolvedValue({ jnyL: [], common: {} });
    state.selectedStop = { lid: 'OTHER' };
    await ui.loadArrivals(loc, '1');
    expect(ui.renderArrivals).not.toHaveBeenCalled();
  });
});

// HAFAS HHMMSS for an index i (distinct times to defeat the dedup).
function hhmmssI(i) {
  const total = 720 + i; // 12:00 + i minutes
  const h = String(Math.floor(total / 60)).padStart(2, '0');
  const m = String(total % 60).padStart(2, '0');
  return h + m + '00';
}
