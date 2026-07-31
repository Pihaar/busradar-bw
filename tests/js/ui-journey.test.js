/**
 * Coverage for journey rendering in static/ui.js: renderJourneyStops (stop
 * rows, passed dots, journey/per-stop messages, day-offset badges, clickable
 * stop names), _populateStopTimes (split dwell vs single row), _buildStopTimeRow
 * (planned/real vs single time, delay badge), and _clearStopTrack.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildPanelDom, wireUiRefs } from './ui-dom.js';

globalThis.L = {
  latLng: (lat, lon) => ({ lat, lng: lon }),
  latLngBounds: (c) => ({ _c: c }),
  layerGroup: vi.fn(() => ({ addTo: vi.fn(), addLayer: vi.fn() })),
  polyline: vi.fn(() => ({ addTo: vi.fn() })),
  circleMarker: vi.fn(() => ({ addTo: vi.fn(), bindTooltip: vi.fn(), on: vi.fn() })),
};

vi.mock('../../static/api.js', () => ({
  api: {
    getStationBoard: vi.fn(),
    getJourney: vi.fn(),
    selectStream: vi.fn(() => Promise.resolve()),
  },
  urlState: { push: vi.fn(), replace: vi.fn() },
}));
vi.mock('../../static/map.js', () => ({
  markers: { updateAll: vi.fn(), highlightSelected: vi.fn() },
  stopsLayer: { update: vi.fn(), addStopMarker: vi.fn(), saveToCache: vi.fn() },
}));
vi.mock('../../static/status.js', () => ({ announce: vi.fn() }));

const { ui } = await import('../../static/ui.js');
const { state } = await import('../../static/state.js');

// HAFAS HHMMSS for a minute-of-day.
function hhmmss(min) {
  const h = String(Math.floor(min / 60)).padStart(2, '0');
  const m = String(min % 60).padStart(2, '0');
  return h + m + '00';
}

beforeEach(() => {
  buildPanelDom();
  wireUiRefs(ui);
  state.serverTimeStamp = null;
  state.serverTimeMin = 600; // 10:00
  state.map = { setView: vi.fn() };
  state.allStops = new Map();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ui._buildStopTimeRow', () => {
  it('renders planned + real spans when they differ', () => {
    const row = ui._buildStopTimeRow('100000', '100300', 3, null);
    expect(row.querySelector('.stop-time-planned')).not.toBeNull();
    expect(row.querySelector('.stop-time-real')).not.toBeNull();
    expect(row.querySelector('.stop-delay')).not.toBeNull();
  });

  it('renders a single "only" span when planned equals real', () => {
    const row = ui._buildStopTimeRow('100000', '100000', 0, null);
    expect(row.querySelector('.stop-time-only')).not.toBeNull();
    expect(row.querySelector('.stop-delay')).toBeNull(); // delay 0 → no badge
  });

  it('renders a label prefix for split rows', () => {
    const row = ui._buildStopTimeRow('100000', '100000', null, 'Ab');
    expect(row.querySelector('.stop-time-label').textContent).toBe('Ab');
  });

  it('major delay badge (> 5) gets the major class', () => {
    const row = ui._buildStopTimeRow('100000', '100800', 8, null);
    expect(row.querySelector('.stop-delay--major')).not.toBeNull();
  });

  it('delayed badge (> 2, <= 5) gets the delayed class', () => {
    const row = ui._buildStopTimeRow('100000', '100400', 4, null);
    expect(row.querySelector('.stop-delay--delayed')).not.toBeNull();
  });

  it('small delay (<= 2) gets the ontime class', () => {
    const row = ui._buildStopTimeRow('100000', '100100', 1, null);
    expect(row.querySelector('.stop-delay--ontime')).not.toBeNull();
  });

  it('renders nothing time-wise when neither time is set', () => {
    const row = ui._buildStopTimeRow('', '', null, null);
    expect(row.querySelector('.stop-time-planned')).toBeNull();
    expect(row.querySelector('.stop-time-only')).toBeNull();
  });
});

describe('ui._populateStopTimes', () => {
  it('two-line split layout when a realtime dwell >= 1 min exists', () => {
    const el = document.createElement('div');
    ui._populateStopTimes(el, {
      aTimeS: '100000',
      aTimeR: '100000',
      dTimeS: '100200',
      dTimeR: '100200',
    });
    expect(el.classList.contains('stop-times--split')).toBe(true);
    expect(el.querySelector('.stop-time-row--arrival')).not.toBeNull();
    expect(el.querySelector('.stop-time-row--departure')).not.toBeNull();
  });

  it('single row (departure side) for an intermediate stop without dwell', () => {
    const el = document.createElement('div');
    ui._populateStopTimes(el, { aTimeS: '100000', dTimeS: '100000' });
    expect(el.classList.contains('stop-times--split')).toBe(false);
    expect(el.querySelector('.stop-time-row--single')).not.toBeNull();
  });

  it('falls back to the arrival side for an end stop (arrival only)', () => {
    const el = document.createElement('div');
    ui._populateStopTimes(el, { aTimeS: '100000', aTimeR: '100000' });
    expect(el.querySelector('.stop-time-row--single')).not.toBeNull();
  });

  it('renders no row when the stop has no times at all', () => {
    const el = document.createElement('div');
    ui._populateStopTimes(el, {});
    expect(el.querySelector('.stop-time-row')).toBeNull();
  });

  it('dwell across midnight wrap is normalised (no false negative dwell)', () => {
    const el = document.createElement('div');
    // arrival 23:59, departure 00:02 next day → diff wraps to +3
    ui._populateStopTimes(el, {
      aTimeS: '235900',
      aTimeR: '235900',
      dTimeS: '000200',
      dTimeR: '000200',
    });
    expect(el.classList.contains('stop-times--split')).toBe(true);
  });
});

describe('ui.renderJourneyStops', () => {
  function jd(stopL, extra) {
    return Object.assign(
      { journey: { stopL }, common: { locL: stopL.map((_, i) => ({ name: 'Stop ' + i })) } },
      extra || {},
    );
  }

  it('renders one stop-item per stop and schedules the progress update', () => {
    state.selectedJid = 'J-test'; // the deferred paint is guarded on an active selection
    const spy = vi.spyOn(ui, 'updateStopProgress').mockImplementation(() => {});
    ui.renderJourneyStops(
      jd([
        { locX: 0, dTimeS: hhmmss(590) },
        { locX: 1, dTimeS: hhmmss(610) },
      ]),
    );
    expect(ui.stopList.querySelectorAll('.stop-item').length).toBe(2);
    vi.advanceTimersByTime(100);
    expect(spy).toHaveBeenCalledWith(state._currentStopL);
  });

  it('skips the deferred progress paint if the panel was closed before it fires', () => {
    state.selectedJid = 'J-test';
    const spy = vi.spyOn(ui, 'updateStopProgress').mockImplementation(() => {});
    ui.renderJourneyStops(
      jd([
        { locX: 0, dTimeS: hhmmss(590) },
        { locX: 1, dTimeS: hhmmss(610) },
      ]),
    );
    state.selectedJid = null; // panel closed within the 100ms window
    vi.advanceTimersByTime(100);
    expect(spy).not.toHaveBeenCalled();
  });

  it('marks a past stop dot as passed and a future one as not', () => {
    ui.renderJourneyStops(
      jd([
        { locX: 0, dTimeS: hhmmss(540) },
        { locX: 1, dTimeS: hhmmss(660) },
      ]),
    );
    const dots = ui.stopList.querySelectorAll('.stop-dot');
    expect(dots[0].classList.contains('stop-dot--passed')).toBe(true); // 09:00 < now
    expect(dots[1].classList.contains('stop-dot--passed')).toBe(false); // 11:00 > now
  });

  it('uses the stop_fallback name when locL entry is missing', () => {
    const data = { journey: { stopL: [{ locX: 5, dTimeS: hhmmss(590) }] }, common: { locL: [] } };
    ui.renderJourneyStops(data);
    const name = ui.stopList.querySelector('.stop-name').textContent;
    expect(name.length).toBeGreaterThan(0);
  });

  it('inserts a journey-message banner for journey-level messages', () => {
    const data = {
      journey: {
        stopL: [
          { locX: 0, dTimeS: hhmmss(590) },
          { locX: 1, dTimeS: hhmmss(610) },
        ],
        msgL: [{ type: 'REM', remX: 0 }],
      },
      common: {
        locL: [{ name: 'A' }, { name: 'B' }],
        remL: [{ code: 'BE', txtN: 'Aufzug defekt' }],
      },
    };
    ui.renderJourneyStops(data);
    const banner = ui.stopList.parentNode.querySelector('.journey-msg-container');
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain('Aufzug defekt');
  });

  it('removes a stale journey-msg-container before re-rendering', () => {
    const stale = document.createElement('div');
    stale.className = 'journey-msg-container';
    ui.stopList.parentNode.insertBefore(stale, ui.stopList);
    ui.renderJourneyStops(
      jd([
        { locX: 0, dTimeS: hhmmss(590) },
        { locX: 1, dTimeS: hhmmss(610) },
      ]),
    );
    // only zero or one container, and it is not the stale node
    const containers = ui.stopList.parentNode.querySelectorAll('.journey-msg-container');
    expect(containers.length).toBeLessThanOrEqual(1);
    expect([...containers]).not.toContain(stale);
  });

  it('renders a per-stop message under the matching stop', () => {
    const data = {
      journey: {
        stopL: [
          { locX: 0, dTimeS: hhmmss(590) },
          { locX: 1, dTimeS: hhmmss(610) },
        ],
        msgL: [{ type: 'REM', remX: 0, fLocX: 1, tLocX: 1 }],
      },
      common: {
        locL: [{ name: 'A' }, { name: 'B' }],
        remL: [{ code: 'BE', txtN: 'Steig geändert' }],
      },
    };
    ui.renderJourneyStops(data);
    expect(ui.stopList.querySelector('.stop-msg')).not.toBeNull();
  });

  it('adds a day-offset badge when a stop time carries a day offset', () => {
    // "241000" → 24:10 = +1 day badge via getDayOffset
    ui.renderJourneyStops(
      jd([
        { locX: 0, dTimeS: hhmmss(590) },
        { locX: 1, dTimeS: '241000' },
      ]),
    );
    expect(ui.stopList.querySelector('.departure-day-badge')).not.toBeNull();
  });

  it('infers a day rollover when a later stop time wraps before midnight', () => {
    // prev stop 23:30 (>720), next 00:10 (<360) → cumulative day offset inferred
    ui.renderJourneyStops(
      jd([
        { locX: 0, dTimeS: hhmmss(1410) },
        { locX: 1, dTimeS: hhmmss(10) },
      ]),
    );
    expect(ui.stopList.querySelector('.departure-day-badge')).not.toBeNull();
  });

  it('makes a stop with a lid clickable and opens its station board (cached hit)', () => {
    const cached = { extId: 'E1', name: 'A', platform: '2' };
    state.allStops = new Map([['k', { data: cached }]]);
    const data = {
      journey: {
        stopL: [
          { locX: 0, dTimeS: hhmmss(590) },
          { locX: 1, dTimeS: hhmmss(610) },
        ],
      },
      common: {
        locL: [
          { name: 'A', lid: 'A=1@L=1@', extId: 'E1', crd: { x: 8600000, y: 49300000 } },
          { name: 'B' },
        ],
      },
    };
    ui.renderJourneyStops(data);
    const sbSpy = vi.spyOn(ui, 'showStationBoard').mockImplementation(() => {});
    const nameEl = ui.stopList.querySelector('.stop-name');
    nameEl.click();
    expect(state.map.setView).toHaveBeenCalled();
    expect(sbSpy).toHaveBeenCalledWith(cached);
  });

  it('clickable stop with no cache falls back to a synthetic loc', () => {
    state.allStops = new Map();
    const data = {
      journey: {
        stopL: [
          { locX: 0, dTimeS: hhmmss(590) },
          { locX: 1, dTimeS: hhmmss(610) },
        ],
      },
      common: {
        locL: [
          { name: 'A', lid: 'A=1@L=9@', extId: '', crd: { x: 8600000, y: 49300000 } },
          { name: 'B' },
        ],
      },
    };
    ui.renderJourneyStops(data);
    const sbSpy = vi.spyOn(ui, 'showStationBoard').mockImplementation(() => {});
    ui.stopList.querySelector('.stop-name').click();
    expect(sbSpy).toHaveBeenCalledWith(expect.objectContaining({ lid: 'A=1@L=9@' }));
  });

  it('clickable stop matches a cached stop by name/proximity when extId is absent', () => {
    const near = { name: 'A', lat: 49.3, lon: 8.6, platform: '' };
    state.allStops = new Map([['k', { data: near }]]);
    const data = {
      journey: {
        stopL: [
          { locX: 0, dTimeS: hhmmss(590) },
          { locX: 1, dTimeS: hhmmss(610) },
        ],
      },
      common: {
        locL: [
          { name: 'A', lid: 'A=1@L=1@', extId: '', crd: { x: 8600000, y: 49300000 } },
          { name: 'B' },
        ],
      },
    };
    ui.renderJourneyStops(data);
    const sbSpy = vi.spyOn(ui, 'showStationBoard').mockImplementation(() => {});
    ui.stopList.querySelector('.stop-name').click();
    expect(sbSpy).toHaveBeenCalledWith(near);
  });

  it('reuses the existing #stop-progress element instead of duplicating it', () => {
    ui.renderJourneyStops(
      jd([
        { locX: 0, dTimeS: hhmmss(590) },
        { locX: 1, dTimeS: hhmmss(610) },
      ]),
    );
    expect(ui.stopList.querySelectorAll('#stop-progress').length).toBe(1);
  });

  it('creates a #stop-progress element when none exists', () => {
    document.getElementById('stop-progress').remove();
    ui.renderJourneyStops(
      jd([
        { locX: 0, dTimeS: hhmmss(590) },
        { locX: 1, dTimeS: hhmmss(610) },
      ]),
    );
    expect(ui.stopList.querySelector('#stop-progress')).not.toBeNull();
  });
});

describe('ui._clearStopTrack', () => {
  it('removes both track CSS vars from the stop list', () => {
    ui.stopList.style.setProperty('--stop-track-top', '10px');
    ui.stopList.style.setProperty('--stop-track-height', '50px');
    ui._clearStopTrack();
    expect(ui.stopList.style.getPropertyValue('--stop-track-top')).toBe('');
    expect(ui.stopList.style.getPropertyValue('--stop-track-height')).toBe('');
  });
});
