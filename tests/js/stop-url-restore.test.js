/**
 * Coverage for ui.showStopFromUrl — the shared #stop= link restore path.
 * The share hash carries only the extId, so the stop may lie outside the
 * viewport-loaded stops cache. The helper resolves it from the server-wide
 * cache, centers the map on it, and falls back to a synthetic LID when the
 * stop cannot be resolved (digits-only guard).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

globalThis.L = { latLng: (lat, lon) => ({ lat, lng: lon }) };

const searchStops = vi.fn();
vi.mock('../../static/api.js', () => ({
  trackedFetch: (...a) => window.fetch(...a),
  api: {
    searchStops: (...a) => searchStops(...a),
    subscribeBoard: () => Promise.resolve({}),
    selectStream: vi.fn(() => Promise.resolve()),
  },
  urlState: { push: vi.fn(), replace: vi.fn(), buildShareHash: vi.fn() },
}));
const loadAll = vi.fn();
vi.mock('../../static/map.js', () => ({
  markers: { updateAll: vi.fn(), highlightSelected: vi.fn() },
  stopsLayer: { loadAll: (...a) => loadAll(...a), update: vi.fn(), addStopMarker: vi.fn() },
}));
vi.mock('../../static/status.js', () => ({ announce: vi.fn() }));

const { ui } = await import('../../static/ui.js');
const { state } = await import('../../static/state.js');

function makeStop(overrides) {
  return Object.assign(
    {
      extId: '4466857',
      lid: 'A=1@L=4466857@',
      name: 'Sandhausen Alter Postweg',
      lat: 49.335264,
      lon: 8.652198,
      platform: '',
    },
    overrides || {},
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.map = { setView: vi.fn() };
  state.allStops = new Map();
  state._userInteractionSeq = 0;
  vi.spyOn(ui, 'showStationBoard').mockImplementation(() => {});
  vi.spyOn(ui, 'switchTab').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ui.showStopFromUrl', () => {
  it('returns immediately for an empty extId', async () => {
    await ui.showStopFromUrl('', 'dep');
    expect(searchStops).not.toHaveBeenCalled();
    expect(ui.showStationBoard).not.toHaveBeenCalled();
  });

  it('centers and shows a stop already in the viewport cache', async () => {
    const stop = makeStop();
    state.allStops.set(stop.lid, { data: stop });
    await ui.showStopFromUrl(stop.extId, 'dep');
    expect(ui.showStationBoard).toHaveBeenCalledWith(stop, true);
    expect(state.map.setView).toHaveBeenCalledWith([stop.lat, stop.lon], 16);
    expect(loadAll).toHaveBeenCalledWith(stop.lat, stop.lon, 5000);
    expect(searchStops).not.toHaveBeenCalled();
    expect(ui.switchTab).not.toHaveBeenCalled();
  });

  it('uses the URL zoom and switches to arrivals', async () => {
    const stop = makeStop();
    state.allStops.set(stop.lid, { data: stop });
    await ui.showStopFromUrl(stop.extId, 'arr', 18);
    expect(state.map.setView).toHaveBeenCalledWith([stop.lat, stop.lon], 18);
    expect(ui.switchTab).toHaveBeenCalledWith('arrivals');
  });

  it('resolves a stop outside the viewport cache via the server search', async () => {
    const stop = makeStop();
    searchStops.mockResolvedValue({ results: [stop] });
    await ui.showStopFromUrl(stop.extId, 'dep');
    expect(searchStops).toHaveBeenCalledWith(stop.extId);
    expect(ui.showStationBoard).toHaveBeenCalledWith(stop, true);
    expect(state.map.setView).toHaveBeenCalledWith([stop.lat, stop.lon], 16);
    expect(loadAll).toHaveBeenCalledWith(stop.lat, stop.lon, 5000);
  });

  it('ignores a prefix-only search result and uses the synthetic stop', async () => {
    state.allStops.set('other', { data: makeStop({ extId: '9999999' }) });
    searchStops.mockResolvedValue({ results: [makeStop({ extId: '44668570' })] });
    await ui.showStopFromUrl('4466857', 'dep');
    const arg = ui.showStationBoard.mock.calls[0][0];
    expect(arg.lid).toBe('A=1@L=4466857@');
    expect(state.map.setView).not.toHaveBeenCalled();
    expect(loadAll).not.toHaveBeenCalled();
  });

  it('uses the synthetic stop when the search rejects', async () => {
    searchStops.mockRejectedValue(new Error('offline'));
    await ui.showStopFromUrl('4466857', 'dep');
    const arg = ui.showStationBoard.mock.calls[0][0];
    expect(arg.lid).toBe('A=1@L=4466857@');
    expect(state.map.setView).not.toHaveBeenCalled();
  });

  it('does not search or synthesize a non-numeric extId', async () => {
    await ui.showStopFromUrl('abc; DROP', 'dep');
    expect(searchStops).not.toHaveBeenCalled();
    expect(ui.showStationBoard).not.toHaveBeenCalled();
  });

  it('treats a search response without results as no match', async () => {
    searchStops.mockResolvedValue({});
    await ui.showStopFromUrl('4466857', 'dep');
    expect(ui.showStationBoard.mock.calls[0][0].lid).toBe('A=1@L=4466857@');
  });

  it('treats a null search response as no match', async () => {
    searchStops.mockResolvedValue(null);
    await ui.showStopFromUrl('4466857', 'dep');
    expect(ui.showStationBoard.mock.calls[0][0].lid).toBe('A=1@L=4466857@');
  });

  it('shows a matched stop without coordinates without moving the map', async () => {
    const stop = makeStop({ lat: 0, lon: 0 });
    searchStops.mockResolvedValue({ results: [stop] });
    await ui.showStopFromUrl(stop.extId, 'dep');
    expect(ui.showStationBoard).toHaveBeenCalledWith(stop, true);
    expect(state.map.setView).not.toHaveBeenCalled();
    expect(loadAll).not.toHaveBeenCalled();
  });

  it('drops a late search result after user interaction', async () => {
    let resolveSearch;
    searchStops.mockReturnValue(
      new Promise((resolve) => {
        resolveSearch = resolve;
      }),
    );
    const pending = ui.showStopFromUrl('4466857', 'dep');
    state._userInteractionSeq++;
    resolveSearch({ results: [makeStop()] });
    await pending;
    expect(ui.showStationBoard).not.toHaveBeenCalled();
    expect(state.map.setView).not.toHaveBeenCalled();
  });
});
