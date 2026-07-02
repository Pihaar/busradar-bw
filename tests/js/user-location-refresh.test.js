/**
 * Tests for _maybeRefreshUserLocation — the per-tick GPS-dot refresh
 * scheduled from the SSE vehicles handler.
 *
 * Contract (v1.2.1 fix): fires getCurrentPosition every ~30 s effective
 * (throttled to 1-in-3 SSE ticks at 10 s cadence), with low-power options
 * (maximumAge 60s, enableHighAccuracy=false). Guards showLocation-off and
 * geolocation-unavailable.
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

const { _maybeRefreshUserLocation, _resetGpsRefreshCounter } = await import('../../static/refresh.js');
const { state, settings } = await import('../../static/state.js');

describe('_maybeRefreshUserLocation — 30s throttle', () => {
  let mockGetPos;

  beforeEach(() => {
    mockGetPos = vi.fn();
    globalThis.navigator = { geolocation: { getCurrentPosition: mockGetPos } };
    state.map = { addLayer: vi.fn() };
    state._userLocationMarker = null;
    settings.current = { showLocation: true };
    // Reset the module-level counter so tests run in any order (vitest
    // shuffle-safety). The prior version relied on declaration-order.
    _resetGpsRefreshCounter();
  });

  it('fires on 1st tick, skips 2nd and 3rd, fires 4th', () => {
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

  it('uses low-power geolocation options', () => {
    _maybeRefreshUserLocation();
    const opts = mockGetPos.mock.calls[0][2];
    expect(opts.maximumAge).toBe(60000);
    expect(opts.timeout).toBe(5000);
    expect(opts.enableHighAccuracy).toBe(false);
  });
});
