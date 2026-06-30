/**
 * Tests for markers.updateAll bbox handling — specifically the
 * "bus leaves the viewport" path that v1.0.26 fixed.
 *
 * Two failure cases for a vehicle missing from the rendered set:
 *   (a) Still in HAFAS ring, position moved off-bbox → remove immediately
 *   (b) Gone from HAFAS payload entirely         → missedCycles grace
 *
 * Pre-fix the upstream filter collapsed (a) into (b), freezing the
 * marker at its last visible position for graceperiodCycles ticks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function makeMarkerMock() {
  return {
    addTo: vi.fn(function () { return this; }),
    remove: vi.fn(),
    setLatLng: vi.fn(),
    setIcon: vi.fn(),
    on: vi.fn(),
    getLatLng: vi.fn(() => ({ lat: 49.34, lng: 8.66 })),
    getElement: vi.fn(() => null),
  };
}

globalThis.L = {
  latLng: (lat, lon) => ({ lat, lng: lon, distanceTo: () => 0 }),
  marker: vi.fn(() => makeMarkerMock()),
  layerGroup: vi.fn(() => ({ addTo: vi.fn(function () { return this; }) })),
  circleMarker: vi.fn(() => makeMarkerMock()),
  divIcon: vi.fn(() => ({})),
};

vi.mock('../../static/ui.js', () => ({ ui: { selectJourney: vi.fn() } }));

const { markers } = await import('../../static/map.js');
const { state, settings } = await import('../../static/state.js');

describe('markers.updateAll — bbox-aware vehicle lifecycle', () => {
  const bbox = {
    getSouth: () => 49.30,
    getNorth: () => 49.40,
    getWest: () => 8.60,
    getEast: () => 8.70,
  };

  beforeEach(() => {
    state.vehicles = new Map();
    state.map = {
      getBounds: () => bbox,
      getZoom: () => 15,
    };
    state.selectedJid = null;
    settings.current = Object.assign(settings.current || {}, { interpolation: false });
    L.marker.mockClear();
  });

  afterEach(() => {
    state.vehicles = new Map();
    state.map = null;
  });

  it('creates a marker for a vehicle inside the bbox', () => {
    markers.updateAll([
      { jid: 'a', lat: 49.35, lon: 8.65, line: '725', delay: 0 },
    ]);
    expect(state.vehicles.has('a')).toBe(true);
    expect(L.marker).toHaveBeenCalledOnce();
    expect(markers._lastVisibleCount).toBe(1);
  });

  it('skips marker creation for a vehicle outside the bbox', () => {
    markers.updateAll([
      { jid: 'b', lat: 49.50, lon: 8.65, line: '725', delay: 0 }, // north of bbox
    ]);
    expect(state.vehicles.has('b')).toBe(false);
    expect(L.marker).not.toHaveBeenCalled();
    expect(markers._lastVisibleCount).toBe(0);
  });

  it('removes an existing marker IMMEDIATELY when its new position falls outside the bbox', () => {
    // Tick 1: bus visible
    markers.updateAll([
      { jid: 'c', lat: 49.35, lon: 8.65, line: '725', delay: 0 },
    ]);
    expect(state.vehicles.has('c')).toBe(true);
    const entry = state.vehicles.get('c');
    expect(entry.marker.remove).not.toHaveBeenCalled();

    // Tick 2: bus moved north of the bbox — still in server payload, just
    // out of viewport. The fix's contract: remove now, do NOT wait for
    // missedCycles. Pre-fix this took graceperiodCycles ticks (≈60s).
    markers.updateAll([
      { jid: 'c', lat: 49.50, lon: 8.65, line: '725', delay: 0 },
    ]);
    expect(entry.marker.remove).toHaveBeenCalledOnce();
    expect(state.vehicles.has('c')).toBe(false);
  });

  it('keeps the selected-journey marker even when it moves off-bbox', () => {
    markers.updateAll([
      { jid: 'sel', lat: 49.35, lon: 8.65, line: '725', delay: 0 },
    ]);
    expect(state.vehicles.has('sel')).toBe(true);
    state.selectedJid = 'sel';
    const entry = state.vehicles.get('sel');

    // Selected bus moves off-bbox — keep it on the map so the user can
    // still follow it. (Existing follow-bus behaviour relies on this.)
    markers.updateAll([
      { jid: 'sel', lat: 49.55, lon: 8.65, line: '725', delay: 0 },
    ]);
    expect(entry.marker.remove).not.toHaveBeenCalled();
    expect(state.vehicles.has('sel')).toBe(true);
  });

  it('applies missedCycles grace-period when a vehicle disappears from the server payload', () => {
    markers.updateAll([
      { jid: 'd', lat: 49.35, lon: 8.65, line: '725', delay: 0 },
    ]);
    const entry = state.vehicles.get('d');
    expect(entry.missedCycles).toBe(0);

    // Tick 2: vehicle missing from server (journey ended, left ring).
    markers.updateAll([]);
    expect(entry.missedCycles).toBe(1);
    expect(entry.marker.remove).not.toHaveBeenCalled();

    // Tick 3: still missing → reaches graceperiodCycles=2 → removed.
    markers.updateAll([]);
    expect(entry.marker.remove).toHaveBeenCalledOnce();
    expect(state.vehicles.has('d')).toBe(false);
  });

  it('counts only in-bbox vehicles in _lastVisibleCount', () => {
    markers.updateAll([
      { jid: 'in1', lat: 49.35, lon: 8.65, line: '725', delay: 0 },
      { jid: 'in2', lat: 49.32, lon: 8.62, line: '719', delay: 1 },
      { jid: 'out', lat: 49.50, lon: 8.65, line: '758', delay: 0 }, // outside
    ]);
    expect(markers._lastVisibleCount).toBe(2);
    expect(state.vehicles.size).toBe(2); // out is not tracked
  });

  it('on bus exit: counter and rendered marker set both shrink in the same tick', () => {
    // Tick 1: two visible vehicles
    markers.updateAll([
      { jid: 'a', lat: 49.35, lon: 8.65, line: '725', delay: 0 },
      { jid: 'b', lat: 49.36, lon: 8.66, line: '725', delay: 0 },
    ]);
    expect(markers._lastVisibleCount).toBe(2);

    // Tick 2: bus 'a' drove off-bbox. Counter must drop to 1 immediately,
    // not stay at 2 until graceperiodCycles elapse.
    markers.updateAll([
      { jid: 'a', lat: 49.50, lon: 8.65, line: '725', delay: 0 },
      { jid: 'b', lat: 49.36, lon: 8.66, line: '725', delay: 0 },
    ]);
    expect(markers._lastVisibleCount).toBe(1);
  });
});
