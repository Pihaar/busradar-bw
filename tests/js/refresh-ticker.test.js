/**
 * Tests for the load-time 1s status ticker in static/refresh.js.
 *
 * The setInterval(…, 1000) is armed at module import time. To keep it on fake
 * timers (and off Epoch 0), we install fake timers with a fixed system time
 * BEFORE importing refresh.js — otherwise the interval arms against real timers
 * and never advances under vi.advanceTimersByTime. The stale-stream guard, the
 * status-text repaint, and the stale-timer force-reconnect all run off this tick.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A fixed, non-zero base time so lastUpdate/serverTimeStamp math is sane and
// the load-time interval is armed on the fake clock.
const BASE = new Date('2026-05-15T12:00:00Z').getTime();
vi.useFakeTimers();
vi.setSystemTime(BASE);

globalThis.L = {
  latLng: (lat, lon) => ({ lat, lng: lon, distanceTo: () => 0 }),
};

const uiMock = {
  drawRoute: vi.fn(),
  updateJourneyStopDelays: vi.fn(),
  showJourneyEnded: vi.fn(),
  _showJourneyCancelled: vi.fn(),
  hideTerminalBanner: vi.fn(),
  showVersionUpdateBanner: vi.fn(),
  showTerminalBanner: vi.fn(),
  updateSseState: vi.fn(),
  updateStopProgress: vi.fn(),
};
vi.mock('../../static/ui.js', () => ({ ui: uiMock }));
vi.mock('../../static/api.js', () => ({
  api: { selectStream: vi.fn(() => Promise.resolve({})) },
}));
vi.mock('../../static/map.js', () => ({
  markers: { updateAll: vi.fn() },
  stopsLayer: { update: vi.fn() },
  startLocationWatch: vi.fn(),
  stopLocationWatch: vi.fn(),
  removeUserLocationMarker: vi.fn(),
}));
const statusMock = {
  updateStatus: vi.fn(),
  getServerTimeStr: vi.fn(() => '12:00'),
  showError: vi.fn(),
  showPersistentError: vi.fn(),
  clearPersistentError: vi.fn(),
  announce: vi.fn(),
  formatStatusText: vi.fn(() => 'status-text-formatted'),
};
vi.mock('../../static/status.js', () => statusMock);

const { startStream, _suspendStream } = await import('../../static/refresh.js');
const { state, settings } = await import('../../static/state.js');

const instances = [];
class ESStub {
  constructor() {
    this.readyState = 1;
    this.onerror = null;
    this.listeners = {};
    this.close = vi.fn();
    instances.push(this);
  }
  addEventListener(type, cb) {
    (this.listeners[type] = this.listeners[type] || []).push(cb);
  }
}

let _origES;
let _origOnline;

beforeEach(() => {
  _origES = globalThis.EventSource;
  globalThis.EventSource = ESStub;
  vi.setSystemTime(BASE);
  _suspendStream();
  instances.length = 0;
  for (const fn of Object.values(uiMock)) if (fn.mockClear) fn.mockClear();
  for (const fn of Object.values(statusMock)) if (fn.mockClear) fn.mockClear();

  state.map = null;
  state.vehicles = new Map();
  state.selectedJid = null;
  state._currentStopL = null;
  state.lastUpdate = null;
  state.serverTimeStamp = null;
  state.serverTimeMin = null;
  state._lastBusCount = undefined;
  state._lastConnectedClients = undefined;
  state._errorUntil = 0;
  settings.current = { posMode: 'CALC', showLocation: false };

  // navigator.onLine defaults to true in happy-dom; make it explicit.
  _origOnline = Object.getOwnPropertyDescriptor(navigator, 'onLine');
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });

  // A clean status-dot for the stale-guard DOM checks.
  document.body.innerHTML = '';
});

afterEach(() => {
  globalThis.EventSource = _origES;
  if (_origOnline) Object.defineProperty(navigator, 'onLine', _origOnline);
  document.body.innerHTML = '';
});

function addStatusDot() {
  const dot = document.createElement('div');
  dot.className = 'status-dot';
  document.body.appendChild(dot);
  return dot;
}

function addStatusText() {
  const el = document.createElement('div');
  el.id = 'status-text';
  document.body.appendChild(el);
  return el;
}

describe('1s ticker — stop-progress repaint', () => {
  it('calls ui.updateStopProgress when a stop list and a selected journey exist', () => {
    state._currentStopL = [{ locX: 0 }];
    state.selectedJid = 'J1';
    vi.advanceTimersByTime(1000);
    expect(uiMock.updateStopProgress).toHaveBeenCalledWith(state._currentStopL);
  });

  it('does not repaint stop progress without a selected journey', () => {
    state._currentStopL = [{ locX: 0 }];
    state.selectedJid = null;
    vi.advanceTimersByTime(1000);
    expect(uiMock.updateStopProgress).not.toHaveBeenCalled();
  });
});

describe('1s ticker — status-text repaint', () => {
  it('repaints #status-text from formatStatusText when a server time and bus count are set', () => {
    state.serverTimeStamp = BASE;
    state._lastBusCount = 12;
    const el = addStatusText();
    vi.advanceTimersByTime(1000);
    expect(statusMock.formatStatusText).toHaveBeenCalledWith(12, undefined, '12:00');
    expect(el.textContent).toBe('status-text-formatted');
  });

  it('does not repaint while an error window is active', () => {
    state.serverTimeStamp = BASE;
    state._lastBusCount = 12;
    state._errorUntil = BASE + 100000; // now < _errorUntil → suppressed
    addStatusText();
    vi.advanceTimersByTime(1000);
    expect(statusMock.formatStatusText).not.toHaveBeenCalled();
  });

  it('skips the format call when #status-text is missing (if(textEl) false branch)', () => {
    state.serverTimeStamp = BASE;
    state._lastBusCount = 12;
    // no #status-text element in the DOM → the write (and its format call) is skipped
    vi.advanceTimersByTime(1000);
    expect(statusMock.formatStatusText).not.toHaveBeenCalled();
  });
});

describe('1s ticker — stale-stream guard (flip dot to offline)', () => {
  it('shows the stale banner when lastUpdate is older than the CALC threshold', () => {
    state.lastUpdate = BASE - 46000; // > 45s
    addStatusDot();
    vi.advanceTimersByTime(1000);
    expect(statusMock.showPersistentError).toHaveBeenCalled();
  });

  it('uses the wider REPORT_ONLY threshold (75s) — 46s is NOT yet stale', () => {
    settings.current = { posMode: 'REPORT_ONLY' };
    state.lastUpdate = BASE - 46000; // < 75s
    addStatusDot();
    vi.advanceTimersByTime(1000);
    expect(statusMock.showPersistentError).not.toHaveBeenCalled();
  });

  it('flips on navigator.onLine === false even when data is fresh', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    state.lastUpdate = BASE; // fresh
    addStatusDot();
    vi.advanceTimersByTime(1000);
    expect(statusMock.showPersistentError).toHaveBeenCalled();
  });

  it('does not re-show the banner when the dot is already --offline', () => {
    state.lastUpdate = BASE - 46000;
    const dot = addStatusDot();
    dot.classList.add('status-dot--offline');
    vi.advanceTimersByTime(1000);
    expect(statusMock.showPersistentError).not.toHaveBeenCalled();
  });

  it('does not re-show the banner when the dot is already --error', () => {
    state.lastUpdate = BASE - 46000;
    const dot = addStatusDot();
    dot.classList.add('status-dot--error');
    vi.advanceTimersByTime(1000);
    expect(statusMock.showPersistentError).not.toHaveBeenCalled();
  });

  it('stale but no dot in the DOM → no banner call (dot-guard)', () => {
    state.lastUpdate = BASE - 46000;
    // no .status-dot element
    vi.advanceTimersByTime(1000);
    expect(statusMock.showPersistentError).not.toHaveBeenCalled();
  });
});

describe('1s ticker — stale-timer force-reconnect', () => {
  it('force-reconnects when stale, the socket claims OPEN, and we are online', () => {
    startStream();
    instances[0].readyState = 1;
    state.lastUpdate = BASE - 46000; // stale
    vi.advanceTimersByTime(1000);
    // _forceReconnect closes the old ES and opens a new one.
    expect(instances.length).toBe(2);
  });

  it('does not force-reconnect while offline (offline path owns the UI)', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    startStream();
    instances[0].readyState = 1;
    state.lastUpdate = BASE - 46000;
    vi.advanceTimersByTime(1000);
    expect(instances.length).toBe(1);
  });

  it('does not force-reconnect when the socket is not OPEN', () => {
    startStream();
    instances[0].readyState = 0; // CONNECTING
    state.lastUpdate = BASE - 46000;
    vi.advanceTimersByTime(1000);
    expect(instances.length).toBe(1);
  });

  it('force-reconnect is rate-limited by the 15s cooldown', () => {
    startStream();
    instances[0].readyState = 1;
    state.lastUpdate = BASE - 46000;
    vi.advanceTimersByTime(1000);
    expect(instances.length).toBe(2);
    // Immediately stale again within the cooldown → no third instance.
    instances[1].readyState = 1;
    state.lastUpdate = BASE - 46000;
    vi.advanceTimersByTime(1000);
    expect(instances.length).toBe(2);
  });
});
