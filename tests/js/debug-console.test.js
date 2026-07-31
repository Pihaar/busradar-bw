/**
 * Tests for the on-screen mobile debug console (static/debug-console.js).
 *
 * The overlay is now controlled via window.__debugConsole.show()/hide()/
 * toggle()/isOpen() (the ?debug menu decides when to auto-show it) instead of
 * the old ?console / localStorage flag. The ring buffer + console patch install
 * at import time and are always on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The debug-console IIFE wraps console.log/info/warn/error/debug at import
// time and never unwraps. Each test does vi.resetModules() + re-imports, so
// without restoring the console the wrappers STACK across tests: by the
// ring-buffer test a single console.log fans out through ~20 nested wrappers
// (~20x the record() work), which under parallel load blew past the 5s test
// timeout non-deterministically. Snapshot the pristine methods once (before
// any import wraps them) and restore them after every test so each import
// wraps exactly once — the suite is then order- and load-independent.
const PRISTINE_CONSOLE = {};
['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
  PRISTINE_CONSOLE[level] = console[level];
});

describe('debug-console overlay', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    try {
      localStorage.clear();
    } catch (e) {}
    delete window.__debugMenu;
    vi.resetModules(); // re-run the IIFE per test (fresh handles)
  });

  afterEach(() => {
    // Unwrap the console so the next test's import starts from a clean patch.
    ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
      console[level] = PRISTINE_CONSOLE[level];
    });
  });

  it('does not show the overlay until show() is called', async () => {
    await import('../../static/debug-console.js');
    console.log('should-not-appear');
    expect(document.getElementById('debug-console')).toBeNull();
    expect(window.__debugConsole.isOpen()).toBe(false);
  });

  it('captures into the always-on ring buffer even without the overlay', async () => {
    await import('../../static/debug-console.js');
    console.log('ring-only', 'line');
    expect(document.getElementById('debug-console')).toBeNull();
    const tail = window.__busradarConsoleTail.join('\n');
    expect(tail).toContain('ring-only line');
  });

  it('captures console.log into the overlay after show()', async () => {
    await import('../../static/debug-console.js');
    window.__debugConsole.show();
    console.log('hello', 'world');
    const box = document.getElementById('debug-console');
    expect(box).not.toBeNull();
    expect(window.__debugConsole.isOpen()).toBe(true);
    expect(box.textContent).toContain('hello world');
  });

  it('formats Error/DOMException-like objects as name: message', async () => {
    await import('../../static/debug-console.js');
    window.__debugConsole.show();
    console.warn('SW failed:', { name: 'SecurityError', message: 'The operation is insecure.' });
    const box = document.getElementById('debug-console');
    expect(box.textContent).toContain('SecurityError: The operation is insecure.');
  });

  it('toggle() opens then closes the overlay', async () => {
    await import('../../static/debug-console.js');
    window.__debugConsole.toggle();
    expect(document.getElementById('debug-console')).not.toBeNull();
    window.__debugConsole.toggle();
    expect(document.getElementById('debug-console')).toBeNull();
    expect(window.__debugConsole.isOpen()).toBe(false);
  });

  it('Close removes the overlay when no debug menu is present', async () => {
    await import('../../static/debug-console.js');
    window.__debugConsole.show();
    console.log('x');
    const box = document.getElementById('debug-console');
    const closeBtn = Array.prototype.slice
      .call(box.querySelectorAll('button'))
      .find((b) => b.textContent.indexOf('Close') !== -1);
    expect(closeBtn).toBeTruthy();
    closeBtn.click();
    expect(document.getElementById('debug-console')).toBeNull();
    expect(window.__debugConsole.isOpen()).toBe(false);
  });

  it('Close routes through the debug menu when present', async () => {
    await import('../../static/debug-console.js');
    const setTool = vi.fn();
    window.__debugMenu = { setTool };
    window.__debugConsole.show();
    const box = document.getElementById('debug-console');
    const closeBtn = Array.prototype.slice
      .call(box.querySelectorAll('button'))
      .find((b) => b.textContent.indexOf('Close') !== -1);
    closeBtn.click();
    expect(setTool).toHaveBeenCalledWith('console', false);
  });

  it('Clear empties the log but keeps the overlay', async () => {
    await import('../../static/debug-console.js');
    window.__debugConsole.show();
    console.log('line-one');
    const box = document.getElementById('debug-console');
    const clearBtn = Array.prototype.slice
      .call(box.querySelectorAll('button'))
      .find((b) => b.textContent.indexOf('Clear') !== -1);
    clearBtn.click();
    expect(document.getElementById('debug-console')).not.toBeNull();
    expect(box.textContent).not.toContain('line-one');
  });

  it('Clear leaves the always-on ring buffer intact (dump still complete)', async () => {
    await import('../../static/debug-console.js');
    window.__debugConsole.show();
    console.log('survives-clear');
    const box = document.getElementById('debug-console');
    Array.prototype.slice
      .call(box.querySelectorAll('button'))
      .find((b) => b.textContent.indexOf('Clear') !== -1)
      .click();
    // UI cleared, but the ring (what the dump reads) keeps the line.
    expect(window.__busradarConsoleTail.join('\n')).toContain('survives-clear');
  });

  it('ring buffer is bounded at 10000 entries', async () => {
    await import('../../static/debug-console.js');
    for (let i = 0; i < 10001; i++) console.log('r' + i);
    expect(window.__busradarConsoleTail.length).toBe(10000);
    expect(window.__busradarConsoleTail[window.__busradarConsoleTail.length - 1]).toContain(
      'r10000',
    );
  });

  it('no longer renders a Dump button in the overlay', async () => {
    await import('../../static/debug-console.js');
    window.__debugConsole.show();
    const box = document.getElementById('debug-console');
    const dumpBtn = Array.prototype.slice
      .call(box.querySelectorAll('button'))
      .find((b) => b.textContent.indexOf('Dump') !== -1);
    expect(dumpBtn).toBeUndefined();
  });

  it('captures uncaught errors into the overlay', async () => {
    await import('../../static/debug-console.js');
    window.__debugConsole.show();
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom', filename: 'x.js', lineno: 7 }));
    const box = document.getElementById('debug-console');
    expect(box.textContent).toContain('boom @ x.js:7');
  });

  it('captures unhandled rejections into the overlay', async () => {
    await import('../../static/debug-console.js');
    window.__debugConsole.show();
    const ev = new Event('unhandledrejection');
    ev.reason = new Error('nope');
    window.dispatchEvent(ev);
    const box = document.getElementById('debug-console');
    expect(box.textContent).toContain('unhandledrejection: Error: nope');
  });

  it('formats a plain object without name/message via JSON.stringify', async () => {
    await import('../../static/debug-console.js');
    window.__debugConsole.show();
    console.log({ vehicles: 3 });
    const box = document.getElementById('debug-console');
    expect(box.textContent).toContain('{"vehicles":3}');
    expect(window.__busradarConsoleTail.join('\n')).toContain('{"vehicles":3}');
  });

  it('falls back to String(a) when JSON.stringify throws on a circular object', async () => {
    await import('../../static/debug-console.js');
    window.__debugConsole.show();
    const circular = {};
    circular.self = circular; // JSON.stringify throws on this
    expect(() => console.log(circular)).not.toThrow();
    const box = document.getElementById('debug-console');
    // String({}) → "[object Object]"; the point is it did not throw and was recorded.
    expect(box.textContent).toContain('[object Object]');
  });

  it('formats null cleanly as "null" (not a name/message crash)', async () => {
    await import('../../static/debug-console.js');
    window.__debugConsole.show();
    expect(() => console.log(null)).not.toThrow();
    const box = document.getElementById('debug-console');
    expect(box.textContent).toContain('null');
  });

  it('console.debug is captured at level "log", not "debug"', async () => {
    await import('../../static/debug-console.js');
    window.__debugConsole.show();
    console.debug('debug-line');
    const box = document.getElementById('debug-console');
    expect(box.textContent).toContain('[log] debug-line');
    expect(box.textContent).not.toContain('[debug]');
    expect(window.__busradarConsoleTail.join('\n')).toContain('[log] debug-line');
  });

  it('Clear is a no-op after the overlay is hidden (logEl already null)', async () => {
    // b1[1]: the `if (logEl)` false-arm. Grab the Clear button ref while the
    // overlay is open, hide() (which nulls logEl and detaches the box), then
    // click the still-referenced button — the listener runs but logEl is null.
    await import('../../static/debug-console.js');
    window.__debugConsole.show();
    const box = document.getElementById('debug-console');
    const clearBtn = Array.prototype.slice
      .call(box.querySelectorAll('button'))
      .find((b) => b.textContent.indexOf('Clear') !== -1);
    window.__debugConsole.hide();
    expect(() => clearBtn.click()).not.toThrow();
    expect(window.__debugConsole.isOpen()).toBe(false);
  });

  it('builds the overlay under documentElement when document.body is absent', async () => {
    // b4[1]: the `document.documentElement` fallback in ensureUI. show() with
    // no body defers to DOMContentLoaded (box stays null); a subsequent log
    // then runs record() → ensureUI() while body is still null, so the box is
    // appended to documentElement.
    await import('../../static/debug-console.js');
    const body = document.body;
    document.documentElement.removeChild(body);
    try {
      window.__debugConsole.show();
      console.log('early-line');
      const box = document.getElementById('debug-console');
      expect(box).not.toBeNull();
      expect(box.parentNode).toBe(document.documentElement);
      expect(box.textContent).toContain('early-line');
    } finally {
      // Re-attach body; the box (child of documentElement) rides along on cleanup.
      window.__debugConsole.hide();
      document.documentElement.appendChild(body);
    }
  });

  it('defers the overlay build to DOMContentLoaded when shown before body exists', async () => {
    // show() else-arm (@L84 false): no document.body at call time, so the DOM
    // build is deferred via a once DOMContentLoaded listener instead of running
    // ensureUI now. Re-attaching the body and dispatching DOMContentLoaded then
    // runs the deferred callback, which builds the overlay because OVERLAY is
    // still true. Covers both the else branch and its listener callback.
    await import('../../static/debug-console.js');
    const body = document.body;
    document.documentElement.removeChild(body);
    try {
      window.__debugConsole.show();
      // No box yet — the build was deferred (no body, no log to trigger record).
      expect(document.getElementById('debug-console')).toBeNull();
      document.documentElement.appendChild(body);
      document.dispatchEvent(new Event('DOMContentLoaded'));
      // The deferred callback ran and built the overlay under the now-present body.
      expect(document.getElementById('debug-console')).not.toBeNull();
    } finally {
      window.__debugConsole.hide();
      if (!document.body) document.documentElement.appendChild(body);
    }
  });

  it('the deferred build is skipped when the overlay was hidden before DOMContentLoaded', async () => {
    // show() else-arm listener callback with OVERLAY false: shown pre-body,
    // then hidden before the DOM is ready. The `if (OVERLAY) ensureUI()` guard
    // must NOT build the overlay. Covers the callback's false-arm.
    await import('../../static/debug-console.js');
    const body = document.body;
    document.documentElement.removeChild(body);
    try {
      window.__debugConsole.show();
      window.__debugConsole.hide(); // OVERLAY back to false before the DOM is ready
      document.documentElement.appendChild(body);
      document.dispatchEvent(new Event('DOMContentLoaded'));
      expect(document.getElementById('debug-console')).toBeNull();
    } finally {
      if (!document.body) document.documentElement.appendChild(body);
    }
  });

  it('uses a no-op fallback when a console level is missing at import time', async () => {
    // b16[1]: `console[level] ? console[level].bind(console) : function () {}`.
    // Force console.debug falsy BEFORE importing (an own undefined shadows the
    // prototype method) so the patch installs the no-op fallback for that
    // level; calling it must not throw and must still record at level 'log'.
    const origDebug = console.debug;
    console.debug = undefined;
    try {
      await import('../../static/debug-console.js');
      window.__debugConsole.show();
      expect(() => console.debug('via-fallback')).not.toThrow();
      // Recorded at level 'log' (debug maps to log) even without an original fn.
      expect(window.__busradarConsoleTail.join('\n')).toContain('[log] via-fallback');
    } finally {
      console.debug = origDebug;
    }
  });

  it('captures an error event with no filename/lineno (empty-string fallbacks)', async () => {
    // b19[2] + b20[2]: the `|| ''` fallbacks for filename and lineno when the
    // ErrorEvent carries neither.
    await import('../../static/debug-console.js');
    window.__debugConsole.show();
    window.dispatchEvent(new ErrorEvent('error', { message: 'bare' }));
    const box = document.getElementById('debug-console');
    expect(box.textContent).toContain('bare @ :');
  });

  it('caps the on-screen overlay log at 300 line elements (bounded DOM)', async () => {
    await import('../../static/debug-console.js');
    window.__debugConsole.show();
    for (let i = 0; i < 320; i++) console.log('capline' + i);
    const box = document.getElementById('debug-console');
    const lineDivs = Array.prototype.slice
      .call(box.querySelectorAll('div'))
      // leaf line divs only — exclude the log container, which also matches
      .filter((d) => d.children.length === 0 && d.textContent.indexOf('capline') !== -1);
    // 320 logged, oldest 20 dropped by the while-loop cap → exactly 300 remain
    expect(lineDivs.length).toBe(300);
    expect(box.textContent).not.toContain('capline0 '); // oldest evicted
    expect(box.textContent).toContain('capline319'); // newest kept
  });
});
