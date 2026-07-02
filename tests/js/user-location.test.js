/**
 * Regression tests for setUserLocationMarker.
 *
 * History: the v1.0.7 SSE migration dropped the per-tick GPS refresh;
 * v1.1.1 restored it via a shared helper; v1.2.3 switched from
 * L.circleMarker (SVG-based, lazy renderer) to L.marker + L.divIcon in a
 * dedicated pane at z-index 650 so the dot is guaranteed visible on the
 * very first paint (SVG renderer wasn't ready during map init).
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
  divIcon: vi.fn((opts) => ({ _opts: opts })),
  latLng: (lat, lon) => ({ lat, lng: lon }),
};

vi.mock('../../static/ui.js', () => ({ ui: { selectJourney: vi.fn() } }));

const { setUserLocationMarker } = await import('../../static/map.js');
const { state, settings } = await import('../../static/state.js');

function makeMapMock() {
  const panes = {};
  return {
    getPane: vi.fn((name) => panes[name]),
    createPane: vi.fn((name) => {
      panes[name] = { style: {} };
      return panes[name];
    }),
    addLayer: vi.fn(),
    removeLayer: vi.fn(),
  };
}

describe('setUserLocationMarker', () => {
  beforeEach(() => {
    state._userLocationMarker = null;
    state.map = makeMapMock();
    settings.current = { showLocation: true };
    L.marker.mockClear();
    L.divIcon.mockClear();
  });

  it('creates the marker on first call via L.marker (not circleMarker)', () => {
    setUserLocationMarker(49.34, 8.66);
    expect(L.marker).toHaveBeenCalledTimes(1);
    expect(L.marker.mock.calls[0][0]).toEqual([49.34, 8.66]);
    expect(state._userLocationMarker).not.toBeNull();
    expect(state._userLocationMarker.addTo).toHaveBeenCalledWith(state.map);
  });

  it('creates a dedicated pane above bus markers on first call', () => {
    setUserLocationMarker(49.34, 8.66);
    expect(state.map.createPane).toHaveBeenCalledWith('userLocationPane');
    const pane = state.map.getPane('userLocationPane');
    expect(pane.style.zIndex).toBe('650');
    expect(pane.style.pointerEvents).toBe('none');
  });

  it('reuses the marker via setLatLng on subsequent calls', () => {
    setUserLocationMarker(49.34, 8.66);
    const first = state._userLocationMarker;
    setUserLocationMarker(49.35, 8.67);
    expect(L.marker).toHaveBeenCalledTimes(1);
    expect(state._userLocationMarker).toBe(first);
    expect(first.setLatLng).toHaveBeenCalledWith([49.35, 8.67]);
  });

  it('no-ops when showLocation is off', () => {
    settings.current.showLocation = false;
    setUserLocationMarker(49.34, 8.66);
    expect(L.marker).not.toHaveBeenCalled();
    expect(state._userLocationMarker).toBeNull();
  });

  it('no-ops before the map is initialised', () => {
    state.map = null;
    setUserLocationMarker(49.34, 8.66);
    expect(L.marker).not.toHaveBeenCalled();
    expect(state._userLocationMarker).toBeNull();
  });

  it('marker options place it in the dedicated pane and non-interactive', () => {
    setUserLocationMarker(49.34, 8.66);
    const opts = L.marker.mock.calls[0][1];
    expect(opts.pane).toBe('userLocationPane');
    expect(opts.interactive).toBe(false);
    expect(opts.keyboard).toBe(false);
  });
});
