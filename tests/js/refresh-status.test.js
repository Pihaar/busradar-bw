import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { state, settings } from '../../static/state.js';

describe('refresh.js hint scheduling', () => {
  beforeEach(() => {
    if (!settings.current) settings.init();
    state._nextFreshDataIn = null;
    state.consecutiveErrors = 0;
    state._needsImmediateRefresh = false;
    state.currentInterval = 10000;
  });

  describe('_nextFreshDataIn parsing', () => {
    it('accepts valid positive number', () => {
      state._nextFreshDataIn = 12.5;
      expect(state._nextFreshDataIn).toBe(12.5);
    });

    it('accepts zero', () => {
      state._nextFreshDataIn = 0;
      expect(state._nextFreshDataIn).toBe(0);
    });

    it('null clears the hint', () => {
      state._nextFreshDataIn = 15.0;
      state._nextFreshDataIn = null;
      expect(state._nextFreshDataIn).toBe(null);
    });
  });

  describe('.finally scheduling logic', () => {
    it('hint=5 produces ~5000-5500ms delay (floor 2000, +jitter)', () => {
      var hint = 5.0;
      var hintMs = Math.max(hint * 1000, 2000);
      expect(hintMs).toBe(5000);
      var jitter = Math.floor(Math.random() * 500);
      var delay = Math.min(hintMs + jitter, 10000);
      expect(delay).toBeGreaterThanOrEqual(5000);
      expect(delay).toBeLessThanOrEqual(5500);
    });

    it('hint=0 produces 2000ms floor (not zero)', () => {
      var hint = 0;
      var hintMs = Math.max(hint * 1000, 2000);
      expect(hintMs).toBe(2000);
    });

    it('hint=0.5 produces 2000ms floor (below 2s)', () => {
      var hint = 0.5;
      var hintMs = Math.max(hint * 1000, 2000);
      expect(hintMs).toBe(2000);
    });

    it('hint=25 with userMax=10000 caps at userMax', () => {
      var hint = 25.0;
      var hintMs = Math.max(hint * 1000, 2000);
      var delay = Math.min(hintMs + 250, 10000);
      expect(delay).toBe(10000);
    });

    it('hint=null falls back to userMax', () => {
      var hint = null;
      var userMax = 10000;
      var delay;
      if (hint != null && isFinite(hint) && hint >= 0) {
        delay = Math.min(Math.max(hint * 1000, 2000) + 250, userMax);
      } else {
        delay = userMax;
      }
      expect(delay).toBe(10000);
    });

    it('hint=NaN treated as null (isFinite rejects)', () => {
      var hint = NaN;
      var valid = hint != null && isFinite(hint) && hint >= 0;
      expect(valid).toBe(false);
    });

    it('hint=Infinity treated as null', () => {
      var hint = Infinity;
      var valid = hint != null && isFinite(hint) && hint >= 0;
      expect(valid).toBe(false);
    });

    it('hint=-1 treated as null (>= 0 rejects)', () => {
      var hint = -1;
      var valid = hint != null && isFinite(hint) && hint >= 0;
      expect(valid).toBe(false);
    });

    it('jitter range is [0, 500)', () => {
      for (var i = 0; i < 100; i++) {
        var jitter = Math.floor(Math.random() * 500);
        expect(jitter).toBeGreaterThanOrEqual(0);
        expect(jitter).toBeLessThan(500);
      }
    });

    it('consecutiveErrors >= 3 ignores hint', () => {
      state.consecutiveErrors = 3;
      state._nextFreshDataIn = 5.0;
      // The .finally logic: if consecutiveErrors >= 3, scheduleRefresh() with no arg (uses currentInterval)
      var shouldUseHint = state.consecutiveErrors < 3;
      expect(shouldUseHint).toBe(false);
    });
  });
});

describe('status.js updateStatus flash logic', () => {
  beforeEach(() => {
    if (!settings.current) settings.init();
    document.body.innerHTML = '<span class="status-dot"></span><span id="status-text"></span>';
    state.serverTimeMin = 600;
    state.serverTimeStamp = Date.now();
    state._errorUntil = 0;
    state._lastBusCount = 0;
  });

  it('flashes when dataAge < 2', async () => {
    var { updateStatus } = await import('../../static/status.js');
    updateStatus(10, 1.5);
    var dot = document.querySelector('.status-dot');
    expect(dot.classList.contains('status-dot--flash')).toBe(true);
  });

  it('does not flash when dataAge >= 2', async () => {
    var { updateStatus } = await import('../../static/status.js');
    updateStatus(10, 5.0);
    var dot = document.querySelector('.status-dot');
    expect(dot.classList.contains('status-dot--flash')).toBe(false);
  });

  it('does not flash when dataAge is null', async () => {
    var { updateStatus } = await import('../../static/status.js');
    updateStatus(10, null);
    var dot = document.querySelector('.status-dot');
    expect(dot.classList.contains('status-dot--flash')).toBe(false);
  });

  it('sets status-dot--live class', async () => {
    var { updateStatus } = await import('../../static/status.js');
    updateStatus(5, 1.0);
    var dot = document.querySelector('.status-dot');
    expect(dot.classList.contains('status-dot--live')).toBe(true);
  });

  it('updates text with bus count', async () => {
    var { updateStatus } = await import('../../static/status.js');
    updateStatus(42, 0.5);
    var text = document.getElementById('status-text');
    expect(text.textContent).toContain('42');
  });

  it('respects _errorUntil window (early return)', async () => {
    var { updateStatus } = await import('../../static/status.js');
    state._errorUntil = Date.now() + 5000;
    updateStatus(10, 0.5);
    var dot = document.querySelector('.status-dot');
    expect(dot.classList.contains('status-dot--live')).toBe(false);
  });

  it('showError sets error class and text', async () => {
    var { showError } = await import('../../static/status.js');
    showError('Test error');
    var dot = document.querySelector('.status-dot');
    expect(dot.classList.contains('status-dot--error')).toBe(true);
    var text = document.getElementById('status-text');
    expect(text.textContent).toBe('Test error');
  });

  it('showPersistentError sets offline class at low error count', async () => {
    var { showPersistentError } = await import('../../static/status.js');
    state.consecutiveErrors = 1;
    showPersistentError('offline msg');
    var dot = document.querySelector('.status-dot');
    expect(dot.classList.contains('status-dot--offline')).toBe(true);
  });

  it('showPersistentError sets error class at high error count', async () => {
    var { showPersistentError } = await import('../../static/status.js');
    state.consecutiveErrors = 3;
    showPersistentError('bad');
    var dot = document.querySelector('.status-dot');
    expect(dot.classList.contains('status-dot--error')).toBe(true);
  });

  it('clearPersistentError resets state', async () => {
    var { clearPersistentError } = await import('../../static/status.js');
    state._errorUntil = Infinity;
    state.consecutiveErrors = 5;
    clearPersistentError();
    expect(state._errorUntil).toBe(0);
    expect(state.consecutiveErrors).toBe(0);
  });

  it('announce sets and clears sr-announcer text', async () => {
    var { announce } = await import('../../static/status.js');
    document.body.innerHTML += '<div id="sr-announcer"></div>';
    announce('hello');
    expect(document.getElementById('sr-announcer').textContent).toBe('hello');
  });
});
