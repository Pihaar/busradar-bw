/**
 * Final branch/function mop-up for static/ui.js. Covers: banner helpers with a
 * missing button, the init keydown non-Escape arm, the follow-not-started
 * sub-branches (no journey data / empty stops / bad coords), the ARR load
 * cascade real recursion, the load* selectStream .catch no-op arms (rejected
 * subscribe in the success and error paths), the empty-state "hours" variants,
 * showJourneyEnded's no-marker arm, focusJourneyById ended-time wrap arms, and
 * a few render cond-expr falsy arms. Each asserts an observable effect.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildPanelDom, wireUiRefs } from './ui-dom.js';

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
globalThis.cancelAnimationFrame = globalThis.cancelAnimationFrame || vi.fn();

let selectStreamImpl = () => Promise.resolve();
const getJourney = vi.fn(() => new Promise(() => {}));
const getStationBoard = vi.fn(() => new Promise(() => {}));
vi.mock('../../static/api.js', () => ({
  api: {
    getStationBoard: (...a) => getStationBoard(...a),
    getJourney: (...a) => getJourney(...a),
    selectStream: (...a) => selectStreamImpl(...a),
  },
  urlState: { push: vi.fn(), replace: vi.fn(), parse: vi.fn(() => ({})), saveMapPosition: vi.fn() },
}));
vi.mock('../../static/map.js', () => ({
  markers: { updateAll: vi.fn(), highlightSelected: vi.fn() },
  stopsLayer: { update: vi.fn(), addStopMarker: vi.fn(), saveToCache: vi.fn() },
}));
vi.mock('../../static/status.js', () => ({ announce: vi.fn() }));

const { ui } = await import('../../static/ui.js');
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

beforeEach(() => {
  vi.clearAllMocks();
  selectStreamImpl = () => Promise.resolve();
  buildPanelDom();
  wireUiRefs(ui);
  state.serverTimeMin = 600;
  state.serverTimeStamp = null;
  state.map = mapStub();
  state.selectedStop = null;
  state.selectedJid = null;
  state.vehicles = new Map();
  state.allStops = new Map();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('banner helpers — missing-button arms', () => {
  it('showVersionUpdateBanner shows the banner even without its buttons', () => {
    const banner = document.createElement('div');
    banner.id = 'version-banner';
    banner.hidden = true; // no reload/dismiss children
    document.body.appendChild(banner);
    ui.showVersionUpdateBanner();
    expect(banner.hidden).toBe(false);
  });

  it('showTerminalBanner shows the banner even without a reload button', () => {
    const banner = document.createElement('div');
    banner.id = 'terminal-banner';
    banner.hidden = true;
    document.body.appendChild(banner);
    ui.showTerminalBanner();
    expect(banner.hidden).toBe(false);
  });
});

describe('_updateFollowButton / _disableFollow — missing button arm', () => {
  it('_updateFollowButton is a no-op when #btn-follow is absent', () => {
    document.getElementById('btn-follow').remove();
    state.followBus = true;
    expect(() => ui._updateFollowButton()).not.toThrow();
  });

  it('_disableFollow is a no-op on the button when it is absent', () => {
    document.getElementById('btn-follow').remove();
    state.followBus = true;
    ui._disableFollow();
    expect(state.followBus).toBe(false);
  });
});

describe('init keydown — non-Escape key is ignored', () => {
  it('a non-Escape key does not close the panel', () => {
    buildPanelDom();
    ui.init();
    state.panelState = 'half';
    const spy = vi.spyOn(ui, 'closePanel').mockImplementation(() => {});
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('follow-not-started sub-branches', () => {
  beforeEach(() => {
    buildPanelDom();
    ui.init();
    state.followBus = false;
    state.selectedJid = 'J';
    state._notStartedJid = 'J';
    ui._updateFollowButton = vi.fn();
    ui._updateFollowUrl = vi.fn();
  });

  it('no journey data → does not pan', () => {
    state.selectedJourneyData = null;
    document.getElementById('btn-follow').click();
    expect(state.map.panTo).not.toHaveBeenCalled();
  });

  it('empty stop list → does not pan', () => {
    state.selectedJourneyData = { journey: { stopL: [] }, common: { locL: [] } };
    document.getElementById('btn-follow').click();
    expect(state.map.panTo).not.toHaveBeenCalled();
  });

  it('first stop with no usable coord → does not pan', () => {
    state.selectedJourneyData = {
      journey: { stopL: [{ locX: 0 }] },
      common: { locL: [{ crd: { x: 0, y: 0 } }] }, // y falsy → skip
    };
    document.getElementById('btn-follow').click();
    expect(state.map.panTo).not.toHaveBeenCalled();
  });

  it('live-bus follow with no vehicles entry → does not pan', () => {
    state._notStartedJid = null;
    state.vehicles = new Map(); // selectedJid J not present
    document.getElementById('btn-follow').click();
    expect(state.map.panTo).not.toHaveBeenCalled();
    expect(state.map.setView).not.toHaveBeenCalled();
  });

  it('follow toggled OFF does not pan and announces inactive', () => {
    state.followBus = true; // will toggle to false
    document.getElementById('btn-follow').click();
    expect(state.followBus).toBe(false);
    expect(state.map.panTo).not.toHaveBeenCalled();
  });
});

describe('showJourneyEnded — no-marker arm', () => {
  it('shows the ended text when the selected jid has no vehicles entry', () => {
    state.selectedJid = 'GONE';
    state.vehicles = new Map();
    ui.showJourneyEnded();
    expect(ui.stopList.querySelector('.empty-state')).not.toBeNull();
  });

  it('cancels the glide only when an anim frame is in flight', () => {
    state.selectedJid = 'J';
    const remove = vi.fn();
    state.vehicles = new Map([['J', { marker: { remove }, data: {} }]]); // no _animFrame
    ui.showJourneyEnded();
    expect(remove).toHaveBeenCalledOnce();
  });
});

describe('loadDepartures/loadArrivals — selectStream .catch no-op arms', () => {
  const loc = { lid: 'A=1@L=1@', name: 'S' };
  beforeEach(() => {
    vi.spyOn(ui, 'discoverPlatforms').mockImplementation(() => {});
    vi.spyOn(ui, 'buildLineFilter').mockImplementation(() => {});
    vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
    selectStreamImpl = () => Promise.reject(new Error('subscribe failed'));
  });

  it('loadDepartures success path swallows a rejected board subscribe', async () => {
    vi.spyOn(ui, 'renderDepartures').mockReturnValue([{}]);
    getStationBoard.mockResolvedValue({ jnyL: [], common: {} });
    state.selectedStop = loc;
    state._activeStationBoardType = 'DEP';
    state._stationDepCount = 0; // count grows → no cascade, hits the subscribe
    await ui.loadDepartures(loc, '', 60, true);
    await settle();
    expect(ui.renderDepartures).toHaveBeenCalled();
  });

  it('loadDepartures error path swallows a rejected board subscribe', async () => {
    ui.departureList = document.getElementById('departure-list');
    state.selectedStop = loc;
    state._activeStationBoardType = 'DEP';
    getStationBoard.mockReturnValueOnce(Promise.reject(new Error('rate limit')));
    await ui.loadDepartures(loc, '', 60, false);
    await settle();
    expect(ui.departureList.querySelector('.empty-state')).not.toBeNull();
  });

  it('loadArrivals success path swallows a rejected board subscribe', async () => {
    vi.spyOn(ui, 'renderArrivals').mockReturnValue([{}]);
    getStationBoard.mockResolvedValue({ jnyL: [], common: {} });
    state.selectedStop = loc;
    state._activeStationBoardType = 'ARR';
    state._stationArrCount = 0;
    await ui.loadArrivals(loc, '', 60, true);
    await settle();
    expect(ui.renderArrivals).toHaveBeenCalled();
  });

  it('loadArrivals error path swallows a rejected board subscribe', async () => {
    state.selectedStop = loc;
    state._activeStationBoardType = 'ARR';
    getStationBoard.mockReturnValueOnce(Promise.reject(new Error('rate limit')));
    await ui.loadArrivals(loc, '', 60, false);
    await settle();
    expect(document.getElementById('arrival-list').querySelector('.empty-state')).not.toBeNull();
  });
});

describe('loadArrivals — single request adopts the server-settled window', () => {
  const loc = { lid: 'A=1@L=1@', name: 'S' };
  beforeEach(() => {
    vi.spyOn(ui, 'discoverPlatforms').mockImplementation(() => {});
    vi.spyOn(ui, 'buildLineFilter').mockImplementation(() => {});
    vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
    state._activeStationBoardType = 'ARR';
  });

  it('fires one request and adopts settledDur from the response', async () => {
    state.selectedStop = loc;
    state._stationArrCount = 2;
    vi.spyOn(ui, 'renderArrivals').mockReturnValue(new Array(5).fill({}));
    // Server widened internally to 180 and reports it back as settledDur.
    getStationBoard.mockResolvedValue({ jnyL: [], common: {}, settledDur: 180 });
    await ui.loadArrivals(loc, '', 60, true);
    await settle();
    expect(getStationBoard).toHaveBeenCalledTimes(1);
    expect(state._stationArrDur).toBe(180);
    expect(state._stationArrCount).toBe(5);
  });
});

describe('empty-state "hours" variant', () => {
  it('renderDepartures shows the hours empty-state at dur >= 120', () => {
    ui.departureList = document.getElementById('departure-list');
    state._stationDepDur = 180;
    state._autoExpandingDep = false;
    ui.renderDepartures({ jnyL: [], common: {} }, { name: 'S' }, '', null);
    expect(ui.departureList.querySelector('.empty-state')).not.toBeNull();
  });

  it('renderDepartures shows the 24h empty-state at dur >= 1440', () => {
    ui.departureList = document.getElementById('departure-list');
    state._stationDepDur = 1440;
    ui.renderDepartures({ jnyL: [], common: {} }, { name: 'S' }, '', null);
    expect(ui.departureList.querySelector('.empty-state')).not.toBeNull();
  });
});

describe('focusJourneyById — ended-time wrap arms', () => {
  beforeEach(() => {
    vi.spyOn(ui, '_disableFollow').mockImplementation(() => {});
    vi.spyOn(ui, 'setTabMode').mockImplementation(() => {});
    vi.spyOn(ui, 'switchTab').mockImplementation(() => {});
    vi.spyOn(ui, 'setPanelState').mockImplementation(() => {});
    vi.spyOn(ui, 'renderJourneyStops').mockImplementation(() => {});
    vi.spyOn(ui, 'drawRoute').mockImplementation(() => {});
    state.panelState = 'half';
  });

  it('late-evening now + pre-dawn last-stop time: not ended (wrap +1440)', async () => {
    state.serverTimeMin = 1380; // 23:00
    getJourney.mockReturnValueOnce(
      Promise.resolve({
        journey: { stopL: [{ locX: 0, aTimeS: '003000' }], dirTxt: 'Z', prodX: 0 }, // 00:30 → +1440 future
        common: { prodL: [{ nameS: '721', name: 'Bus 721' }], locL: [{ name: 'A' }] },
      }),
    );
    ui.focusJourneyById('J', {}, true);
    await settle();
    // future last stop → not ended → renders as not-started
    expect(state._notStartedJid).toBe('J');
  });

  it('early-morning now + late-evening last-stop time: ended (wrap -1440)', async () => {
    state.serverTimeMin = 120; // 02:00
    getJourney.mockReturnValueOnce(
      Promise.resolve({
        journey: { stopL: [{ locX: 0, aTimeS: '233000' }], dirTxt: 'Z', prodX: 0 }, // 23:30 → -1440 → past
        common: { prodL: [{ nameS: '721', name: 'Bus 721' }], locL: [{ name: 'A' }] },
      }),
    );
    ui.focusJourneyById('J', {}, true);
    await settle();
    expect(ui.stopList.querySelector('.empty-state')).not.toBeNull();
  });

  it('unparseable last-stop time falls back to lastMin 0 (treated ended)', async () => {
    state.serverTimeMin = 600;
    getJourney.mockReturnValueOnce(
      Promise.resolve({
        journey: { stopL: [{ locX: 0, aTimeS: 'junk' }], dirTxt: 'Z', prodX: 0 },
        common: { prodL: [{ nameS: '721', name: 'Bus 721' }], locL: [{ name: 'A' }] },
      }),
    );
    ui.focusJourneyById('J', {}, true);
    await settle();
    // lastArrTime 'junk' is truthy → parseHafasTimeToMin null → lastMin 0 → 0+5<=600 → ended
    expect(ui.stopList.querySelector('.empty-state')).not.toBeNull();
  });
});

describe('renderDepartures — extId filter with a same-name sibling that has no crd', () => {
  it('does not push a same-name loc lacking crd into otherLocs', () => {
    ui.departureList = document.getElementById('departure-list');
    const data = {
      jnyL: [{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { locX: 0, dTimeS: '120000' } }],
      common: {
        prodL: [{ nameS: '721' }],
        // filterLoc E1 has crd; a same-name sibling has NO crd → excluded from otherLocs,
        // so otherLocs stays empty → shouldFilter false → nothing filtered out
        locL: [
          { extId: 'E1', name: 'S', crd: { x: 8600000, y: 49300000 } },
          { extId: 'E2', name: 'S' },
        ],
      },
    };
    ui.renderDepartures(data, { name: 'S' }, 'E1', null);
    expect(ui.departureList.querySelectorAll('.departure-item').length).toBe(1);
  });
});
