/**
 * Tests for the on-screen mobile debug console (static/debug-console.js).
 *
 * The module is an IIFE that reads its enable-flag at import time, so the
 * localStorage flag is set BEFORE the dynamic import in each test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('debug-console overlay', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    try { localStorage.clear(); } catch (e) {}
    vi.resetModules();  // re-run the IIFE per test (fresh flag read)
  });

  it('does nothing when the flag is absent', async () => {
    await import('../../static/debug-console.js');
    console.log('should-not-appear');
    expect(document.getElementById('debug-console')).toBeNull();
  });

  it('captures console.log into the overlay when enabled via localStorage', async () => {
    localStorage.setItem('busradar_console', '1');
    await import('../../static/debug-console.js');
    console.log('hello', 'world');
    const box = document.getElementById('debug-console');
    expect(box).not.toBeNull();
    expect(box.textContent).toContain('hello world');
  });

  it('formats Error/DOMException-like objects as name: message', async () => {
    localStorage.setItem('busradar_console', '1');
    await import('../../static/debug-console.js');
    console.warn('SW failed:', { name: 'SecurityError', message: 'The operation is insecure.' });
    const box = document.getElementById('debug-console');
    expect(box.textContent).toContain('SecurityError: The operation is insecure.');
  });

  it('Close removes the overlay and clears the persisted flag', async () => {
    localStorage.setItem('busradar_console', '1');
    await import('../../static/debug-console.js');
    console.log('x');
    const box = document.getElementById('debug-console');
    const closeBtn = Array.prototype.slice.call(box.querySelectorAll('button'))
      .find(b => b.textContent.indexOf('Close') !== -1);
    expect(closeBtn).toBeTruthy();
    closeBtn.click();
    expect(document.getElementById('debug-console')).toBeNull();
    expect(localStorage.getItem('busradar_console')).toBeNull();
  });

  it('Clear empties the log but keeps the overlay', async () => {
    localStorage.setItem('busradar_console', '1');
    await import('../../static/debug-console.js');
    console.log('line-one');
    const box = document.getElementById('debug-console');
    const clearBtn = Array.prototype.slice.call(box.querySelectorAll('button'))
      .find(b => b.textContent.indexOf('Clear') !== -1);
    clearBtn.click();
    expect(document.getElementById('debug-console')).not.toBeNull();
    expect(box.textContent).not.toContain('line-one');
  });
});
