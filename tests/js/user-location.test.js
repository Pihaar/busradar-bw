/**
 * Regression tests for setUserLocationMarker.
 *
 * The v1.0.7 SSE migration dropped the per-tick GPS refresh from
 * refresh.js. Two visible symptoms:
 *   (1) initial load: map jumps to GPS but the blue dot never appears
 *       (requestGPS() only setView, no marker creation)
 *   (2) after the GPS button drops a dot, it never moves again — the
 *       tick handler didn't touch it.
 *
 * These tests pin the invariants of the shared helper so a future
 * refactor can't quietly break the dot again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

function makeMarkerMock() {
  return {
    addTo: vi.fn(function () { return this; }),
    remove: vi.fn(),
    setLatLng: vi.fn(),
  };
}

globalThis.L = {
  marker: vi.fn(() => makeMarkerMock()),
  layerGroup: vi.fn(() => ({ addTo: vi.fn(function () { return this; }) })),
  circleMarker: vi.fn(() => makeMarkerMock()),
  divIcon: vi.fn(() => ({})),
  latLng: (lat, lon) => ({ lat, lng: lon }),
};

vi.mock('../../static/ui.js', () => ({ ui: { selectJourney: vi.fn() } }));

const { setUserLocationMarker } = await import('../../static/map.js');
const { state, settings } = await import('../../static/state.js');

describe('setUserLocationMarker', () => {
  beforeEach(() => {
    state._userLocationMarker = null;
    state.map = { addLayer: vi.fn(), removeLayer: vi.fn() };
    settings.current = { showLocation: true };
    L.circleMarker.mockClear();
  });

  it('creates the marker on first call', () => {
    setUserLocationMarker(49.34, 8.66);
    expect(L.circleMarker).toHaveBeenCalledTimes(1);
    expect(L.circleMarker.mock.calls[0][0]).toEqual([49.34, 8.66]);
    expect(state._userLocationMarker).not.toBeNull();
    expect(state._userLocationMarker.addTo).toHaveBeenCalledWith(state.map);
  });

  it('reuses the marker via setLatLng on subsequent calls', () => {
    setUserLocationMarker(49.34, 8.66);
    const first = state._userLocationMarker;
    setUserLocationMarker(49.35, 8.67);
    expect(L.circleMarker).toHaveBeenCalledTimes(1);
    expect(state._userLocationMarker).toBe(first);
    expect(first.setLatLng).toHaveBeenCalledWith([49.35, 8.67]);
  });

  it('no-ops when showLocation is off', () => {
    settings.current.showLocation = false;
    setUserLocationMarker(49.34, 8.66);
    expect(L.circleMarker).not.toHaveBeenCalled();
    expect(state._userLocationMarker).toBeNull();
  });

  it('no-ops before the map is initialised', () => {
    state.map = null;
    setUserLocationMarker(49.34, 8.66);
    expect(L.circleMarker).not.toHaveBeenCalled();
    expect(state._userLocationMarker).toBeNull();
  });

  it('uses the visible blue-dot styling', () => {
    setUserLocationMarker(49.34, 8.66);
    const opts = L.circleMarker.mock.calls[0][1];
    expect(opts.fillColor).toBe('#4285f4');
    expect(opts.className).toBe('user-location-marker');
    expect(opts.interactive).toBe(false);
  });
});
