/**
 * Branch mop-up for static/ui.js: the falsy-left arms of the many `|| {}` /
 * `|| ''` / `|| []` fallback chains and the untaken false-arms of guards, which
 * the happy-path tests never flip. Each test feeds a deliberately sparse HAFAS
 * payload (missing journey/common/stopL/prodX/crd/times) and asserts the
 * fallback-driven output (a placeholder name/time, an empty list, a default
 * value), so the assertion is behavioural, not "did not throw".
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
vi.mock('../../static/api.js', () => ({
  trackedFetch: (...a) => window.fetch(...a),
  api: {
    subscribeBoard: () => Promise.resolve({}),
    getStationBoard: (...a) => getStationBoard(...a),
    getJourney: (...a) => getJourney(...a),
    selectStream: (...a) => selectStream(...a),
  },
  urlState: {
    push: vi.fn(),
    replace: vi.fn(),
    parse: vi.fn(() => ({})),
    saveMapPosition: vi.fn(),
    buildShareHash: vi.fn(() => '#x'),
  },
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
  state._selectedStopMarker = null;
  state.vehicles = new Map();
  state.allStops = new Map();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('renderJourneyStops — empty-object fallbacks', () => {
  it('renders with a fully empty data object (journey/common/stopL default to {}/[])', () => {
    vi.useFakeTimers();
    ui.renderJourneyStops({});
    // no stops → no stop-items, but the progress element is (re)created
    expect(ui.stopList.querySelectorAll('.stop-item').length).toBe(0);
    expect(ui.stopList.querySelector('#stop-progress')).not.toBeNull();
  });

  it('a stop with no times leaves the dot un-passed and shows the fallback name', () => {
    vi.useFakeTimers();
    ui.renderJourneyStops({
      journey: { stopL: [{ locX: 0 }] }, // no dTime/aTime → depTime falsy
      common: { locL: [{}] }, // no name → stop_fallback
    });
    const dot = ui.stopList.querySelector('.stop-dot');
    expect(dot.classList.contains('stop-dot--passed')).toBe(false);
    expect(ui.stopList.querySelector('.stop-name').textContent.length).toBeGreaterThan(0);
  });

  it('serverTimeMin null skips the passed-dot computation', () => {
    vi.useFakeTimers();
    state.serverTimeMin = null;
    ui.renderJourneyStops({
      journey: { stopL: [{ locX: 0, dTimeS: '090000' }] },
      common: { locL: [{ name: 'A' }] },
    });
    expect(ui.stopList.querySelector('.stop-dot').classList.contains('stop-dot--passed')).toBe(
      false,
    );
  });
});

describe('buildLineFilter — fallbacks', () => {
  it('uses data.jnyL when no filteredJnyL is passed and defaults prod to {}', () => {
    // jny with no prodX → prodL[undefined] || {} → no nameS added; another with nameS
    const data = {
      common: { prodL: [{ nameS: '721' }] },
      jnyL: [{}, { prodX: 0 }, { prodX: 5 }], // prodX 5 out of range → {} fallback
    };
    // only one distinct line ('721') → filter hidden
    ui.buildLineFilter(data);
    expect(document.getElementById('line-filter').hidden).toBe(true);
  });

  it('falls back to lang "de" when settings.current is null', async () => {
    const { settings } = await import('../../static/state.js');
    const prev = settings.current;
    settings.current = null;
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

describe('_stopSig — time-less and locX-less arms', () => {
  it('produces a stable signature for stops missing locX and both scheduled times', () => {
    const a = ui._stopSig([{}, { aTimeS: '100000' }]);
    const b = ui._stopSig([{}, { aTimeS: '100000' }]);
    expect(a).toBe(b);
  });
});

describe('updateStopProgress — dot fallback + null time arms', () => {
  it('uses the item itself when a row has no .stop-dot and skips null-time stops', () => {
    document.body.innerHTML = '';
    const list = document.createElement('ol');
    list.getBoundingClientRect = () => ({ top: 0, left: 0, height: 500, width: 300 });
    // two rows WITHOUT a .stop-dot → dotCenterY falls back to the item rect
    [10, 100].forEach((cy) => {
      const li = document.createElement('li');
      li.className = 'stop-item';
      li.getBoundingClientRect = () => ({ top: cy - 4, height: 8, left: 9, width: 8 });
      list.appendChild(li);
    });
    const prog = document.createElement('div');
    prog.id = 'stop-progress';
    list.appendChild(prog);
    document.body.appendChild(list);
    ui.stopList = list;
    // one stop has no parsable time (null) → pushed as null, skipped in passed scan
    ui.updateStopProgress([{ dTimeS: 'garbage' }, { dTimeS: '090000' }]);
    expect(list.style.getPropertyValue('--stop-track-top')).toBe('10px');
  });
});

describe('drawRoute — fallback / guard false-arms', () => {
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

  beforeEach(() => {
    state.routeLayer = null;
    state.routeCoords = null;
    state.routeStopMarkers = [];
  });

  it('handles a polyline whose decode yields no usable first stop (firstStop undefined)', () => {
    // stopL empty → firstStop undefined → skips the lat-check retry branch
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
        locL: [],
      },
      journey: { stopL: [] },
    };
    ui.drawRoute(data, null);
    expect(state.routeCoords.length).toBe(2);
  });

  it('does not show journey-actions when there is no selected live bus', () => {
    state.selectedJid = null;
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
      journey: { stopL: [{ locX: 0, dTimeS: '094000' }] },
    };
    ui.drawRoute(data, null);
    expect(document.getElementById('journey-actions').hidden).toBe(true);
  });

  it('fallback line: skips a stop with no crd and needs >= 2 valid coords', () => {
    const data = {
      common: {
        polyL: [], // no polyline → fallback branch
        locL: [
          { name: 'A', crd: { x: 8600000, y: 49300000 } },
          { name: 'NoCrd' }, // no crd → skipped in fallback loop
          { name: 'B', crd: { x: 8620000, y: 49320000 } },
        ],
      },
      journey: { stopL: [{ locX: 0 }, { locX: 1 }, { locX: 2 }] },
    };
    ui.drawRoute(data, null);
    expect(state.routeCoords.length).toBe(2); // A + B, NoCrd skipped
  });

  it('fallback line with < 2 valid coords draws nothing', () => {
    const data = {
      common: { polyL: [], locL: [{ name: 'A', crd: { x: 8600000, y: 49300000 } }, { name: 'B' }] },
      journey: { stopL: [{ locX: 0 }, { locX: 1 }] },
    };
    ui.drawRoute(data, null);
    expect(state.routeCoords).toBeNull();
  });
});

describe('renderDepartures / renderArrivals — sparse jny fallbacks', () => {
  beforeEach(() => {
    state._stationDepDur = 60;
    state._stationArrDur = 60;
    state._stationDepFetching = false;
    state._stationArrFetching = false;
    state._stationDepData = { jnyL: [], common: { prodL: [], locL: [] } };
    state._stationArrData = { jnyL: [], common: { prodL: [], locL: [] } };
  });

  it('renderDepartures uses "?" dir and default prodX/stbStop for a bare jny', () => {
    ui.departureList = document.getElementById('departure-list');
    ui.renderDepartures({ jnyL: [{}], common: {} }, null);
    const item = ui.departureList.querySelector('.departure-item');
    expect(item.querySelector('.departure-dest').textContent).toBe('?');
    expect(item.querySelector('.departure-line').textContent).toBe('?');
  });

  it('renderArrivals uses the from-prefix + "?" for a bare jny', () => {
    ui.renderArrivals({ jnyL: [{}], common: {} }, null);
    const dest = document.getElementById('arrival-list').querySelector('.departure-dest');
    expect(dest.textContent).toContain('?');
  });

  it('renderDepartures with a completely empty data object shows the empty-state', () => {
    ui.departureList = document.getElementById('departure-list');
    ui.renderDepartures({}, null);
    expect(ui.departureList.querySelector('.empty-state')).not.toBeNull();
  });

  it('renderArrivals with an empty data object shows the empty-state', () => {
    ui.renderArrivals({}, null);
    expect(document.getElementById('arrival-list').querySelector('.empty-state')).not.toBeNull();
  });
});

describe('applyPushedStationboard — boardSig fallbacks', () => {
  it('builds a signature from bare jny objects (all fields default) and renders', () => {
    state.selectedStop = { lid: 'A=1@L=1@' };
    state._stationDepFetching = false;
    state._stationArrFetching = false;
    state._lastDepSig = null;
    state._stationExtId = '1';
    state._activeTab = 'departures';
    state._stationDepData = { jnyL: [], common: {} };
    state.serverTimeMin = 720;
    state.serverTimeStamp = Date.now();
    const spy = vi.spyOn(ui, 'renderDepartures').mockImplementation(() => {});
    vi.spyOn(ui, 'buildLineFilter').mockImplementation(() => {});
    vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
    ui.applyPushedStationboard({ lid: 'A=1@L=1@' }, { jnyL: [{}], common: {} }, 'DEP');
    expect(spy).toHaveBeenCalled();
    expect(state._lastDepSig).toContain('|'); // signature built from defaults
  });
});

describe('focusJourneyById — journeyProd / dir fallbacks', () => {
  beforeEach(() => {
    vi.spyOn(ui, '_disableFollow').mockImplementation(() => {});
    vi.spyOn(ui, 'setTabMode').mockImplementation(() => {});
    vi.spyOn(ui, 'switchTab').mockImplementation(() => {});
    vi.spyOn(ui, 'setPanelState').mockImplementation(() => {});
    vi.spyOn(ui, 'renderJourneyStops').mockImplementation(() => {});
    vi.spyOn(ui, 'drawRoute').mockImplementation(() => {});
    state.panelState = 'half';
  });

  it('live position with a bare journey uses "?" placeholders and no prod', async () => {
    getJourney.mockReturnValueOnce(
      Promise.resolve({
        journey: { pos: { x: 8610000, y: 49310000 }, stopL: [{ locX: 0 }] },
        common: {}, // no prodL → journeyProd = prod || {} = {}
      }),
    );
    ui.focusJourneyById('J', undefined, true); // prod undefined too
    await settle();
    expect(ui.detailLine.textContent).toBe('?');
    expect(ui.detailDir.textContent).toBe('?');
  });

  it('not-started with a bare journey and no stops shows the not-started state', async () => {
    getJourney.mockReturnValueOnce(
      Promise.resolve({ journey: {}, common: {} }), // no pos, no stopL
    );
    ui.focusJourneyById('J', undefined, true);
    await settle();
    expect(ui.stopList.querySelector('.empty-state')).not.toBeNull();
  });

  it('no last-stop time: journey is treated as not-ended (lastArrTime empty)', async () => {
    getJourney.mockReturnValueOnce(
      Promise.resolve({
        journey: { stopL: [{ locX: 0 }, { locX: 1 }], dirTxt: 'Z', prodX: 0 }, // no times on last stop
        common: {
          prodL: [{ nameS: '721', name: 'Bus 721' }],
          locL: [{ name: 'A' }, { name: 'B' }],
        },
      }),
    );
    ui.focusJourneyById('J', {}, true);
    await settle();
    // no ended-state (lastArrTime falsy → journeyAlreadyEnded false), renders pending route
    expect(ui.renderJourneyStops).toHaveBeenCalled();
    expect(state._notStartedJid).toBe('J');
  });
});

describe('share — empty-title fallbacks', () => {
  const origNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  beforeEach(() => {
    ui.detailLine.textContent = '';
    ui.detailDir.textContent = '';
  });
  afterEach(() => {
    if (origNav) Object.defineProperty(globalThis, 'navigator', origNav);
  });

  it('journey share works with empty line/dir text', () => {
    state._tabMode = 'journey';
    state.selectedJid = 'J';
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
    const spy = vi.spyOn(ui, '_copyAndToast').mockImplementation(() => {});
    ui.share();
    expect(spy).toHaveBeenCalled();
  });

  it('stop share works with an empty stop name', () => {
    state._tabMode = 'station';
    state.selectedJid = null;
    state.selectedStop = { extId: 'E1' }; // no name
    state._activeTab = 'departures';
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
    const spy = vi.spyOn(ui, '_copyAndToast').mockImplementation(() => {});
    ui.share();
    expect(spy).toHaveBeenCalled();
  });
});

describe('search.doSearch — matchScore + query-word fallbacks', () => {
  beforeEach(() => {
    document.body.innerHTML = '<input id="search-input" /><div id="search-results" hidden></div>';
    search.init();
    state.map = mapStub({ getCenter: () => ({ lat: 49.3, lng: 8.6 }) });
    search._searchSeq = 0;
    window.fetch = vi.fn(() => new Promise(() => {}));
  });

  it('a vehicle matched only via lineFull substring is added as a local line', () => {
    state.vehicles = new Map([
      [
        'J',
        {
          data: { line: 'ZZ', lineFull: 'Sandhausen Express', direction: 'X', delay: 0, stops: [] },
        },
      ],
    ]);
    search.doSearch('express');
    expect(search._localLines.length).toBe(1);
  });

  it('_renderCombined tolerates a missing _queryWords (defaults to [])', () => {
    search._asyncLines = [];
    search._localLines = [];
    search._asyncStops = [
      { type: 'stop', stop: { name: 'X', lat: 1, lon: 2, extId: 'e', platform: '' } },
    ];
    search._localStops = [];
    search._queryWords = undefined; // force the || [] fallback
    const spy = vi.spyOn(search, 'renderResults').mockImplementation(() => {});
    search._renderCombined();
    expect(spy).toHaveBeenCalled();
  });

  it('a remote stop with no name scores 0 via the || "" fallback', () => {
    search._asyncLines = [];
    search._localLines = [];
    search._asyncStops = [{ type: 'stop', stop: { lat: 1, lon: 2, extId: 'e', platform: '' } }]; // no name
    search._localStops = [];
    search._queryWords = ['x'];
    const spy = vi.spyOn(search, 'renderResults').mockImplementation(() => {});
    search._renderCombined();
    const combined = spy.mock.calls[0][0];
    expect(combined[0].score).toBe(0);
  });
});
