/**
 * Coverage for the map-drawing + focus/follow paths of static/ui.js:
 * drawRoute (encoded polyline, precision retry, ppLocRefL vs nearest-point
 * split, live-bus split index, fallback stop-to-stop line, route stop markers),
 * selectJourney (happy render + route), focusJourneyById (live / not-started /
 * already-ended / cancelled-fetch branches), showJourneyEnded, updateSseState,
 * _showJourneyCancelled, _updateFollowUrl. Behaviour-level assertions on
 * Leaflet mock calls and state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildPanelDom, wireUiRefs } from './ui-dom.js';

// Leaflet mock: record polyline / circleMarker construction so we can assert
// which route segments were drawn without a real map.
const polylineCalls = [];
const circleMarkerCalls = [];
let layerObj;
globalThis.L = {
  latLng: (lat, lon) => ({ lat, lng: lon }),
  latLngBounds: (c) => ({ _c: c }),
  layerGroup: vi.fn(() => {
    layerObj = { addTo: vi.fn(), _layers: [] };
    return layerObj;
  }),
  polyline: vi.fn((coords, opts) => {
    polylineCalls.push({ coords, opts });
    return { addTo: vi.fn() };
  }),
  circleMarker: vi.fn((latlon, opts) => {
    circleMarkerCalls.push({ latlon, opts });
    const m = {
      addTo: vi.fn(() => m),
      bindTooltip: vi.fn(() => m),
      on: vi.fn((ev, cb) => (m._click = cb)),
      remove: vi.fn(),
    };
    return m;
  }),
};

const getJourney = vi.fn(() => new Promise(() => {}));
vi.mock('../../static/api.js', () => ({
  trackedFetch: (...a) => window.fetch(...a),
  api: {
    subscribeBoard: () => Promise.resolve({}),
    getStationBoard: vi.fn(),
    getJourney: (...a) => getJourney(...a),
    selectStream: vi.fn(() => Promise.resolve()),
  },
  urlState: {
    push: vi.fn(),
    replace: vi.fn(),
    parse: vi.fn(() => ({})),
    saveMapPosition: vi.fn(),
  },
}));
vi.mock('../../static/map.js', () => ({
  markers: { updateAll: vi.fn(), highlightSelected: vi.fn() },
  stopsLayer: { update: vi.fn(), addStopMarker: vi.fn(), saveToCache: vi.fn() },
}));
vi.mock('../../static/status.js', () => ({ announce: vi.fn() }));

const { ui } = await import('../../static/ui.js');
const { state } = await import('../../static/state.js');

// A short real polyline near Sandhausen so decodePolyline yields sane coords.
// Encode two points ourselves at precision 1e5 by using a known string is
// fiddly; instead build a fake polyL with pre-decodable content by monkey-free
// approach: use coordinates the module decodes. We use the real encoder input
// captured from decodePolyline round-trips is overkill — instead we feed a
// crafted string whose decode we assert only structurally (length > 0).
// '_p~iF~ps|U' is the classic Google example → decodes to ~ (38.5,-120.2).
// For our lat-check branch we control expectedLat via the first stop coord.

beforeEach(() => {
  vi.clearAllMocks();
  polylineCalls.length = 0;
  circleMarkerCalls.length = 0;
  buildPanelDom();
  wireUiRefs(ui);
  state.serverTimeStamp = null;
  state.serverTimeMin = 600;
  state.routeCoords = null;
  state.routeLayer = null;
  state.routeStopMarkers = [];
  state.selectedJid = null;
  state.selectedStop = null;
  state.allStops = new Map();
  state.map = {
    setView: vi.fn(),
    panTo: vi.fn(),
    fitBounds: vi.fn(),
    once: vi.fn(),
    getCenter: () => ({ lat: 49.3, lng: 8.6 }),
    getZoom: () => 14,
    addLayer: vi.fn(),
  };
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Build an encoded polyline (precision 1e5) from lat/lon pairs, matching the
// module's decodePolyline so the decode is realistic.
function encodePolyline(points, precision) {
  precision = precision || 1e5;
  let last = [0, 0];
  let out = '';
  function enc(v) {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (v >= 0x20) {
      s += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    s += String.fromCharCode(v + 63);
    return s;
  }
  points.forEach((p) => {
    const lat = Math.round(p[0] * precision);
    const lon = Math.round(p[1] * precision);
    out += enc(lat - last[0]) + enc(lon - last[1]);
    last = [lat, lon];
  });
  return out;
}

describe('ui.drawRoute — encoded polyline', () => {
  const coords = [
    [49.3, 8.6],
    [49.31, 8.61],
    [49.32, 8.62],
    [49.33, 8.63],
  ];

  function journeyWithPoly(extra) {
    return {
      common: {
        polyL: [{ crdEncYX: encodePolyline(coords, 1e5) }],
        locL: [
          { name: 'A', crd: { x: 8600000, y: 49300000 } },
          { name: 'B', crd: { x: 8630000, y: 49330000 } },
        ],
      },
      journey: {
        stopL: [
          { locX: 0, dTimeS: '094000' }, // 09:40 past (now 10:00)
          { locX: 1, dTimeS: '110000' }, // 11:00 future
        ],
      },
      ...extra,
    };
  }

  it('draws the passed + remaining polylines and stop markers with a live bus', () => {
    state.selectedJid = 'J';
    ui.drawRoute(journeyWithPoly(), { lat: 49.315, lon: 8.615, jid: 'J' });
    expect(L.polyline).toHaveBeenCalled();
    expect(state.routeCoords.length).toBeGreaterThan(0);
    expect(state.routeStopMarkers.length).toBe(2);
    // journey-actions shown because selected + live bus
    expect(document.getElementById('journey-actions').hidden).toBe(false);
  });

  it('re-decodes at 1e6 when the 1e5 decode is far from the first stop', () => {
    // Encode at 1e6 but store as crdEncYX; the module first decodes at 1e5,
    // finds the lat ~10x off the expected first-stop lat, and retries at 1e6.
    const j = journeyWithPoly();
    j.common.polyL[0].crdEncYX = encodePolyline(coords, 1e6);
    ui.drawRoute(j, { lat: 49.31, lon: 8.61 });
    // final decoded coords land near the expected lat (49.3x), proving the retry
    expect(Math.round(state.routeCoords[0][0])).toBe(49);
  });

  it('uses ppLocRefL to seed the passed-poly split index', () => {
    const j = journeyWithPoly();
    j.common.polyL[0].ppLocRefL = [
      { locX: 0, ppIdx: 1 },
      { locX: 1, ppIdx: 3 },
    ];
    ui.drawRoute(j, { lat: 49.315, lon: 8.615, jid: 'J' });
    expect(state.routeCoords.length).toBe(4);
    expect(L.polyline).toHaveBeenCalled();
  });

  it('draws without a vehicle position (no split computation)', () => {
    ui.drawRoute(journeyWithPoly(), null);
    expect(L.polyline).toHaveBeenCalled();
  });

  it('falls back to a stop-to-stop line when there is no polyline', () => {
    const data = {
      common: {
        polyL: [],
        locL: [
          { name: 'A', crd: { x: 8600000, y: 49300000 } },
          { name: 'B', crd: { x: 8630000, y: 49330000 } },
        ],
      },
      journey: { stopL: [{ locX: 0 }, { locX: 1 }] },
    };
    state.selectedJid = 'J';
    ui.drawRoute(data, { lat: 49.31, lon: 8.61, jid: 'J' });
    expect(state.routeCoords.length).toBe(2);
    const fallback = polylineCalls.find((c) => c.opts && c.opts.color === '#00f5d4');
    expect(fallback).toBeDefined();
  });

  it('skips route stop markers at 0/0 and without crd', () => {
    const data = {
      common: {
        polyL: [{ crdEncYX: encodePolyline(coords, 1e5) }],
        locL: [
          { name: 'A', crd: { x: 8600000, y: 49300000 } },
          { name: 'Zero', crd: { x: 0, y: 0 } },
          { name: 'NoCrd' },
        ],
      },
      journey: { stopL: [{ locX: 0 }, { locX: 1 }, { locX: 2 }] },
    };
    ui.drawRoute(data, null);
    // only the valid stop (A) gets a marker
    expect(state.routeStopMarkers.length).toBe(1);
  });

  it('a route-stop marker click opens the station board (cached extId hit)', () => {
    const cached = { extId: 'E1', name: 'A' };
    state.allStops = new Map([['k', { data: cached }]]);
    const data = {
      common: {
        polyL: [{ crdEncYX: encodePolyline(coords, 1e5) }],
        locL: [{ name: 'A', lid: 'A=1@L=1@', extId: 'E1', crd: { x: 8600000, y: 49300000 } }],
      },
      journey: { stopL: [{ locX: 0 }] },
    };
    ui.drawRoute(data, null);
    const sb = vi.spyOn(ui, 'showStationBoard').mockImplementation(() => {});
    const marker = circleMarkerCalls.length ? null : null;
    // trigger the recorded click handler on the created marker
    const created = L.circleMarker.mock.results[L.circleMarker.mock.results.length - 1].value;
    created._click();
    expect(sb).toHaveBeenCalledWith(cached);
    void marker;
  });

  it('a route-stop marker click without a lid is ignored', () => {
    const data = {
      common: {
        polyL: [{ crdEncYX: encodePolyline(coords, 1e5) }],
        locL: [{ name: 'A', crd: { x: 8600000, y: 49300000 } }], // no lid
      },
      journey: { stopL: [{ locX: 0 }] },
    };
    ui.drawRoute(data, null);
    const sb = vi.spyOn(ui, 'showStationBoard').mockImplementation(() => {});
    const created = L.circleMarker.mock.results[L.circleMarker.mock.results.length - 1].value;
    created._click();
    expect(sb).not.toHaveBeenCalled();
  });

  it('does nothing (no route) when there is neither a polyline nor >= 2 stops', () => {
    ui.drawRoute({ common: { polyL: [], locL: [] }, journey: { stopL: [{ locX: 0 }] } }, null);
    expect(state.routeCoords).toBeNull();
  });
});

describe('ui.selectJourney — happy path render', () => {
  beforeEach(() => {
    state.panelState = 'hidden';
    vi.spyOn(ui, '_disableFollow').mockImplementation(() => {});
    vi.spyOn(ui, 'setTabMode').mockImplementation(() => {});
    vi.spyOn(ui, 'switchTab').mockImplementation(() => {});
    vi.spyOn(ui, 'setPanelState').mockImplementation(() => {});
  });

  it('renders the journey + route when getJourney resolves', async () => {
    getJourney.mockReturnValueOnce(
      Promise.resolve({
        journey: { stopL: [{ locX: 0, dTimeS: '100000' }] },
        common: { locL: [{ name: 'A' }] },
      }),
    );
    const rjs = vi.spyOn(ui, 'renderJourneyStops').mockImplementation(() => {});
    const dr = vi.spyOn(ui, 'drawRoute').mockImplementation(() => {});
    const v = { jid: 'J', line: '721', lineFull: 'Bus 721', direction: 'Ziel', delay: 2 };
    ui.selectJourney(v, true);
    expect(state.selectedJid).toBe('J');
    expect(ui.detailLine.textContent).toBe('Bus 721');
    await Promise.resolve();
    await Promise.resolve();
    expect(rjs).toHaveBeenCalled();
    expect(dr).toHaveBeenCalled();
  });

  it('shows the route-unavailable state when getJourney rejects (non-abort)', async () => {
    getJourney.mockReturnValueOnce(Promise.reject(new Error('boom')));
    ui.selectJourney({ jid: 'J', line: '721', direction: 'X', delay: null }, true);
    await Promise.resolve();
    await Promise.resolve();
    expect(ui.stopList.querySelector('.empty-state')).not.toBeNull();
  });

  it('is silent on an AbortError reject', async () => {
    getJourney.mockReturnValueOnce(Promise.reject({ name: 'AbortError' }));
    ui.selectJourney({ jid: 'J', line: '721', direction: 'X', delay: null }, true);
    await Promise.resolve();
    await Promise.resolve();
    expect(ui.stopList.querySelector('.empty-state')).toBeNull();
  });

  it('opens the panel from hidden when skipHistory is falsy', () => {
    getJourney.mockReturnValueOnce(new Promise(() => {}));
    ui.selectJourney({ jid: 'J', line: '721', direction: 'X', delay: null });
    // panel opens from hidden → setPanelState('half')
    expect(ui.setPanelState).toHaveBeenCalledWith('half');
  });

  it('uses vehicle.line when lineFull is missing', () => {
    getJourney.mockReturnValueOnce(new Promise(() => {}));
    ui.selectJourney({ jid: 'J', line: '721', direction: 'X', delay: null }, true);
    expect(ui.detailLine.textContent).toBe('721');
  });
});

describe('ui.focusJourneyById — render branches', () => {
  beforeEach(() => {
    state.panelState = 'hidden';
    vi.spyOn(ui, '_disableFollow').mockImplementation(() => {});
    vi.spyOn(ui, 'setTabMode').mockImplementation(() => {});
    vi.spyOn(ui, 'switchTab').mockImplementation(() => {});
    vi.spyOn(ui, 'setPanelState').mockImplementation(() => {});
    vi.spyOn(ui, 'renderJourneyStops').mockImplementation(() => {});
    vi.spyOn(ui, 'drawRoute').mockImplementation(() => {});
  });

  it('live position: renders stops/route and centres the map', async () => {
    getJourney.mockReturnValueOnce(
      Promise.resolve({
        journey: {
          pos: { x: 8610000, y: 49310000 },
          stopL: [{ locX: 0, dTimeS: '100000', dTimeR: '100200' }],
          dirTxt: 'Ziel',
          prodX: 0,
        },
        common: { prodL: [{ nameS: '721', name: 'Bus 721' }], locL: [{ name: 'A' }] },
      }),
    );
    ui.focusJourneyById('J', { nameS: '721' }, true);
    await Promise.resolve();
    await Promise.resolve();
    expect(state.map.setView).toHaveBeenCalledWith([49.31, 8.61], 15);
    expect(ui.renderJourneyStops).toHaveBeenCalled();
    expect(state._selectedHadPosJid).toBe('J');
  });

  it('no position, journey already ended: shows the ended state', async () => {
    // last stop arrival 09:00, now 10:00 → lastMin+5 <= now → ended
    getJourney.mockReturnValueOnce(
      Promise.resolve({
        journey: { stopL: [{ locX: 0, aTimeS: '090000' }], dirTxt: 'Ziel', prodX: 0 },
        common: { prodL: [{ nameS: '721', name: 'Bus 721' }], locL: [{ name: 'A' }] },
      }),
    );
    ui.focusJourneyById('J', {}, true);
    await Promise.resolve();
    await Promise.resolve();
    expect(ui.stopList.querySelector('.empty-state')).not.toBeNull();
  });

  it('no position, not yet started with stops: renders the pending route and fits bounds', async () => {
    vi.useFakeTimers();
    state.routeCoords = [
      [1, 2],
      [3, 4],
    ];
    ui.drawRoute.mockImplementation(() => {
      state.routeCoords = [
        [1, 2],
        [3, 4],
      ];
    });
    window.innerWidth = 500;
    window.innerHeight = 800;
    document.getElementById('detail-panel').getBoundingClientRect = () => ({
      width: 360,
      top: 300,
    });
    getJourney.mockReturnValueOnce(
      Promise.resolve({
        journey: {
          stopL: [
            { locX: 0, dTimeS: '120000' },
            { locX: 1, dTimeS: '123000' },
          ],
          dirTxt: 'Ziel',
          prodX: 0,
        },
        common: {
          prodL: [{ nameS: '721', name: 'Bus 721' }],
          locL: [{ name: 'A' }, { name: 'B' }],
        },
      }),
    );
    ui.focusJourneyById('J', {}, true);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(state._notStartedJid).toBe('J');
    expect(ui.renderJourneyStops).toHaveBeenCalled();
    expect(state.map.fitBounds).toHaveBeenCalled();
  });

  it('no position, not started, no stops: shows the not-started state', async () => {
    getJourney.mockReturnValueOnce(
      Promise.resolve({
        journey: { stopL: [], dirTxt: 'Ziel', prodX: 0 },
        common: { prodL: [{ nameS: '721', name: 'Bus 721' }], locL: [] },
      }),
    );
    ui.focusJourneyById('J', {}, true);
    await Promise.resolve();
    await Promise.resolve();
    expect(ui.stopList.querySelector('.empty-state')).not.toBeNull();
  });

  it('shows journey-not-found on a non-abort reject', async () => {
    getJourney.mockReturnValueOnce(Promise.reject(new Error('x')));
    ui.focusJourneyById('J', {}, true);
    await Promise.resolve();
    await Promise.resolve();
    expect(ui.stopList.querySelector('.empty-state')).not.toBeNull();
  });

  it('is silent on an AbortError reject', async () => {
    getJourney.mockReturnValueOnce(Promise.reject({ name: 'AbortError' }));
    ui.stopList.replaceChildren();
    ui.focusJourneyById('J', {}, true);
    await Promise.resolve();
    await Promise.resolve();
    expect(ui.stopList.querySelector('.empty-state')).toBeNull();
  });
});

describe('ui.updateSseState', () => {
  it('sets the data-state attribute when the indicator exists', () => {
    ui.updateSseState('open');
    expect(document.getElementById('sse-state-indicator').getAttribute('data-state')).toBe('open');
  });

  it('is a no-op when the indicator is absent', () => {
    document.getElementById('sse-state-indicator').remove();
    expect(() => ui.updateSseState('failed')).not.toThrow();
  });
});

describe('ui._showJourneyCancelled', () => {
  it('resets selection flags and shows the cancelled state', () => {
    state._notStartedJid = 'J';
    state.selectedJourneyData = { x: 1 };
    ui._showJourneyCancelled();
    expect(state._notStartedJid).toBeNull();
    expect(state.selectedJourneyData).toBeNull();
    expect(ui.stopList.querySelector('.empty-state')).not.toBeNull();
  });
});
