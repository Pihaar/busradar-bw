/**
 * Regression test: the selected bus's marker must be removed when its journey
 * ends. The selected bus is exempt from the normal removal in
 * markers.updateAll (map.js), so it lingered on the map after "Fahrt beendet"
 * until the user deselected it. ui.showJourneyEnded now removes the marker,
 * cancels any in-flight glide, and drops the state.vehicles entry.
 *
 * Confirmed live (v1.2.25): after the ended text appeared, the bus marker
 * stayed visible for the whole observation window.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

globalThis.L = { latLng: (lat, lon) => ({ lat, lng: lon }) };
globalThis.cancelAnimationFrame = vi.fn();

vi.mock('../../static/api.js', () => ({
  api: { getStationBoard: vi.fn(), selectStream: vi.fn(() => Promise.resolve({})) },
  urlState: { push: vi.fn(), replace: vi.fn() },
}));
vi.mock('../../static/map.js', () => ({
  markers: { updateAll: vi.fn() },
  stopsLayer: { update: vi.fn(), addStopMarker: vi.fn() },
}));
vi.mock('../../static/status.js', () => ({ announce: vi.fn() }));

const { ui } = await import('../../static/ui.js');
const { state } = await import('../../static/state.js');

describe('ui.showJourneyEnded — remove the stale bus marker on journey end', () => {
  beforeEach(() => {
    globalThis.cancelAnimationFrame.mockClear();
    ui.stopList = document.createElement('div');
    state.selectedJid = null;
    state.vehicles = new Map();
    state._endedJid = null;
  });

  it('removes the selected bus marker, cancels its glide, deletes the entry, and flags _endedJid', () => {
    const remove = vi.fn();
    state.selectedJid = 'JE';
    state.vehicles.set('JE', { marker: { remove }, _animFrame: 42, data: { lat: 49.4, lon: 8.7 } });

    ui.showJourneyEnded();

    expect(remove).toHaveBeenCalledOnce();
    expect(globalThis.cancelAnimationFrame).toHaveBeenCalledWith(42);
    expect(state.vehicles.has('JE')).toBe(false);
    // marks the jid so updateAll won't re-add it from an interpolated payload
    expect(state._endedJid).toBe('JE');
    // still shows the ended message
    expect(ui.stopList.textContent).toMatch(/beendet|ended/i);
  });

  it('is a no-op on the map when no bus is selected (still shows the message)', () => {
    ui.showJourneyEnded();
    expect(globalThis.cancelAnimationFrame).not.toHaveBeenCalled();
    expect(ui.stopList.textContent).toMatch(/beendet|ended/i);
  });

  it('does not crash when the selected entry has no in-flight glide', () => {
    const remove = vi.fn();
    state.selectedJid = 'JE';
    state.vehicles.set('JE', { marker: { remove }, data: {} });  // no _animFrame
    ui.showJourneyEnded();
    expect(remove).toHaveBeenCalledOnce();
    expect(globalThis.cancelAnimationFrame).not.toHaveBeenCalled();
    expect(state.vehicles.has('JE')).toBe(false);
  });

  it('does not throw when the selected jid has no vehicles entry', () => {
    state.selectedJid = 'GONE';
    expect(() => ui.showJourneyEnded()).not.toThrow();
    expect(ui.stopList.textContent).toMatch(/beendet|ended/i);
  });
});
