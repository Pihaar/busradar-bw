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
const getStationBoard = vi.fn();
vi.mock('../../static/api.js', () => ({
  trackedFetch: (...a) => window.fetch(...a),
  api: {
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
  state._autoExpandingDep = false;
  state._autoExpandingArr = false;
  state._stationDepDur = 60;
  state._stationArrDur = 60;
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
    ui.renderDepartures(data, loc, '', null);
    expect(ui.departureList.querySelectorAll('.departure-item').length).toBe(2);
    expect(ui.departureList.querySelector('.departure-line').textContent).toBe('721');
  });

  it('shows planned + real spans when the departure is delayed', () => {
    const data = depData([
      { jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { dTimeS: '120000', dTimeR: '120500' } },
    ]);
    ui.renderDepartures(data, loc, '', null);
    expect(ui.departureList.querySelector('.stop-time-planned')).not.toBeNull();
    expect(ui.departureList.querySelector('.stop-time-real')).not.toBeNull();
  });

  it('falls back to "?" for a missing product name', () => {
    const data = {
      jnyL: [{ jid: 'A', dirTxt: 'X', stbStop: { dTimeS: '120000' } }],
      common: { prodL: [], locL: [] },
    };
    ui.renderDepartures(data, loc, '', null);
    expect(ui.departureList.querySelector('.departure-line').textContent).toBe('?');
  });

  it('dedups identical prodX|time|dir entries', () => {
    const data = depData([
      { jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { dTimeS: '120000' } },
      { jid: 'B', prodX: 0, dirTxt: 'X', stbStop: { dTimeS: '120000' } },
    ]);
    ui.renderDepartures(data, loc, '', null);
    expect(ui.departureList.querySelectorAll('.departure-item').length).toBe(1);
  });

  it('adds a day-offset badge when jny.date is after data.sD', () => {
    const data = depData(
      [{ jid: 'A', prodX: 0, dirTxt: 'X', date: '20260201', stbStop: { dTimeS: '000500' } }],
      { sD: '20260131' },
    );
    ui.renderDepartures(data, loc, '', null);
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
    ui.renderDepartures(data, loc, '', '705');
    expect(ui.departureList.querySelectorAll('.departure-item').length).toBe(1);
    expect(ui.departureList.querySelector('.departure-line').textContent).toBe('705');
  });

  it('appends the HAFAS-limit hint when jnyL hits the limit', () => {
    const jnyL = [];
    for (let i = 0; i < 50; i++)
      jnyL.push({ jid: 'J' + i, prodX: 0, dirTxt: 'D' + i, stbStop: { dTimeS: hhmmssI(i) } });
    ui.renderDepartures(depData(jnyL), loc, '', null);
    expect(ui.departureList.querySelector('.hafas-hint')).not.toBeNull();
  });

  it('row click on a bus already on the map selects the journey', () => {
    state.vehicles = new Map([['A', { data: { lat: 49.3, lon: 8.6, jid: 'A' } }]]);
    const sel = vi.spyOn(ui, 'selectJourney').mockImplementation(() => {});
    ui.renderDepartures(
      depData([{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { dTimeS: '120000' } }]),
      loc,
      '',
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
      loc,
      '',
      null,
    );
    ui.departureList.querySelector('.departure-item').click();
    expect(foc).toHaveBeenCalledWith('Z', expect.any(Object));
  });

  it('a departure without a jid is not clickable (no cursor pointer)', () => {
    ui.renderDepartures(
      depData([{ prodX: 0, dirTxt: 'X', stbStop: { dTimeS: '120000' } }]),
      loc,
      '',
      null,
    );
    expect(ui.departureList.querySelector('.departure-item').style.cursor).toBe('');
  });
});

describe('ui.renderDepartures — extId platform filtering', () => {
  it('filters to the exact extId when loc has a platform', () => {
    const data = {
      jnyL: [
        { jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { locX: 0, dTimeS: '120000' } },
        { jid: 'B', prodX: 0, dirTxt: 'Y', stbStop: { locX: 1, dTimeS: '121000' } },
      ],
      common: { prodL: [{ nameS: '721' }], locL: [{ extId: 'E1' }, { extId: 'E2' }] },
    };
    ui.renderDepartures(data, { name: 'S', platform: '2' }, 'E1', null);
    expect(ui.departureList.querySelectorAll('.departure-item').length).toBe(1);
  });

  it('filters when sibling platforms are > 1m apart (no explicit platform)', () => {
    const data = {
      jnyL: [{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { locX: 0, dTimeS: '120000' } }],
      common: {
        prodL: [{ nameS: '721' }],
        locL: [
          { extId: 'E1', name: 'S', crd: { x: 8600000, y: 49300000 } },
          { extId: 'E9', name: 'S', crd: { x: 8700000, y: 49400000 } }, // far sibling
        ],
      },
    };
    ui.renderDepartures(data, { name: 'S' }, 'E1', null);
    expect(ui.departureList.querySelectorAll('.departure-item').length).toBe(1);
  });

  it('does not filter when siblings are within 1m (same physical stop)', () => {
    const data = {
      jnyL: [
        { jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { locX: 0, dTimeS: '120000' } },
        { jid: 'B', prodX: 0, dirTxt: 'Y', stbStop: { locX: 1, dTimeS: '121000' } },
      ],
      common: {
        prodL: [{ nameS: '721' }],
        locL: [
          { extId: 'E1', name: 'S', crd: { x: 8600000, y: 49300000 } },
          { extId: 'E2', name: 'S', crd: { x: 8600000, y: 49300000 } },
        ],
      },
    };
    ui.renderDepartures(data, { name: 'S' }, 'E1', null);
    expect(ui.departureList.querySelectorAll('.departure-item').length).toBe(2);
  });

  it('filters by name when the extId is unknown but a same-name loc exists', () => {
    const data = {
      jnyL: [{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { locX: 0, dTimeS: '120000' } }],
      common: { prodL: [{ nameS: '721' }], locL: [{ extId: 'OTHER', name: 'S' }] },
    };
    // extId 'MISSING' unknown, but a same-name loc → shouldFilter, then the
    // filter drops rows whose stbStop.locX extId != 'MISSING' (all of them).
    ui.renderDepartures(data, { name: 'S' }, 'MISSING', null);
    expect(ui.departureList.querySelector('.empty-state')).not.toBeNull();
  });

  it('drops a row whose stbStop.locX is out of range under filtering', () => {
    const data = {
      jnyL: [{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { locX: 9, dTimeS: '120000' } }],
      common: { prodL: [{ nameS: '721' }], locL: [{ extId: 'E1' }] },
    };
    ui.renderDepartures(data, { name: 'S', platform: '2' }, 'E1', null);
    expect(ui.departureList.querySelector('.empty-state')).not.toBeNull();
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
      loc,
      '',
      null,
    );
    const dest = document.getElementById('arrival-list').querySelector('.departure-dest');
    expect(dest.textContent).toContain('Herkunft');
  });

  it('shows an empty-state (minutes) when no arrivals', () => {
    ui.renderArrivals(arrData([]), loc, '', null);
    expect(document.getElementById('arrival-list').querySelector('.empty-state')).not.toBeNull();
  });

  it('shows the 24h empty-state at dur >= 1440', () => {
    state._stationArrDur = 1440;
    ui.renderArrivals(arrData([]), loc, '', null);
    expect(document.getElementById('arrival-list').querySelector('.empty-state')).not.toBeNull();
  });

  it('shows the hours empty-state at dur >= 120', () => {
    state._stationArrDur = 180;
    ui.renderArrivals(arrData([]), loc, '', null);
    expect(document.getElementById('arrival-list').querySelector('.empty-state')).not.toBeNull();
  });

  it('keeps a shown list while an expand cascade returns none', () => {
    const arrList = document.getElementById('arrival-list');
    const li = document.createElement('li');
    li.className = 'departure-item';
    arrList.appendChild(li);
    state._autoExpandingArr = true;
    state._stationArrDur = 480;
    const ret = ui.renderArrivals(arrData([]), loc, '', null);
    expect(arrList.querySelectorAll('.departure-item').length).toBe(1);
    expect(ret).toEqual([]);
  });

  it('row click on an on-map bus selects the journey', () => {
    state.vehicles = new Map([['A', { data: { lat: 49.3, lon: 8.6, jid: 'A' } }]]);
    const sel = vi.spyOn(ui, 'selectJourney').mockImplementation(() => {});
    ui.renderArrivals(
      arrData([{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { aTimeS: '120000' } }]),
      loc,
      '',
      null,
    );
    document.getElementById('arrival-list').querySelector('.departure-item').click();
    expect(sel).toHaveBeenCalled();
  });

  it('appends the HAFAS-limit hint at the arrival limit', () => {
    const jnyL = [];
    for (let i = 0; i < 50; i++)
      jnyL.push({ jid: 'J' + i, prodX: 0, dirTxt: 'D' + i, stbStop: { aTimeS: hhmmssI(i) } });
    ui.renderArrivals(arrData(jnyL), loc, '', null);
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
  });

  it('renders a DEP push and remembers its signature', () => {
    const renderSpy = vi.spyOn(ui, 'renderDepartures').mockImplementation(() => {});
    const lmSpy = vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
    const data = {
      jnyL: [{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { dTimeS: '120000' } }],
      common: {},
    };
    ui.applyPushedStationboard(loc, data, 'DEP');
    expect(renderSpy).toHaveBeenCalled();
    expect(lmSpy).toHaveBeenCalledWith('departure-list', loc, '1', 60, 'DEP');
    expect(state._lastDepSig).not.toBeNull();
  });

  it('skips a duplicate DEP push (same signature)', () => {
    const data = {
      jnyL: [{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { dTimeS: '120000' } }],
      common: {},
    };
    ui.applyPushedStationboard(loc, data, 'DEP');
    const renderSpy = vi.spyOn(ui, 'renderDepartures').mockImplementation(() => {});
    ui.applyPushedStationboard(loc, data, 'DEP'); // identical → skipped
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('renders an ARR push', () => {
    const renderSpy = vi.spyOn(ui, 'renderArrivals').mockImplementation(() => {});
    const data = {
      jnyL: [{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { aTimeS: '120000' } }],
      common: {},
    };
    ui.applyPushedStationboard(loc, data, 'ARR');
    expect(renderSpy).toHaveBeenCalled();
  });

  it('skips a duplicate ARR push', () => {
    const data = {
      jnyL: [{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { aTimeS: '120000' } }],
      common: {},
    };
    ui.applyPushedStationboard(loc, data, 'ARR');
    const renderSpy = vi.spyOn(ui, 'renderArrivals').mockImplementation(() => {});
    ui.applyPushedStationboard(loc, data, 'ARR');
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('bails out while an expand cascade is in flight', () => {
    state._autoExpandingDep = true;
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

  it('derives stopExtId from the lid when loc has none', () => {
    const renderSpy = vi.spyOn(ui, 'renderDepartures').mockImplementation(() => {});
    vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
    const stop = { lid: 'A=1@L=6003411@', name: 'S' };
    state.selectedStop = stop;
    ui.applyPushedStationboard(stop, { jnyL: [{ jid: 'A', stbStop: {} }], common: {} }, 'DEP');
    expect(renderSpy).toHaveBeenCalledWith(expect.anything(), stop, '6003411', null);
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

  it('chains loadArrivals after loadDepartures settles for the same stop', () => {
    const stop = { lid: 'A=1@L=1@', name: 'S', extId: 'E1' };
    ui.loadDepartures.mockReturnValue({
      finally: (cb) => {
        state.selectedStop = stop; // still selected when the cascade settles
        cb();
        return { finally: () => {} };
      },
    });
    ui.showStationBoard(stop);
    expect(ui.loadArrivals).toHaveBeenCalled();
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
    await ui.loadDepartures(loc, '1', 60, true);
    expect(ui.renderDepartures).toHaveBeenCalled();
    expect(ui.addLoadMoreButton).toHaveBeenCalled();
    expect(selectStream).toHaveBeenCalledWith('stationboard', loc.lid, 'DEP', 60);
  });

  it('loadDepartures bails when the stop was deselected before the response', async () => {
    getStationBoard.mockResolvedValue(depData([]));
    state.selectedStop = { lid: 'OTHER' };
    await ui.loadDepartures(loc, '1', 60, true);
    expect(ui.renderDepartures).not.toHaveBeenCalled();
    expect(state._autoExpandingDep).toBe(false);
  });

  it('loadArrivals renders and subscribes when ARR is active', async () => {
    getStationBoard.mockResolvedValue({ jnyL: [], common: { prodL: [], locL: [] } });
    state.selectedStop = loc;
    state._activeStationBoardType = 'ARR';
    state._activeTab = 'arrivals';
    await ui.loadArrivals(loc, '1', 60, true);
    expect(ui.renderArrivals).toHaveBeenCalled();
    expect(selectStream).toHaveBeenCalledWith('stationboard', loc.lid, 'ARR', 60);
  });

  it('loadArrivals bails when the stop was deselected', async () => {
    getStationBoard.mockResolvedValue({ jnyL: [], common: {} });
    state.selectedStop = { lid: 'OTHER' };
    await ui.loadArrivals(loc, '1', 60, true);
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
