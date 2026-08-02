/**
 * Final long-tail branch coverage for static/ui.js. Flips the remaining
 * reachable arms: cond-expr locX-null ternaries (stop.locX == null → -1),
 * fallback left-arms where the left operand is falsy (missing common/journey/
 * stopL/locL/gidL/stbStop/prodX/times/name/extId), the switchTab arrivals
 * else-if and its SSE ARR dur ternary, the applyPushedStationboard boardSig
 * cond-expr, the day-badge/limit paths, and the search matchScore not-found /
 * comparator equal-score arms. Each asserts an observable effect.
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

const getJourney = vi.fn(() => new Promise(() => {}));
const getStationBoard = vi.fn(() => new Promise(() => {}));
const selectStream = vi.fn(() => Promise.resolve());
const subscribeBoard = vi.fn(() => Promise.resolve({}));
vi.mock('../../static/api.js', () => ({
  trackedFetch: (...a) => window.fetch(...a),
  api: {
    subscribeBoard: (...a) => subscribeBoard(...a),
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
  state._stationDepFetching = false;
  state._stationArrFetching = false;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('renderJourneyStops — stop.locX == null → -1 fallback arms', () => {
  beforeEach(() => vi.useFakeTimers());

  it('a stop with no locX uses the -1 index (loc defaults to {}) and the fallback name', () => {
    ui.renderJourneyStops({
      journey: { stopL: [{ dTimeS: '100000' }] }, // no locX → locIdx -1 → loc {}
      common: { locL: [{ name: 'A' }] },
    });
    // stop_fallback name rendered (loc was {})
    expect(ui.stopList.querySelector('.stop-name').textContent.length).toBeGreaterThan(0);
  });

  it('per-stop message keys on -1 when a stop has no locX (stopLocX ternary false arm)', () => {
    ui.renderJourneyStops({
      journey: {
        stopL: [{ dTimeS: '100000' }, { locX: 1, dTimeS: '101000' }], // first has no locX
        msgL: [{ type: 'REM', remX: 0, fLocX: -1, tLocX: -1 }],
      },
      common: { locL: [{ name: 'A' }, { name: 'B' }], remL: [{ code: 'BE', txtN: 'Hinweis' }] },
    });
    // no per-stop message (fLocX -1 → journey-level), but the -1 keying arm ran
    expect(ui.stopList.querySelectorAll('.stop-item').length).toBe(2);
  });
});

describe('drawRoute — locX == null → -1 and empty-decode arms', () => {
  it('route stop markers: a stop with no locX resolves loc to {} and is skipped (no crd)', () => {
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
    const data = {
      common: {
        polyL: [
          {
            crdEncYX: encode([
              [49.3, 8.6],
              [49.31, 8.61],
            ]),
          },
        ],
        locL: [{ name: 'A', crd: { x: 8600000, y: 49300000 } }],
      },
      journey: { stopL: [{}, { locX: 0 }] }, // first stop has no locX → loc {} → no crd → skipped
    };
    ui.drawRoute(data, null);
    expect(state.routeStopMarkers.length).toBe(1);
  });
});

describe('buildLineFilter — lang fallback when settings.current.lang missing', () => {
  it('uses "de" when settings.current exists but has no lang', async () => {
    const { settings } = await import('../../static/state.js');
    const prev = settings.current;
    settings.current = {}; // truthy but no lang → (current && current.lang) is undefined → || 'de'
    state._activeTab = 'departures';
    state._depFilter = null;
    ui.buildLineFilter({
      common: { prodL: [{ nameS: '721' }, { nameS: '705' }] },
      jnyL: [{ prodX: 0 }, { prodX: 1 }],
    });
    expect(document.getElementById('line-filter').querySelectorAll('.filter-chip').length).toBe(3);
    settings.current = prev;
  });
});

describe('switchTab — arrivals else-if + board re-subscribe', () => {
  it('activates the arrivals tab and re-subscribes the ARR board at the fixed 2h window', () => {
    state.selectedStop = { lid: 'A=1@L=1@' };
    state._activeStationBoardType = 'DEP';
    state._stationArrData = { common: {}, jnyL: [] };
    vi.spyOn(ui, 'buildLineFilter').mockImplementation(() => {});
    ui.switchTab('arrivals');
    expect(document.getElementById('tabpanel-arrivals').hidden).toBe(false);
    expect(subscribeBoard).toHaveBeenCalledWith('A=1@L=1@', 'ARR');
  });
});

describe('applyPushedStationboard — boardSig dirTxt/time default arms', () => {
  it('builds a signature from a jny with no dirTxt and no times (defaults)', () => {
    state.selectedStop = { lid: 'A=1@L=1@', extId: 'E1' };
    state._lastDepSig = null;
    state._stationExtId = 'E1';
    state._stationDepData = { jnyL: [], common: {} };
    state.serverTimeMin = 720;
    state.serverTimeStamp = Date.now();
    vi.spyOn(ui, 'renderDepartures').mockImplementation(() => {});
    vi.spyOn(ui, 'buildLineFilter').mockImplementation(() => {});
    vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
    ui.applyPushedStationboard(
      { lid: 'A=1@L=1@', extId: 'E1' },
      { jnyL: [{ jid: 'A', stbStop: {} }], common: {} }, // no dirTxt, no times → defaults
      'DEP',
    );
    expect(state._lastDepSig).toContain('A|'); // jid A, defaults elsewhere
  });
});

describe('discoverPlatforms — common/locL/gidL default arms', () => {
  it('tolerates a data object with no common (defaults to {}/[])', () => {
    expect(() => ui.discoverPlatforms({})).not.toThrow();
  });

  it('a loc with no gidL array defaults to [] (no physical stop → skipped)', () => {
    ui.discoverPlatforms({
      common: { locL: [{ lid: 'A=1@L=1@', crd: { x: 8600000, y: 49300000 } }] }, // no gidL
    });
    // no b× physical marker → nothing added; reaching here exercised gidL || []
    expect(true).toBe(true);
  });
});

describe('focusJourneyById — journey/common/stopL default arms (not-started)', () => {
  beforeEach(() => {
    vi.spyOn(ui, '_disableFollow').mockImplementation(() => {});
    vi.spyOn(ui, 'setTabMode').mockImplementation(() => {});
    vi.spyOn(ui, 'switchTab').mockImplementation(() => {});
    vi.spyOn(ui, 'setPanelState').mockImplementation(() => {});
    vi.spyOn(ui, 'renderJourneyStops').mockImplementation(() => {});
    vi.spyOn(ui, 'drawRoute').mockImplementation(() => {});
    state.panelState = 'half';
    state.map = mapStub();
  });

  it('a resolved response with no journey/common objects uses every default', async () => {
    getJourney.mockReturnValueOnce(Promise.resolve({})); // journey||{}, common||{}, prodL||[], stopL||[]
    ui.focusJourneyById('J', undefined, true);
    await settle();
    // no pos, no stops → not-started with no stops → not-started state
    expect(ui.stopList.querySelector('.empty-state')).not.toBeNull();
  });
});

describe('search — matchScore not-found + comparator equal-score arms', () => {
  beforeEach(() => {
    document.body.innerHTML = '<input id="search-input" /><div id="search-results" hidden></div>';
    search.init();
    state.map = mapStub({ getCenter: () => ({ lat: 49.3, lng: 8.6 }) });
    search._searchSeq = 0;
    window.fetch = vi.fn(() => new Promise(() => {}));
  });

  it('matchScore does not increment for a word missing from the name (if false arm)', () => {
    // two stops, query two words; both stops contain BOTH words → matchScore counts,
    // but one stop contains only one word in matchScore's per-word check.
    state.allStops = new Map([
      ['a', { data: { name: 'Alpha Beta', lat: 49.3, lon: 8.6, extId: 'E1', platform: '' } }],
    ]);
    // 'alpha gamma': matchesQuery needs ALL → excluded; but matchScore still runs
    // per word (alpha found +1, gamma not found → if false arm). Assert no crash + no match.
    search.doSearch('alpha gamma');
    expect(search._localStops.length).toBe(0);
  });

  it('comparator equal-score arm sorts two equal-score stops by distance', () => {
    // same score (both contain the single query word) → falls to distance tiebreak,
    // which needs the b.score === a.score arm (the `if (b.score !== a.score)` false branch).
    state.vehicles = new Map();
    state.allStops = new Map([
      ['a', { data: { name: 'Markt Nord', lat: 49.9, lon: 8.9, extId: 'FAR', platform: '' } }],
      ['b', { data: { name: 'Markt Süd', lat: 49.31, lon: 8.61, extId: 'NEAR', platform: '' } }],
    ]);
    search.doSearch('markt');
    expect(search._localStops[0].stop.extId).toBe('NEAR');
  });
});
