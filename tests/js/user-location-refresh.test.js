/**
 * Tests for _maybeRefreshUserLocation — the per-tick GPS-dot refresh
 * scheduled from the SSE vehicles handler.
 *
 * Contract (v1.2.0 fix): fires getCurrentPosition every ~30 s effective
 * (throttled to 1-in-3 SSE ticks at 10 s cadence). Guards showLocation-off
 * and geolocation-unavailable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

globalThis.L = {
  circleMarker: vi.fn(() => ({ addTo: vi.fn(function () { return this; }), setLatLng: vi.fn(), remove: vi.fn() })),
  latLng: (lat, lon) => ({ lat, lng: lon }),
  layerGroup: vi.fn(() => ({ addTo: vi.fn(function () { return this; }) })),
  marker: vi.fn(),
  divIcon: vi.fn(() => ({})),
};

vi.mock('../../static/ui.js', () => ({ ui: { selectJourney: vi.fn() } }));

const { _maybeRefreshUserLocation } = await import('../../static/refresh.js');
const { state, settings } = await import('../../static/state.js');

describe('_maybeRefreshUserLocation — 30s throttle', () => {
  let mockGetPos;

  beforeEach(() => {
    mockGetPos = vi.fn();
    globalThis.navigator = { geolocation: { getCurrentPosition: mockGetPos } };
    state.map = { addLayer: vi.fn() };
    state._userLocationMarker = null;
    settings.current = { showLocation: true };
    // Reset the module-level counter by exhausting it via calls.
    // Cheaper: import the module fresh (but vi module cache makes that
    // heavy). Rely on the pattern seen in the test — first call fires,
    // then two skips, then fire.
  });

  it('fires on 1st tick, skips 2nd and 3rd, fires 4th', () => {
    // Assumes counter starts at 0 → increments to 1, 2, 3, 4, 5, 6
    // and (counter % 3 === 1) fires at 1 and 4.
    _maybeRefreshUserLocation();
    expect(mockGetPos).toHaveBeenCalledTimes(1);
    _maybeRefreshUserLocation();
    _maybeRefreshUserLocation();
    expect(mockGetPos).toHaveBeenCalledTimes(1);
    _maybeRefreshUserLocation();
    expect(mockGetPos).toHaveBeenCalledTimes(2);
  });

  it('does nothing when showLocation is off', () => {
    settings.current.showLocation = false;
    for (let i = 0; i < 5; i++) _maybeRefreshUserLocation();
    expect(mockGetPos).not.toHaveBeenCalled();
  });

  it('does nothing when navigator.geolocation is unavailable', () => {
    globalThis.navigator = {};
    for (let i = 0; i < 5; i++) _maybeRefreshUserLocation();
    expect(mockGetPos).not.toHaveBeenCalled();
  });

  it('uses maximumAge 30000 (cached fix accepted for 30s)', () => {
    _maybeRefreshUserLocation();
    // Advance the throttle: next fire is on the 4th call
    _maybeRefreshUserLocation();
    _maybeRefreshUserLocation();
    _maybeRefreshUserLocation();
    const opts = mockGetPos.mock.calls[mockGetPos.mock.calls.length - 1][2];
    expect(opts.maximumAge).toBe(30000);
    expect(opts.timeout).toBe(5000);
    expect(opts.enableHighAccuracy).toBe(true);
  });
});
