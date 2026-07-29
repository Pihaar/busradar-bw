/**
 * Tests for the geolocation watchPosition tracking of the user-location dot.
 *
 * Replaces the old per-tick _maybeRefreshUserLocation polling. The dot is
 * now driven by navigator.geolocation.watchPosition, so it tracks device
 * movement continuously and independently of the SSE tick cadence and
 * posMode (the old poll compounded to a ~3-minute update in REPORT_ONLY
 * mode, where vehicles events — which drove the poll — arrived only every
 * ~30s and the poll then throttled 3x further).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

function makeMarkerMock() {
  const m = {
    addTo: vi.fn(function () { m._map = {}; return m; }),
    remove: vi.fn(),
    setLatLng: vi.fn(),
    _map: null,
  };
  return m;
}

globalThis.L = {
  marker: vi.fn(() => makeMarkerMock()),
  layerGroup: vi.fn(() => ({ addTo: vi.fn(function () { return this; }) })),
  circleMarker: vi.fn(() => makeMarkerMock()),
  divIcon: vi.fn((opts) => ({ _opts: opts })),
  latLng: (lat, lon) => ({ lat, lng: lon }),
};

vi.mock('../../static/ui.js', () => ({ ui: { selectJourney: vi.fn() } }));

const { startLocationWatch, stopLocationWatch } = await import('../../static/map.js');
const { state, settings } = await import('../../static/state.js');

function makeMapMock() {
  const panes = {};
  return {
    getPane: vi.fn((n) => panes[n]),
    createPane: vi.fn((n) => { panes[n] = { style: {} }; return panes[n]; }),
    addLayer: vi.fn(),
  };
}

describe('startLocationWatch / stopLocationWatch', () => {
  let watchCb, watchOpts, clearWatch;

  beforeEach(() => {
    state._geoWatchId = null;
    state._userLocationMarker = null;
    state.map = makeMapMock();
    settings.current = { showLocation: true };
    watchCb = watchOpts = undefined;
    clearWatch = vi.fn();
    globalThis.navigator = {
      geolocation: {
        watchPosition: vi.fn((cb, err, opts) => { watchCb = cb; watchOpts = opts; return 42; }),
        clearWatch: clearWatch,
      },
    };
    L.marker.mockClear();
  });

  it('registers a watch and stores its id', () => {
    startLocationWatch();
    expect(navigator.geolocation.watchPosition).toHaveBeenCalledTimes(1);
    expect(state._geoWatchId).toBe(42);
  });

  it('uses high-accuracy continuous options', () => {
    startLocationWatch();
    expect(watchOpts.enableHighAccuracy).toBe(true);
    expect(watchOpts.maximumAge).toBe(5000);
  });

  it('moves the dot on every watch callback (tracks movement)', () => {
    startLocationWatch();
    watchCb({ coords: { latitude: 49.34, longitude: 8.66 } });
    expect(L.marker).toHaveBeenCalledTimes(1);
    expect(L.marker.mock.calls[0][0]).toEqual([49.34, 8.66]);
    // Second fix reuses the marker via setLatLng.
    watchCb({ coords: { latitude: 49.35, longitude: 8.67 } });
    expect(state._userLocationMarker.setLatLng).toHaveBeenCalledWith([49.35, 8.67]);
  });

  it('does not register a second watch if one is already active', () => {
    startLocationWatch();
    startLocationWatch();
    expect(navigator.geolocation.watchPosition).toHaveBeenCalledTimes(1);
  });

  it('no-ops when showLocation is off', () => {
    settings.current.showLocation = false;
    startLocationWatch();
    expect(navigator.geolocation.watchPosition).not.toHaveBeenCalled();
    expect(state._geoWatchId).toBeNull();
  });

  it('stopLocationWatch clears the watch and resets the id', () => {
    startLocationWatch();
    stopLocationWatch();
    expect(clearWatch).toHaveBeenCalledWith(42);
    expect(state._geoWatchId).toBeNull();
  });

  it('stopLocationWatch is a no-op when no watch is active', () => {
    stopLocationWatch();
    expect(clearWatch).not.toHaveBeenCalled();
  });
});
