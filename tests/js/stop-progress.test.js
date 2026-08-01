/**
 * Regression test: the stop-progress connecting line must reach the last stop.
 *
 * The grey track (.stop-list::before) and coloured bar (#stop-progress) used
 * fixed pixel constants (top:16px, bottom:60px, +4) tuned to one stop-item
 * height. Stop-item height varies with content — a stop gains an ANKUNFT row
 * beneath its ABFAHRT row while a bus dwells there, the terminus is a single
 * row, font sizes differ — so the constants drifted and the line stopped ~24px
 * short of the final stop dot (measured live: first dot 18px, last 995px,
 * track ended 971.5px).
 *
 * The fix anchors both to the measured .stop-dot centres via the
 * --stop-track-top / --stop-track-height CSS vars, recomputed on every 1s tick
 * so it adapts to rows added mid-journey. These tests stub distinct per-dot
 * rects (uniform stubs would collapse firstY===lastY and hide the bug).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

globalThis.L = { latLng: (lat, lon) => ({ lat, lng: lon }) };

vi.mock('../../static/api.js', () => ({
  trackedFetch: (...a) => window.fetch(...a),
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

// Build a stop-list whose dots sit at the given viewport-Y centres (non-uniform
// gaps model single- vs two-row stops). Returns the progress element.
function buildStopList(dotCentres) {
  const list = document.createElement('ol');
  list.getBoundingClientRect = () => ({ top: 0, left: 0, height: 1000, width: 300 });
  dotCentres.forEach((cy) => {
    const li = document.createElement('li');
    li.className = 'stop-item';
    const dot = document.createElement('span');
    dot.className = 'stop-dot';
    // dot is 8px tall; centre cy → top = cy-4. listRect.top is 0.
    dot.getBoundingClientRect = () => ({ top: cy - 4, height: 8, left: 9, width: 8 });
    li.appendChild(dot);
    list.appendChild(li);
  });
  const prog = document.createElement('div');
  prog.id = 'stop-progress';
  prog.className = 'stop-list-progress';
  list.appendChild(prog);
  document.body.appendChild(list);
  ui.stopList = list;
  return prog;
}

// HAFAS "HHMMSS" for a given total minute-of-day.
function hhmmss(min) {
  const h = String(Math.floor(min / 60)).padStart(2, '0');
  const m = String(min % 60).padStart(2, '0');
  return h + m + '00';
}

describe('ui.updateStopProgress — line anchors to dot centres, reaches the last stop', () => {
  // Non-uniform centres: gap 54 then 76 (a two-row stop) then 62 → proves the
  // line follows real dot positions, not a uniform assumption.
  const dots = [18, 72, 148, 210];

  beforeEach(() => {
    document.body.innerHTML = '';
    state.serverTimeStamp = null; // elapsedMs → 0, nowMin = serverTimeMin
    state.serverTimeMin = 600; // 10:00
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('all stops passed: track and bar both span the full first→last dot distance', () => {
    const prog = buildStopList(dots);
    // every stop time in the past → fully passed
    const stopL = [540, 550, 560, 570].map((m) => ({ dTimeS: hhmmss(m) }));

    ui.updateStopProgress(stopL);

    const top = ui.stopList.style.getPropertyValue('--stop-track-top');
    const height = ui.stopList.style.getPropertyValue('--stop-track-height');
    expect(top).toBe('18px'); // first dot centre
    expect(height).toBe('192px'); // 210 - 18 = last − first dot centre
    // the coloured bar reaches the last dot: its height equals the track height
    expect(prog.style.height).toBe('192px');
  });

  it('no stop passed yet: track spans full span, coloured bar is empty', () => {
    const prog = buildStopList(dots);
    const stopL = [660, 670, 680, 690].map((m) => ({ dTimeS: hhmmss(m) })); // all future

    ui.updateStopProgress(stopL);

    expect(ui.stopList.style.getPropertyValue('--stop-track-height')).toBe('192px');
    expect(prog.style.height).toBe('0px');
  });

  it('mid-journey: bar interpolates between the passed dot and the next dot centre', () => {
    const prog = buildStopList(dots);
    // stop2 (idx1, 550) passed, stop3 (idx2, 650) is next; now=600 → 50% between
    const stopL = [
      { dTimeS: hhmmss(500) },
      { dTimeS: hhmmss(550) },
      { dTimeS: hhmmss(650) },
      { dTimeS: hhmmss(700) },
    ];

    ui.updateStopProgress(stopL);

    // between dot idx1 (72) and idx2 (148): 72 + (148-72)*0.5 = 110; minus firstY 18 = 92
    expect(prog.style.height).toBe('92px');
  });

  it('clears the track vars when the list has no stop-items (empty/ended state)', () => {
    buildStopList(dots);
    ui.updateStopProgress([540, 550].map((m) => ({ dTimeS: hhmmss(m) })));
    expect(ui.stopList.style.getPropertyValue('--stop-track-top')).toBe('18px');

    // simulate journey-ended: list replaced by a non-route body, ticker re-runs
    ui.stopList.querySelectorAll('.stop-item').forEach((el) => el.remove());
    ui.updateStopProgress([540, 550].map((m) => ({ dTimeS: hhmmss(m) })));

    expect(ui.stopList.style.getPropertyValue('--stop-track-top')).toBe('');
    expect(ui.stopList.style.getPropertyValue('--stop-track-height')).toBe('');
  });

  it('is a no-op guard for a degenerate <2-stop route (and clears any stale track)', () => {
    buildStopList([18]);
    ui.stopList.style.setProperty('--stop-track-top', '99px');
    ui.updateStopProgress([{ dTimeS: hhmmss(540) }]); // length < 2
    expect(ui.stopList.style.getPropertyValue('--stop-track-top')).toBe('');
  });
});
