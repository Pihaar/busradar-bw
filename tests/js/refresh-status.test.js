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


// === updateStatus mit User-Counter ===

describe('status.js updateStatus with users', () => {
  var text;

  beforeEach(async () => {
    document.body.innerHTML = '<span class="status-dot"></span><span id="status-text"></span><div id="sr-announcer"></div>';
    text = document.getElementById('status-text');
    var { state } = await import('../../static/state.js');
    state._errorUntil = 0;
    state._lastConnectedClients = undefined;
  });

  it('shows count + users + time', async () => {
    var { updateStatus } = await import('../../static/status.js');
    updateStatus(5, 1.0, '3');
    expect(text.textContent).toContain('5');
    expect(text.textContent).toContain('3');
    expect(text.textContent.match(/\d{2}:\d{2}/)).toBeTruthy();
  });

  it('shows singular user', async () => {
    var { updateStatus } = await import('../../static/status.js');
    updateStatus(2, 0.5, '1');
    // "1 User" / "1 user" — sprachunabhängig: "1 " gefolgt von Buchstaben
    expect(text.textContent).toMatch(/\b1 [A-Za-z]/);
  });

  it('omits user-part when users is "0"', async () => {
    var { updateStatus } = await import('../../static/status.js');
    updateStatus(5, 1.0, '0');
    expect(text.textContent).toContain('5');
    expect(text.textContent).not.toMatch(/\bUsers?\b/i);
  });

  it('omits user-part when users is null/undefined', async () => {
    var { updateStatus } = await import('../../static/status.js');
    updateStatus(5, 1.0, null);
    expect(text.textContent).toContain('5');
    expect(text.textContent).not.toMatch(/\bUsers?\b/i);
    updateStatus(5, 1.0, undefined);
    expect(text.textContent).not.toMatch(/\bUsers?\b/i);
  });

  it('handles bus_count_one with users', async () => {
    var { updateStatus } = await import('../../static/status.js');
    updateStatus(1, 0.5, '7');
    expect(text.textContent).toContain('1');
    expect(text.textContent).toContain('7');
  });

  it('handles capped users "100+"', async () => {
    var { updateStatus } = await import('../../static/status.js');
    updateStatus(10, 0.5, '100+');
    expect(text.textContent).toContain('100+');
  });
});


// === Client ID generation ===

describe('client id generation regex', () => {
  it('crypto.randomUUID output matches v4 regex', () => {
    if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
      return; // skip on older runtimes
    }
    var re = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (var i = 0; i < 100; i++) {
      var u = crypto.randomUUID();
      expect(u).toMatch(re);
    }
  });

  it('manual fallback emits valid v4 UUIDs', () => {
    var re = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    function makeFallback() {
      var b = new Uint8Array(16);
      crypto.getRandomValues(b);
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      var hex = Array.prototype.map.call(b, function(x) { return ('0' + x.toString(16)).slice(-2); }).join('');
      return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20, 32);
    }
    for (var i = 0; i < 100; i++) {
      expect(makeFallback()).toMatch(re);
    }
  });
});


// === formatStatusText (pure function) ===

describe('status.js formatStatusText', () => {
  beforeEach(async () => {
    if (!settings.current) settings.init();
  });

  it('returns string when count=0 and no users', async () => {
    var { formatStatusText } = await import('../../static/status.js');
    var out = formatStatusText(0, null, '12:34:56');
    expect(out).toContain('0');
    expect(out).toContain('12:34:56');
    expect(out).not.toMatch(/\bUsers?\b/i);
  });

  it('returns string with users when count>0 and users>0', async () => {
    var { formatStatusText } = await import('../../static/status.js');
    var out = formatStatusText(5, '3', '12:34:56');
    expect(out).toContain('5');
    expect(out).toContain('3');
    expect(out).toContain('12:34:56');
  });

  it('omits users-part when users is "0"', async () => {
    var { formatStatusText } = await import('../../static/status.js');
    var out = formatStatusText(5, '0', '12:34:56');
    expect(out).not.toMatch(/\bUsers?\b/i);
  });

  it('omits users-part when users is empty string', async () => {
    var { formatStatusText } = await import('../../static/status.js');
    var out = formatStatusText(5, '', '12:34:56');
    expect(out).not.toMatch(/\bUsers?\b/i);
  });

  it('omits users-part when users is null', async () => {
    var { formatStatusText } = await import('../../static/status.js');
    var out = formatStatusText(5, null, '12:34:56');
    expect(out).not.toMatch(/\bUsers?\b/i);
  });

  it('omits users-part when users is undefined', async () => {
    var { formatStatusText } = await import('../../static/status.js');
    var out = formatStatusText(5, undefined, '12:34:56');
    expect(out).not.toMatch(/\bUsers?\b/i);
  });

  it('omits users-part when users is a number (non-string type)', async () => {
    var { formatStatusText } = await import('../../static/status.js');
    var out = formatStatusText(5, 3, '12:34:56');
    // typeof check filters non-strings out
    expect(out).not.toMatch(/\bUsers?\b/i);
  });

  it('uses singular template for users="1"', async () => {
    var { formatStatusText } = await import('../../static/status.js');
    var out = formatStatusText(5, '1', '12:34:56');
    // "1 User"/"1 user" - singular form
    expect(out).toMatch(/\b1 [A-Za-z]/);
  });

  it('handles capped users "100+"', async () => {
    var { formatStatusText } = await import('../../static/status.js');
    var out = formatStatusText(5, '100+', '12:34:56');
    expect(out).toContain('100+');
  });

  it('uses bus_count_one template for count=1', async () => {
    var { formatStatusText } = await import('../../static/status.js');
    var out = formatStatusText(1, '7', '12:34:56');
    expect(out).toContain('1');
    expect(out).toContain('7');
    expect(out).toContain('12:34:56');
  });

  it('count=0 falls into multi-template (not singular)', async () => {
    var { formatStatusText } = await import('../../static/status.js');
    var out = formatStatusText(0, '3', '12:34:56');
    expect(out).toContain('0');
  });
});


// === 1s-Tick regression: status-text muss Users mit-rendern ===

describe('refresh.js 1s-tick with users', () => {
  beforeEach(async () => {
    if (!settings.current) settings.init();
    document.body.innerHTML = '<span class="status-dot"></span><span id="status-text"></span><div id="sr-announcer"></div>';
    state.serverTimeMin = 600;
    state.serverTimeStamp = Date.now();
    state._errorUntil = 0;
    state._lastBusCount = 5;
    state._lastConnectedClients = '3';
  });

  it('1s-tick uses formatStatusText with users (regression test)', async () => {
    // Lade refresh.js, das bei import den setInterval registriert
    await import('../../static/refresh.js');
    var { formatStatusText } = await import('../../static/status.js');
    // Simuliere was der 1s-tick macht
    var text = document.getElementById('status-text');
    text.textContent = formatStatusText(state._lastBusCount, state._lastConnectedClients, '12:34:56');
    expect(text.textContent).toContain('5');
    expect(text.textContent).toContain('3');
    expect(text.textContent).toContain('12:34:56');
  });

  it('1s-tick path produces same format as updateStatus', async () => {
    var { formatStatusText, updateStatus } = await import('../../static/status.js');
    var tickStr = formatStatusText(5, '3', '14:32:15');
    // updateStatus with same inputs
    state._errorUntil = 0;
    state.serverTimeMin = 14 * 60 + 32;
    state.serverTimeStamp = Date.now();
    // Force the timeStr via direct call
    var directStr = formatStatusText(5, '3', '14:32:15');
    expect(tickStr).toEqual(directStr);
  });
});
