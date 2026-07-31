/**
 * Tests for the on-screen mobile debug console (static/debug-console.js).
 *
 * The overlay is now controlled via window.__debugConsole.show()/hide()/
 * toggle()/isOpen() (the ?debug menu decides when to auto-show it) instead of
 * the old ?console / localStorage flag. The ring buffer + console patch install
 * at import time and are always on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('debug-console overlay', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    try {
      localStorage.clear();
    } catch (e) {}
    delete window.__debugMenu;
    vi.resetModules(); // re-run the IIFE per test (fresh handles)
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

  it('ring buffer is bounded at 2000 entries', async () => {
    await import('../../static/debug-console.js');
    for (let i = 0; i < 2001; i++) console.log('r' + i);
    expect(window.__busradarConsoleTail.length).toBe(2000);
    expect(window.__busradarConsoleTail[window.__busradarConsoleTail.length - 1]).toContain(
      'r2000',
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
});
