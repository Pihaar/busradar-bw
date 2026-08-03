/**
 * Tests for the markers module geometry + rendering helpers and the
 * remaining updateAll branches not exercised by markers-update.test.js:
 * createIcon (arrow / no-arrow), calcBearing, calcInitialBearing,
 * animateMarker (RAF-driven), highlightSelected, and the position-unchanged
 * / selected-in-bbox / click-handler / grace-with-selection paths.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

function makeMarkerMock(latlng) {
  const m = {
    _ll: latlng || { lat: 49.34, lng: 8.66 },
    _clickCbs: [],
    addTo: vi.fn(function () {
      return m;
    }),
    remove: vi.fn(),
    setLatLng: vi.fn(function (ll) {
      m._ll = { lat: ll[0], lng: ll[1] };
    }),
    setIcon: vi.fn(),
    on: vi.fn(function (evt, cb) {
      if (evt === 'click') m._clickCbs.push(cb);
      return m;
    }),
    getLatLng: vi.fn(() => m._ll),
    getElement: vi.fn(() => null),
  };
  return m;
}

const savedL = globalThis.L;
const savedRAF = globalThis.requestAnimationFrame;
const savedCAF = globalThis.cancelAnimationFrame;

globalThis.L = {
  latLng: (lat, lon) => ({ lat, lng: lon, distanceTo: () => 0 }),
  marker: vi.fn(() => makeMarkerMock()),
  layerGroup: vi.fn(() => ({
    addTo: vi.fn(function () {
      return this;
    }),
  })),
  circleMarker: vi.fn(() => makeMarkerMock()),
  divIcon: vi.fn((opts) => ({ _opts: opts })),
};

vi.mock('../../static/ui.js', () => ({
  ui: { selectJourney: vi.fn(), showStationBoard: vi.fn(), closePanel: vi.fn() },
}));

const { markers } = await import('../../static/map.js');
const { state, settings } = await import('../../static/state.js');
const { ui } = await import('../../static/ui.js');
const { CONFIG } = await import('../../static/config.js');

const bbox = {
  getSouth: () => 49.3,
  getNorth: () => 49.4,
  getWest: () => 8.6,
  getEast: () => 8.7,
};

afterEach(() => {
  vi.useRealTimers();
  globalThis.requestAnimationFrame = savedRAF;
  globalThis.cancelAnimationFrame = savedCAF;
});

afterAll(() => {
  globalThis.L = savedL;
});

describe('markers.createIcon', () => {
  beforeEach(() => {
    settings.current = { lang: 'de' };
    L.divIcon.mockClear();
  });

  it('renders an arrow span when a bearing is present', () => {
    markers.createIcon({ line: '725', direction: 'Sandhausen', delay: 0, _bearing: 90 });
    const html = L.divIcon.mock.calls[0][0].html;
    expect(html).toContain('bus-marker__arrow');
    expect(html).toContain('rotate(90deg)');
    expect(html).toContain('bus-marker--ontime');
    expect(html).toContain('>725<');
  });

  it('omits the arrow span when bearing is null', () => {
    markers.createIcon({ line: '719', direction: 'Rot', delay: 8, _bearing: null });
    const html = L.divIcon.mock.calls[0][0].html;
    expect(html).not.toContain('bus-marker__arrow');
    expect(html).toContain('bus-marker--major-delay');
  });
});

describe('markers.calcBearing', () => {
  it('returns 0 for due-north movement', () => {
    const b = markers.calcBearing(49.0, 8.0, 49.1, 8.0);
    expect(b).toBeCloseTo(0, 5);
  });

  it('returns ~90 for due-east movement', () => {
    const b = markers.calcBearing(49.0, 8.0, 49.0, 8.1);
    expect(b).toBeGreaterThan(89);
    expect(b).toBeLessThan(91);
  });

  it('normalises a south-west heading into [0,360)', () => {
    const b = markers.calcBearing(49.1, 8.1, 49.0, 8.0);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(360);
    expect(b).toBeGreaterThan(180);
  });
});

describe('markers.calcInitialBearing', () => {
  it('returns null when there are fewer than two stops', () => {
    expect(markers.calcInitialBearing({ stops: [{ lat: 49, lon: 8 }] })).toBeNull();
    expect(markers.calcInitialBearing({})).toBeNull();
  });

  it('returns null when no two distinct valid coordinates exist', () => {
    // all zero / missing coords → no first+second
    expect(
      markers.calcInitialBearing({
        stops: [
          { lat: 0, lon: 0 },
          { lat: 49.3, lon: 0 },
        ],
      }),
    ).toBeNull();
    // one valid, the rest duplicate it → second never set
    expect(
      markers.calcInitialBearing({
        stops: [
          { lat: 49.3, lon: 8.6 },
          { lat: 49.3, lon: 8.6 },
        ],
      }),
    ).toBeNull();
  });

  it('computes the bearing from the first two distinct valid stops', () => {
    const b = markers.calcInitialBearing({
      stops: [
        { lat: 0, lon: 0 }, // skipped (zero)
        { lat: 49.3, lon: 8.6 }, // first
        { lat: 49.4, lon: 8.6 }, // second (distinct → north)
      ],
    });
    expect(b).toBeCloseTo(0, 4);
  });
});

describe('markers._animDurationMs', () => {
  it('uses the CALC push cadence for interpolated mode', () => {
    settings.current = { posMode: 'CALC' };
    expect(markers._animDurationMs()).toBe(CONFIG.markerAnimMsCalc);
  });
  it('uses the GPS push cadence for REPORT_ONLY', () => {
    settings.current = { posMode: 'REPORT_ONLY' };
    expect(markers._animDurationMs()).toBe(CONFIG.markerAnimMsGps);
  });
  it('falls back to CALC cadence for an unknown/legacy posMode string', () => {
    settings.current = { posMode: 'SOMETHING_ELSE' };
    expect(markers._animDurationMs()).toBe(CONFIG.markerAnimMsCalc);
  });
  it('falls back to CALC cadence when settings.current is not yet hydrated', () => {
    settings.current = null;
    expect(markers._animDurationMs()).toBe(CONFIG.markerAnimMsCalc);
  });
});

describe('markers.animateMarker', () => {
  beforeEach(() => {
    settings.current = { interpolation: true, lang: 'de', posMode: 'CALC' };
    state.map = { getZoom: () => 15 };
  });

  it('jumps directly (setLatLng) when interpolation is off', () => {
    settings.current.interpolation = false;
    const entry = { marker: makeMarkerMock({ lat: 49.3, lng: 8.6 }) };
    markers.animateMarker(entry, [49.35, 8.65]);
    expect(entry.marker.setLatLng).toHaveBeenCalledWith([49.35, 8.65]);
  });

  it('jumps directly when zoom is below the no-animation threshold', () => {
    state.map = { getZoom: () => CONFIG.zoomThresholdNoAnimation - 1 };
    const entry = { marker: makeMarkerMock({ lat: 49.3, lng: 8.6 }) };
    markers.animateMarker(entry, [49.35, 8.65]);
    expect(entry.marker.setLatLng).toHaveBeenCalledWith([49.35, 8.65]);
  });

  it('returns without animating when the move is below the distance floor', () => {
    const entry = { marker: makeMarkerMock({ lat: 49.3, lng: 8.6 }) };
    entry.marker.setLatLng.mockClear();
    markers.animateMarker(entry, [49.30001, 8.60001]); // < 0.00005
    expect(entry.marker.setLatLng).not.toHaveBeenCalled();
  });

  it('drives the RAF step loop and cancels a prior in-flight frame', () => {
    let rafCb = null;
    let rafId = 0;
    globalThis.requestAnimationFrame = vi.fn((cb) => {
      rafCb = cb;
      return ++rafId;
    });
    globalThis.cancelAnimationFrame = vi.fn();
    let now = 1000;
    const perfSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);

    const entry = { marker: makeMarkerMock({ lat: 49.3, lng: 8.6 }), _animFrame: 7 };
    markers.animateMarker(entry, [49.4, 8.7]);

    // A previously scheduled frame must be cancelled before scheduling a new one.
    expect(cancelAnimationFrame).toHaveBeenCalledWith(7);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    // Drive one intermediate frame (prog = 0.5) → interpolated midpoint, reschedules.
    now = 1000 + CONFIG.markerAnimMsCalc / 2;
    rafCb(now);
    let mid = entry.marker.setLatLng.mock.calls.at(-1)[0];
    expect(mid[0]).toBeCloseTo(49.35, 6);
    expect(mid[1]).toBeCloseTo(8.65, 6);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);

    // Final frame (prog clamps to 1) → target reached, no further reschedule.
    now = 1000 + CONFIG.markerAnimMsCalc + 1000;
    rafCb(now);
    let end = entry.marker.setLatLng.mock.calls.at(-1)[0];
    expect(end[0]).toBeCloseTo(49.4, 6);
    expect(end[1]).toBeCloseTo(8.7, 6);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);

    perfSpy.mockRestore();
  });

  it('schedules a fresh animation without cancelling when no frame is in flight', () => {
    let rafId = 0;
    globalThis.requestAnimationFrame = vi.fn(() => ++rafId);
    globalThis.cancelAnimationFrame = vi.fn();
    // No _animFrame on the entry → the `if (entry._animFrame)` guard is false.
    const entry = { marker: makeMarkerMock({ lat: 49.3, lng: 8.6 }) };
    markers.animateMarker(entry, [49.4, 8.7]);
    expect(cancelAnimationFrame).not.toHaveBeenCalled();
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(entry._animFrame).toBe(1);
  });
});

describe('markers.highlightSelected', () => {
  beforeEach(() => {
    state.vehicles = new Map();
  });

  it('adds the selected class to the matching marker and removes it from others', () => {
    const inner1 = document.createElement('div');
    inner1.className = 'bus-marker';
    const el1 = document.createElement('div');
    el1.appendChild(inner1);
    const inner2 = document.createElement('div');
    inner2.className = 'bus-marker bus-marker--selected'; // stale selection
    const el2 = document.createElement('div');
    el2.appendChild(inner2);

    state.vehicles.set('sel', { marker: { getElement: () => el1 } });
    state.vehicles.set('other', { marker: { getElement: () => el2 } });
    // A marker whose element isn't in the DOM yet (getElement null) is skipped.
    state.vehicles.set('nodom', { marker: { getElement: () => null } });
    // A marker element without an inner .bus-marker is tolerated.
    state.vehicles.set('noinner', { marker: { getElement: () => document.createElement('div') } });

    markers.highlightSelected('sel');

    expect(inner1.classList.contains('bus-marker--selected')).toBe(true);
    expect(inner2.classList.contains('bus-marker--selected')).toBe(false);
  });
});

describe('markers.updateAll — position-unchanged and selection branches', () => {
  beforeEach(() => {
    state.vehicles = new Map();
    state.map = { getBounds: () => bbox, getZoom: () => 15 };
    state.selectedJid = null;
    state._endedJid = null;
    settings.current = { interpolation: false, lang: 'de' };
    L.marker.mockClear();
    L.divIcon.mockClear();
    ui.selectJourney.mockClear();
  });

  it('keeps the prior bearing when a visible bus reports an unchanged position', () => {
    // Seed with a marker whose getLatLng matches the incoming position exactly.
    const marker = makeMarkerMock({ lat: 49.35, lng: 8.65 });
    state.vehicles.set('u', {
      marker,
      data: { jid: 'u', lat: 49.35, lon: 8.65, line: '725', delay: 0, _bearing: 123 },
      missedCycles: 0,
    });
    markers.updateAll([{ jid: 'u', lat: 49.35, lon: 8.65, line: '725', delay: 0 }]);
    const entry = state.vehicles.get('u');
    expect(entry.data._bearing).toBe(123); // reused, not recomputed
    expect(marker.setIcon).not.toHaveBeenCalled(); // nothing changed → no re-icon
  });

  it('re-icons a visible bus when its delay class changes', () => {
    const marker = makeMarkerMock({ lat: 49.35, lng: 8.65 });
    state.vehicles.set('v', {
      marker,
      data: { jid: 'v', lat: 49.35, lon: 8.65, line: '725', delay: 0, _bearing: null },
      missedCycles: 0,
    });
    markers.updateAll([{ jid: 'v', lat: 49.35, lon: 8.65, line: '725', delay: 10 }]);
    expect(marker.setIcon).toHaveBeenCalledOnce();
  });

  it('keeps the prior bearing for a selected off-bbox bus whose position is unchanged', () => {
    const marker = makeMarkerMock({ lat: 49.55, lng: 8.65 }); // off-bbox
    state.vehicles.set('sel', {
      marker,
      data: { jid: 'sel', lat: 49.55, lon: 8.65, line: '725', delay: 0, _bearing: 77 },
      missedCycles: 3,
    });
    state.selectedJid = 'sel';
    markers.updateAll([{ jid: 'sel', lat: 49.55, lon: 8.65, line: '725', delay: 0 }]);
    const entry = state.vehicles.get('sel');
    expect(entry.data._bearing).toBe(77); // reused
    expect(marker.setLatLng).not.toHaveBeenCalled(); // unchanged → no move
    expect(entry.missedCycles).toBe(0);
  });

  it('falls back to null bearing for a selected off-bbox bus with no prior bearing', () => {
    const marker = makeMarkerMock({ lat: 49.55, lng: 8.65 }); // off-bbox, unchanged
    state.vehicles.set('sel2', {
      marker,
      data: { jid: 'sel2', lat: 49.55, lon: 8.65, line: '725', delay: 0 }, // no _bearing
      missedCycles: 0,
    });
    state.selectedJid = 'sel2';
    markers.updateAll([{ jid: 'sel2', lat: 49.55, lon: 8.65, line: '725', delay: 0 }]);
    expect(state.vehicles.get('sel2').data._bearing).toBeNull();
  });

  it('marker click selects the journey when the entry still exists', () => {
    markers.updateAll([{ jid: 'clk', lat: 49.35, lon: 8.65, line: '725', delay: 0 }]);
    const entry = state.vehicles.get('clk');
    entry.marker._clickCbs[0]();
    expect(ui.selectJourney).toHaveBeenCalledWith(entry.data);
  });

  it('marker click is a no-op when the entry was already removed', () => {
    markers.updateAll([{ jid: 'gone', lat: 49.35, lon: 8.65, line: '725', delay: 0 }]);
    const entry = state.vehicles.get('gone');
    state.vehicles.delete('gone');
    entry.marker._clickCbs[0]();
    expect(ui.selectJourney).not.toHaveBeenCalled();
  });

  it('keeps a selected in-bbox bus once grace elapses instead of removing it', () => {
    // Selected bus, last position in-bbox, disappears from payload → grace path,
    // and once missedCycles reaches the cap the selected branch returns (no remove).
    const marker = makeMarkerMock({ lat: 49.35, lng: 8.65 });
    state.vehicles.set('selg', {
      marker,
      data: { jid: 'selg', lat: 49.35, lon: 8.65, line: '725', delay: 0 },
      missedCycles: CONFIG.graceperiodCycles - 1,
    });
    state.selectedJid = 'selg';
    markers.updateAll([]); // not in payload
    expect(marker.remove).not.toHaveBeenCalled();
    expect(state.vehicles.has('selg')).toBe(true);
  });

  it('treats an entry with null data as last-position-unknown (grace, not immediate drop)', () => {
    const marker = makeMarkerMock();
    state.vehicles.set('nd', { marker, data: null, missedCycles: 0 });
    markers.updateAll([]);
    // lastLat/lastLon null → lastVisible false → immediate-drop branch (not selected)
    expect(marker.remove).toHaveBeenCalledOnce();
    expect(state.vehicles.has('nd')).toBe(false);
  });

  it('renders with no map (bounds null → infinite bbox, everything visible)', () => {
    // The guard is `state.map ? getBounds() : null`; a null map forces the
    // null-bounds arm so inBbox becomes an infinite box (always true).
    state.map = null;
    markers.updateAll([{ jid: 'nomap', lat: 49.9, lon: 9.9, line: '725', delay: 0 }]);
    expect(L.marker).toHaveBeenCalledOnce();
    expect(state.vehicles.has('nomap')).toBe(true);
  });
});

describe('markers.clearVehicles', () => {
  beforeEach(() => {
    state.vehicles = new Map();
    globalThis.cancelAnimationFrame = vi.fn();
  });

  it('removes every marker and empties the store', () => {
    var m1 = makeMarkerMock();
    var m2 = makeMarkerMock();
    state.vehicles.set('a', { marker: m1, data: {}, missedCycles: 0 });
    state.vehicles.set('b', { marker: m2, data: {}, missedCycles: 0 });
    markers.clearVehicles();
    expect(m1.remove).toHaveBeenCalledOnce();
    expect(m2.remove).toHaveBeenCalledOnce();
    expect(state.vehicles.size).toBe(0);
  });

  it('cancels an in-flight animation frame with its stored id and nulls it', () => {
    var m = makeMarkerMock();
    var entry = { marker: m, data: {}, missedCycles: 0, _animFrame: 42 };
    state.vehicles.set('a', entry);
    markers.clearVehicles();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(42);
    expect(entry._animFrame).toBeNull(); // reset so a reused RAF id can't be re-cancelled
    expect(state.vehicles.size).toBe(0);
  });

  it('does not cancel a frame when none is in flight', () => {
    state.vehicles.set('a', { marker: makeMarkerMock(), data: {}, missedCycles: 0 });
    markers.clearVehicles();
    expect(cancelAnimationFrame).not.toHaveBeenCalled();
  });

  it('tolerates an entry without a marker and still removes the rest', () => {
    var m = makeMarkerMock();
    state.vehicles.set('nomarker', { data: {}, missedCycles: 0, _animFrame: 7 });
    state.vehicles.set('ok', { marker: m, data: {}, missedCycles: 0 });
    expect(() => markers.clearVehicles()).not.toThrow();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(7); // markerless entry's RAF still cancelled
    expect(m.remove).toHaveBeenCalledOnce();
    expect(state.vehicles.size).toBe(0);
  });

  it('is a no-op on an empty store', () => {
    expect(() => markers.clearVehicles()).not.toThrow();
    expect(state.vehicles.size).toBe(0);
    expect(cancelAnimationFrame).not.toHaveBeenCalled();
  });
});
