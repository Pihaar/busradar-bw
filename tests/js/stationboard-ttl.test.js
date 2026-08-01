/**
 * Tests for the stationboard 1h-TTL refetch in static/refresh.js
 * (_maybeRefetchBoards + _boardStale). Neither is exported; both are only
 * reachable through the load-time 1s ticker, so we drive them with fake timers
 * and vi.advanceTimersByTime(1000), exactly like refresh-ticker.test.js.
 *
 * Fake timers with a fixed system time are installed BEFORE importing refresh.js
 * so the setInterval(…, 1000) arms on the fake clock. The rest of the tick
 * (updateStopProgress, status-text repaint, stale-stream guard, force-reconnect)
 * is neutralised via the same clean state as refresh-ticker so only the board
 * TTL logic exercises here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Fixed, non-zero base time; the load-time interval arms on the fake clock.
const BASE = new Date('2026-05-15T12:00:00Z').getTime();
vi.useFakeTimers();
vi.setSystemTime(BASE);

globalThis.L = {
  latLng: (lat, lon) => ({ lat, lng: lon, distanceTo: () => 0 }),
};

// ui.js is fully mocked; loadDepartures/loadArrivals are the spies under test.
// _maybeRefetchBoards does not chain on their return, so plain vi.fn() is enough.
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
  loadDepartures: vi.fn(),
  loadArrivals: vi.fn(),
};
vi.mock('../../static/ui.js', () => ({ ui: uiMock }));
vi.mock('../../static/api.js', () => ({
  trackedFetch: (...a) => window.fetch(...a),
  api: {
    subscribeBoard: () => Promise.resolve({}),
    selectStream: vi.fn(() => Promise.resolve({})),
  },
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

const { _suspendStream } = await import('../../static/refresh.js');
const { state, settings } = await import('../../static/state.js');

const EXT_ID = '9999999';
const STALE = BASE - 3600001; // fetchedAt > 1h ago → stale
const FRESH = BASE - 1000; // fetchedAt 1s ago → within TTL
const TTL_MS = 3600000;

// Reset every board field to a not-stale baseline so a single flag can be
// flipped per test without a stale sibling firing an unexpected loader call.
function resetBoardState() {
  state.selectedStop = { lid: 'A=1@L=1@' };
  state._stationExtId = EXT_ID;
  state._stationDepData = { jnyL: [] };
  state._stationArrData = { jnyL: [] };
  state._stationDepFetching = false;
  state._stationArrFetching = false;
  state._stationDepRetryAt = 0;
  state._stationArrRetryAt = 0;
  state._stationDepFetchedAt = FRESH;
  state._stationArrFetchedAt = FRESH;
}

beforeEach(() => {
  vi.setSystemTime(BASE);
  _suspendStream();
  for (const fn of Object.values(uiMock)) if (fn.mockClear) fn.mockClear();
  for (const fn of Object.values(statusMock)) if (fn.mockClear) fn.mockClear();

  // Neutralise the rest of the 1s tick (mirrors refresh-ticker.test.js).
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

  resetBoardState();
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('_maybeRefetchBoards — selected-stop guard', () => {
  it('returns early when no stop is selected (no loader fires)', () => {
    state.selectedStop = null;
    state._stationDepFetchedAt = STALE;
    state._stationArrFetchedAt = STALE;
    vi.advanceTimersByTime(1000);
    expect(uiMock.loadDepartures).not.toHaveBeenCalled();
    expect(uiMock.loadArrivals).not.toHaveBeenCalled();
  });

  it('returns early when the selected stop has no lid', () => {
    state.selectedStop = { name: 'no-lid' };
    state._stationDepFetchedAt = STALE;
    state._stationArrFetchedAt = STALE;
    vi.advanceTimersByTime(1000);
    expect(uiMock.loadDepartures).not.toHaveBeenCalled();
    expect(uiMock.loadArrivals).not.toHaveBeenCalled();
  });
});

describe('_boardStale — DEP (isArr=false)', () => {
  it('not stale when the departures board was never loaded (data null)', () => {
    state._stationDepData = null;
    state._stationDepFetchedAt = STALE;
    vi.advanceTimersByTime(1000);
    expect(uiMock.loadDepartures).not.toHaveBeenCalled();
  });

  it('not stale while a departures fetch is in flight', () => {
    state._stationDepFetching = true;
    state._stationDepFetchedAt = STALE;
    vi.advanceTimersByTime(1000);
    expect(uiMock.loadDepartures).not.toHaveBeenCalled();
  });

  it('not stale while the backoff gate is open (now < retryAt)', () => {
    state._stationDepRetryAt = BASE + 100000;
    state._stationDepFetchedAt = STALE;
    vi.advanceTimersByTime(1000);
    expect(uiMock.loadDepartures).not.toHaveBeenCalled();
  });

  it('backoff gate expired (now >= retryAt) → still evaluates age and refetches', () => {
    state._stationDepRetryAt = BASE - 1000; // past → gate open, continue
    state._stationDepFetchedAt = STALE;
    vi.advanceTimersByTime(1000);
    expect(uiMock.loadDepartures).toHaveBeenCalledWith(state.selectedStop, EXT_ID, false);
  });

  it('not stale when fetchedAt is null', () => {
    state._stationDepFetchedAt = null;
    vi.advanceTimersByTime(1000);
    expect(uiMock.loadDepartures).not.toHaveBeenCalled();
  });

  it('not stale on a backward clock jump (fetchedAt in the future, age<0)', () => {
    state._stationDepFetchedAt = BASE + 5000; // age = -5000
    vi.advanceTimersByTime(1000);
    expect(uiMock.loadDepartures).not.toHaveBeenCalled();
  });

  it('not stale when the board is younger than the 1h TTL', () => {
    state._stationDepFetchedAt = BASE - (TTL_MS - 1000); // age just under TTL
    vi.advanceTimersByTime(1000);
    expect(uiMock.loadDepartures).not.toHaveBeenCalled();
  });

  it('stale past the 1h TTL → refetches the full-day departures board', () => {
    state._stationDepFetchedAt = STALE;
    vi.advanceTimersByTime(1000);
    expect(uiMock.loadDepartures).toHaveBeenCalledWith(state.selectedStop, EXT_ID, false);
    expect(uiMock.loadArrivals).not.toHaveBeenCalled();
  });
});

describe('_boardStale — ARR (isArr=true)', () => {
  it('not stale when the arrivals board was never loaded (data null)', () => {
    state._stationArrData = null;
    state._stationArrFetchedAt = STALE;
    vi.advanceTimersByTime(1000);
    expect(uiMock.loadArrivals).not.toHaveBeenCalled();
  });

  it('not stale while an arrivals fetch is in flight', () => {
    state._stationArrFetching = true;
    state._stationArrFetchedAt = STALE;
    vi.advanceTimersByTime(1000);
    expect(uiMock.loadArrivals).not.toHaveBeenCalled();
  });

  it('not stale while the arrivals backoff gate is open (now < retryAt)', () => {
    state._stationArrRetryAt = BASE + 100000;
    state._stationArrFetchedAt = STALE;
    vi.advanceTimersByTime(1000);
    expect(uiMock.loadArrivals).not.toHaveBeenCalled();
  });

  it('not stale when arrivals fetchedAt is null', () => {
    state._stationArrFetchedAt = null;
    vi.advanceTimersByTime(1000);
    expect(uiMock.loadArrivals).not.toHaveBeenCalled();
  });

  it('not stale on a backward clock jump (arrivals fetchedAt in the future)', () => {
    state._stationArrFetchedAt = BASE + 5000;
    vi.advanceTimersByTime(1000);
    expect(uiMock.loadArrivals).not.toHaveBeenCalled();
  });

  it('stale past the 1h TTL → refetches the full-day arrivals board', () => {
    state._stationArrFetchedAt = STALE;
    vi.advanceTimersByTime(1000);
    expect(uiMock.loadArrivals).toHaveBeenCalledWith(state.selectedStop, EXT_ID);
    expect(uiMock.loadDepartures).not.toHaveBeenCalled();
  });
});

describe('_maybeRefetchBoards — both boards stale', () => {
  it('refetches DEP and ARR together when both are past the TTL', () => {
    state._stationDepFetchedAt = STALE;
    state._stationArrFetchedAt = STALE;
    vi.advanceTimersByTime(1000);
    expect(uiMock.loadDepartures).toHaveBeenCalledWith(state.selectedStop, EXT_ID, false);
    expect(uiMock.loadArrivals).toHaveBeenCalledWith(state.selectedStop, EXT_ID);
  });

  it('refetches neither board while both are fresh (with a stop selected)', () => {
    vi.advanceTimersByTime(1000);
    expect(uiMock.loadDepartures).not.toHaveBeenCalled();
    expect(uiMock.loadArrivals).not.toHaveBeenCalled();
  });
});

describe('_boardStale — cold initial-fetch retry (data null + armed backoff)', () => {
  it('refetches a cold DEP board once its failure backoff has elapsed', () => {
    // Initial fetch failed: data stayed null, .catch armed retryAt in the past.
    state._stationDepData = null;
    state._stationDepRetryAt = BASE - 1; // elapsed
    vi.advanceTimersByTime(1000);
    expect(uiMock.loadDepartures).toHaveBeenCalledWith(state.selectedStop, EXT_ID, false);
  });

  it('does NOT refetch a cold board that was never attempted (retryAt 0 — lazy ARR)', () => {
    state._stationArrData = null;
    state._stationArrRetryAt = 0; // never fetched → !!retryAt false
    vi.advanceTimersByTime(1000);
    expect(uiMock.loadArrivals).not.toHaveBeenCalled();
  });

  it('does NOT refetch a cold board while its backoff is still pending', () => {
    state._stationDepData = null;
    state._stationDepRetryAt = BASE + 60000; // future → backoff not elapsed
    vi.advanceTimersByTime(1000);
    expect(uiMock.loadDepartures).not.toHaveBeenCalled();
  });
});

describe('_boardStale — cold retry is symmetric for the ARR board', () => {
  it('refetches a cold ARR board once its failure backoff has elapsed', () => {
    state._stationArrData = null;
    state._stationArrRetryAt = BASE - 1; // elapsed
    // DEP stays loaded+fresh so only ARR fires.
    vi.advanceTimersByTime(1000);
    expect(uiMock.loadArrivals).toHaveBeenCalledWith(state.selectedStop, EXT_ID);
    expect(uiMock.loadDepartures).not.toHaveBeenCalled();
  });
});
