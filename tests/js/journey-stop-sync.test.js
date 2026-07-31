/**
 * Regression test: two clients viewing the same journey must show identical
 * stop data. updateJourneyStopDelays patches delay/passed state into the DOM
 * rows POSITIONALLY by index. HAFAS prunes already-passed stops from the front
 * of stopL over a journey's life, so a client that first rendered earlier has a
 * differently-aligned DOM than one that rendered later; the same server push
 * then landed on misaligned rows (wrong times, wrong "passed" dots), diverging
 * per client. The fix rebuilds the rows when the stop set's structural
 * signature changes, re-syncing the DOM to the current stopL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

globalThis.L = { latLng: (lat, lon) => ({ lat, lng: lon }) };

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

function stop(dTimeS, dTimeR) {
  return { locX: 0, dTimeS, dTimeR: dTimeR || dTimeS };
}
// journeyData shape as pushed per tick: { journey: { stopL }, common: { locL } }
function jd(stopL) {
  return { journey: { stopL }, common: { locL: [{ name: 'X' }] } };
}
// Build a DOM stop-list with `n` rows (matching a prior render of `n` stops).
function buildDom(n) {
  const list = document.createElement('ol');
  for (let i = 0; i < n; i++) {
    const li = document.createElement('li');
    li.className = 'stop-item';
    const dot = document.createElement('div');
    dot.className = 'stop-dot';
    const times = document.createElement('div');
    times.className = 'stop-times';
    li.append(dot, times);
    list.appendChild(li);
  }
  document.body.appendChild(list);
  ui.stopList = list;
}

describe('ui._stopSig — structural signature', () => {
  it('is stable when only the real/delay time changes (scheduled time fixed)', () => {
    const a = ui._stopSig([stop('120000', '120000'), stop('121000', '121000')]);
    const b = ui._stopSig([stop('120000', '120300'), stop('121000', '121500')]);
    expect(b).toBe(a); // delay grew but the set is unchanged → no rebuild
  });

  it('changes when a stop is pruned from the front', () => {
    const full = ui._stopSig([stop('120000'), stop('121000'), stop('122000')]);
    const pruned = ui._stopSig([stop('121000'), stop('122000')]);
    expect(pruned).not.toBe(full);
  });

  it('changes when a stop is swapped (same length + times, different locX)', () => {
    const a = ui._stopSig([
      { locX: 0, dTimeS: '120000' },
      { locX: 1, dTimeS: '121000' },
    ]);
    const b = ui._stopSig([
      { locX: 0, dTimeS: '120000' },
      { locX: 2, dTimeS: '121000' },
    ]);
    expect(b).not.toBe(a); // a reroute swaps a stop the times alone wouldn't catch
  });

  it('handles empty, single, and time-less stop lists without throwing', () => {
    expect(ui._stopSig([])).toBe('0#');
    expect(typeof ui._stopSig([stop('120000')])).toBe('string');
    // stops with neither dTimeS nor aTimeS still yield a stable signature
    expect(ui._stopSig([{ locX: 5 }, { locX: 6 }])).toBe(ui._stopSig([{ locX: 5 }, { locX: 6 }]));
  });
});

describe('ui.updateJourneyStopDelays — rebuild on structural change, patch otherwise', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    state.serverTimeStamp = null;
    state.serverTimeMin = 600;
    vi.restoreAllMocks();
  });

  it('patches in place (no rebuild) when the stop set is unchanged', () => {
    const stopL = [stop('095000'), stop('100000'), stop('101000')];
    buildDom(3);
    state._renderedStopSig = ui._stopSig(stopL);
    const spy = vi.spyOn(ui, 'renderJourneyStops').mockImplementation(() => {});

    ui.updateJourneyStopDelays(jd(stopL));

    expect(spy).not.toHaveBeenCalled();
    // passed dots: stops at 09:50/10:00 are before now (10:00) → passed
    const dots = ui.stopList.querySelectorAll('.stop-dot');
    expect(dots[0].classList.contains('stop-dot--passed')).toBe(true);
  });

  it('rebuilds (renderJourneyStops) when the stop set changed structurally', () => {
    // DOM was built from 3 stops; server now pushes a front-pruned 2-stop set.
    buildDom(3);
    state._renderedStopSig = ui._stopSig([stop('095000'), stop('100000'), stop('101000')]);
    const prunedData = jd([stop('100000'), stop('101000')]);
    const spy = vi.spyOn(ui, 'renderJourneyStops').mockImplementation(() => {});

    ui.updateJourneyStopDelays(prunedData);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(prunedData);
  });

  it('really rebuilds the DOM to the pruned set and resets the signature (no rebuild loop)', () => {
    vi.useFakeTimers(); // renderJourneyStops schedules a 100ms updateStopProgress
    try {
      const list = document.createElement('ol');
      document.body.appendChild(list);
      ui.stopList = list;

      ui.renderJourneyStops(jd([stop('095000'), stop('100000'), stop('101000')]));
      expect(list.querySelectorAll('.stop-item').length).toBe(3);

      const pruned = jd([stop('100000'), stop('101000')]);
      ui.updateJourneyStopDelays(pruned); // signature differs → real rebuild
      expect(list.querySelectorAll('.stop-item').length).toBe(2);
      expect(state._renderedStopSig).toBe(ui._stopSig(pruned.journey.stopL));

      // an identical follow-up push must patch in place, not rebuild again
      const spy = vi.spyOn(ui, 'renderJourneyStops');
      ui.updateJourneyStopDelays(pruned);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rebuilds when a stop is swapped (same length + times, different locX)', () => {
    buildDom(2);
    state._renderedStopSig = ui._stopSig([
      { locX: 0, dTimeS: '100000' },
      { locX: 1, dTimeS: '101000' },
    ]);
    const swapped = {
      journey: {
        stopL: [
          { locX: 0, dTimeS: '100000' },
          { locX: 2, dTimeS: '101000' }, // reroute: different stop, same time
        ],
      },
      common: { locL: [{ name: 'X' }] },
    };
    const spy = vi.spyOn(ui, 'renderJourneyStops').mockImplementation(() => {});
    ui.updateJourneyStopDelays(swapped);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('ui._nowMin — unified server-now in fractional minutes-of-day', () => {
  it('returns serverTimeMin exactly when no serverTimeStamp is set', () => {
    state.serverTimeMin = 600;
    state.serverTimeStamp = null;
    expect(ui._nowMin()).toBe(600);
  });

  it('adds fractional elapsed minutes since the server timestamp', () => {
    state.serverTimeMin = 600;
    state.serverTimeStamp = Date.now() - 90000; // 1.5 min ago
    const v = ui._nowMin();
    expect(v).toBeGreaterThan(601.4);
    expect(v).toBeLessThan(601.6); // fractional, not rounded to 602
  });

  it('treats a null serverTimeMin as 0', () => {
    state.serverTimeMin = null;
    state.serverTimeStamp = null;
    expect(ui._nowMin()).toBe(0);
  });
});
