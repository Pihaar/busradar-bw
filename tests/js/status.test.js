/**
 * Tests for static/status.js — the status-dot / accessibility helpers.
 *
 * Pure functions (getServerTimeStr, formatStatusText) are asserted on their
 * return value; announce/updateStatus/showError/showPersistentError paint a
 * small DOM fixture (#sr-announcer, .status-dot, #status-text) whose resulting
 * state is asserted. Fake timers drive the announce clear + the status-dot
 * flash removal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { state } from '../../static/state.js';
import {
  announce,
  getServerTimeStr,
  formatStatusText,
  updateStatus,
  showError,
  showPersistentError,
  clearPersistentError,
} from '../../static/status.js';

function fixture() {
  document.body.innerHTML =
    '<div id="sr-announcer"></div>' +
    '<span class="status-dot"></span>' +
    '<span id="status-text"></span>';
}

beforeEach(() => {
  fixture();
  state.serverTimeStamp = null;
  state.serverTimeMin = null;
  state._errorUntil = 0;
  state.consecutiveErrors = 0;
  state._lastBusCount = 0;
  state.lastUpdate = null;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('getServerTimeStr', () => {
  it('returns 00:00:00 when neither serverTimeStamp nor serverTimeMin is set (both falsy branches)', () => {
    state.serverTimeStamp = null;
    state.serverTimeMin = null;
    expect(getServerTimeStr()).toBe('00:00:00');
  });

  it('formats hours/minutes/seconds from serverTimeMin with zero elapsed (both truthy branches)', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    state.serverTimeStamp = 1_000_000; // elapsedMs = 0
    state.serverTimeMin = 720.5; // 12:00:30
    expect(getServerTimeStr()).toBe('12:00:30');
  });

  it('advances the clock by the elapsed wall time since the server stamp', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000 + 60_000); // +1 min elapsed
    state.serverTimeStamp = 1_000_000;
    state.serverTimeMin = 720; // 12:00 + 1 min = 12:01:00
    expect(getServerTimeStr()).toBe('12:01:00');
  });
});

describe('formatStatusText', () => {
  it('count=1, no users → bus_count_one', () => {
    expect(formatStatusText(1, null, '12:00')).toBe('1 Bus · 12:00');
  });

  it('count=1, users="1" → bus_count_one_with_users + users_one', () => {
    expect(formatStatusText(1, '1', '12:00')).toBe('1 Bus · 1 Nutzer · 12:00');
  });

  it('count=1, users="5" → bus_count_one_with_users + users_many', () => {
    expect(formatStatusText(1, '5', '12:00')).toBe('1 Bus · 5 Nutzer · 12:00');
  });

  it('count=3, no users → buses_count', () => {
    expect(formatStatusText(3, null, '12:00')).toBe('3 Busse · 12:00');
  });

  it('count=3, users="1" → buses_count_with_users + users_one', () => {
    expect(formatStatusText(3, '1', '12:00')).toBe('3 Busse · 1 Nutzer · 12:00');
  });

  it('users="0" is treated as no users (users!=="0" branch false)', () => {
    expect(formatStatusText(3, '0', '12:00')).toBe('3 Busse · 12:00');
  });

  it('non-string users is ignored (typeof check false)', () => {
    expect(formatStatusText(3, 5, '12:00')).toBe('3 Busse · 12:00');
  });

  it('empty-string users is ignored (falsy branch)', () => {
    expect(formatStatusText(3, '', '12:00')).toBe('3 Busse · 12:00');
  });
});

describe('announce', () => {
  it('sets the announcer text and clears it after 3000ms', () => {
    vi.useFakeTimers();
    announce('Bus ausgewählt');
    const el = document.getElementById('sr-announcer');
    expect(el.textContent).toBe('Bus ausgewählt');
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(3000);
    expect(el.textContent).toBe('');
  });

  it('no announcer element → returns before scheduling any timer', () => {
    vi.useFakeTimers();
    document.getElementById('sr-announcer').remove();
    announce('lost');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('updateStatus', () => {
  it('_errorUntil === Infinity: clears the persistent error and paints the live state', () => {
    state._errorUntil = Infinity;
    state.consecutiveErrors = 5;
    updateStatus(2, null, null);
    expect(state._errorUntil).toBe(0);
    expect(state.consecutiveErrors).toBe(0);
    expect(document.querySelector('.status-dot').className).toBe('status-dot status-dot--live');
    expect(document.getElementById('status-text').textContent).toContain('Busse');
    expect(state._lastBusCount).toBe(2);
    expect(typeof state.lastUpdate).toBe('number');
  });

  it('transient error window active: records the count and returns without painting', () => {
    state._errorUntil = Date.now() + 5000;
    updateStatus(7, null, null);
    expect(state._lastBusCount).toBe(7);
    expect(document.querySelector('.status-dot').className).toBe('status-dot');
    expect(document.getElementById('status-text').textContent).toBe('');
    expect(state.lastUpdate).toBeNull();
  });

  it('expired transient window (truthy but in the past): proceeds to paint', () => {
    state._errorUntil = Date.now() - 1000;
    updateStatus(4, null, null);
    expect(document.querySelector('.status-dot').className).toBe('status-dot status-dot--live');
    expect(document.getElementById('status-text').textContent).toContain('Busse');
  });

  it('fresh data (dataAge < 2): adds the flash class and removes it after 600ms', () => {
    vi.useFakeTimers();
    updateStatus(3, 1, null);
    const dot = document.querySelector('.status-dot');
    expect(dot.classList.contains('status-dot--flash')).toBe(true);
    vi.advanceTimersByTime(600);
    expect(dot.classList.contains('status-dot--flash')).toBe(false);
  });

  it('dataAge null: no flash (dataAge != null branch false)', () => {
    updateStatus(3, null, null);
    expect(document.querySelector('.status-dot').classList.contains('status-dot--flash')).toBe(
      false,
    );
  });

  it('stale data (dataAge >= 2): no flash (dataAge < 2 branch false)', () => {
    updateStatus(3, 5, null);
    expect(document.querySelector('.status-dot').classList.contains('status-dot--flash')).toBe(
      false,
    );
  });

  it('passes the users argument through to the status text', () => {
    updateStatus(3, null, '2');
    expect(document.getElementById('status-text').textContent).toContain('2 Nutzer');
  });
});

describe('showError', () => {
  it('with a message: paints the error dot and the given text, arms the 5s window', () => {
    const before = Date.now();
    showError('Kaputt');
    expect(document.querySelector('.status-dot').className).toBe('status-dot status-dot--error');
    expect(document.getElementById('status-text').textContent).toBe('Kaputt');
    expect(state._errorUntil).toBeGreaterThan(before);
    expect(state._errorUntil).not.toBe(Infinity);
  });

  it('without a message: falls back to the connection_error translation', () => {
    showError('');
    expect(document.getElementById('status-text').textContent).toBe('Verbindungsfehler');
  });
});

describe('showPersistentError', () => {
  it('consecutiveErrors >= 3: red error dot and Infinity window', () => {
    state.consecutiveErrors = 3;
    showPersistentError('Server weg');
    expect(document.querySelector('.status-dot').className).toBe('status-dot status-dot--error');
    expect(document.getElementById('status-text').textContent).toBe('Server weg');
    expect(state._errorUntil).toBe(Infinity);
  });

  it('consecutiveErrors < 3: offline dot', () => {
    state.consecutiveErrors = 1;
    showPersistentError('Kurz weg');
    expect(document.querySelector('.status-dot').className).toBe('status-dot status-dot--offline');
    expect(state._errorUntil).toBe(Infinity);
  });
});

describe('clearPersistentError', () => {
  it('resets the error window and the consecutive-error counter', () => {
    state._errorUntil = Infinity;
    state.consecutiveErrors = 5;
    clearPersistentError();
    expect(state._errorUntil).toBe(0);
    expect(state.consecutiveErrors).toBe(0);
  });
});
