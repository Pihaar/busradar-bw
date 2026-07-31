/**
 * Tests for the ?debug=1 debug menu (static/debug.js).
 *
 * debug.js resolves the master flag and (when set) builds the menu at import
 * time, so localStorage + location.search are prepared BEFORE the dynamic
 * import in each test. Window handles from sibling modules (__gpsDebug,
 * busradarDownloadDump, …) are not created by debug.js's imports, so they are
 * mocked on window where a test drives them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function buildPanel() {
  document.body.innerHTML =
    '<div id="settings-panel">' +
    '  <div class="settings-group" id="grp-theme"></div>' +
    '  <div class="settings-group settings-group--reset"><button id="setting-reset"></button></div>' +
    '</div>';
}

function setLocation(search) {
  window.history.replaceState({}, '', '/' + (search || ''));
}

function toggleBtn(key) {
  return document.querySelector('#debug-options .settings-opt[data-tool="' + key + '"]');
}

function actionBtn(text) {
  return Array.prototype.slice
    .call(document.querySelectorAll('#debug-group .settings-opt'))
    .find((b) => b.textContent.indexOf(text) !== -1);
}

describe('debug menu (?debug)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    try {
      localStorage.clear();
    } catch (e) {}
    setLocation('');
    delete window.__busradarDebug;
    delete window.__busradarVerbose;
    delete window.__debugMenu;
    delete window.__gpsDebug;
    delete window.busradarDownloadDump;
    delete window.busradarCopyDump;
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('master flag', () => {
    it('?debug=1 enables and persists the master flag', async () => {
      setLocation('?debug=1');
      await import('../../static/debug.js');
      expect(window.__busradarDebug).toBe(true);
      expect(localStorage.getItem('busradar_debug')).toBe('1');
    });

    it('?debug=0 clears a previously persisted master flag', async () => {
      localStorage.setItem('busradar_debug', '1');
      setLocation('?debug=0');
      await import('../../static/debug.js');
      expect(window.__busradarDebug).toBe(false);
      expect(localStorage.getItem('busradar_debug')).toBeNull();
    });

    it('reads the persisted flag when no query is present', async () => {
      localStorage.setItem('busradar_debug', '1');
      setLocation('');
      await import('../../static/debug.js');
      expect(window.__busradarDebug).toBe(true);
    });

    it('stays off when neither query nor storage is set', async () => {
      await import('../../static/debug.js');
      expect(window.__busradarDebug).toBe(false);
      expect(document.getElementById('debug-group')).toBeNull();
    });
  });

  describe('tool-flag parsing', () => {
    it('defaults every tool off when the key is missing', async () => {
      const mod = await import('../../static/debug.js');
      expect(mod._loadTools()).toEqual({
        console: false,
        panlog: false,
        gps: false,
        verbose: false,
      });
    });

    it('falls back to all-off on malformed JSON instead of throwing', async () => {
      localStorage.setItem('busradar_debug_tools', '{ not valid json');
      const mod = await import('../../static/debug.js');
      expect(mod._loadTools()).toEqual({
        console: false,
        panlog: false,
        gps: false,
        verbose: false,
      });
    });

    it('ignores the literal string "null" (JSON.parse(null)-style)', async () => {
      localStorage.setItem('busradar_debug_tools', 'null');
      const mod = await import('../../static/debug.js');
      expect(mod._loadTools()).toEqual({
        console: false,
        panlog: false,
        gps: false,
        verbose: false,
      });
    });

    it('ignores non-boolean sub-values', async () => {
      localStorage.setItem('busradar_debug_tools', JSON.stringify({ console: 'yes', gps: true }));
      const mod = await import('../../static/debug.js');
      expect(mod._loadTools()).toEqual({
        console: false,
        panlog: false,
        gps: true,
        verbose: false,
      });
    });
  });

  describe('menu build', () => {
    it('inserts the 🐞 Debug group above the reset group', async () => {
      buildPanel();
      setLocation('?debug=1');
      await import('../../static/debug.js');
      const group = document.getElementById('debug-group');
      expect(group).not.toBeNull();
      expect(group.querySelector('.settings-label').textContent).toContain('Debug');
      expect(group.nextElementSibling.classList.contains('settings-group--reset')).toBe(true);
    });

    it('is idempotent — a second build adds no duplicate group', async () => {
      buildPanel();
      setLocation('?debug=1');
      const mod = await import('../../static/debug.js');
      mod._applyOnReady();
      expect(document.querySelectorAll('#debug-group').length).toBe(1);
    });

    it('appends to the panel when no reset group exists', async () => {
      document.body.innerHTML = '<div id="settings-panel"></div>';
      setLocation('?debug=1');
      await import('../../static/debug.js');
      expect(document.querySelector('#settings-panel #debug-group')).not.toBeNull();
    });

    it('does not build without a settings panel', async () => {
      setLocation('?debug=1');
      await import('../../static/debug.js');
      expect(document.getElementById('debug-group')).toBeNull();
    });
  });

  describe('tool toggles', () => {
    it('console toggle flips the flag and drives __debugConsole', async () => {
      buildPanel();
      setLocation('?debug=1');
      await import('../../static/debug.js');
      const show = vi.fn(),
        hide = vi.fn();
      window.__debugConsole = { show, hide, toggle: vi.fn(), isOpen: vi.fn() };
      const btn = toggleBtn('console');

      btn.click();
      expect(JSON.parse(localStorage.getItem('busradar_debug_tools')).console).toBe(true);
      expect(show).toHaveBeenCalledTimes(1);
      expect(btn.classList.contains('settings-opt--active')).toBe(true);

      btn.click();
      expect(JSON.parse(localStorage.getItem('busradar_debug_tools')).console).toBe(false);
      expect(hide).toHaveBeenCalledTimes(1);
      expect(btn.classList.contains('settings-opt--active')).toBe(false);
    });

    it('gps toggle drives __gpsDebug', async () => {
      buildPanel();
      setLocation('?debug=1');
      await import('../../static/debug.js');
      const show = vi.fn(),
        hide = vi.fn();
      window.__gpsDebug = { show, hide, toggle: vi.fn() };
      toggleBtn('gps').click();
      expect(show).toHaveBeenCalledTimes(1);
      toggleBtn('gps').click();
      expect(hide).toHaveBeenCalledTimes(1);
    });

    it('verbose toggle sets window.__busradarVerbose', async () => {
      buildPanel();
      setLocation('?debug=1');
      await import('../../static/debug.js');
      toggleBtn('verbose').click();
      expect(window.__busradarVerbose).toBe(true);
      toggleBtn('verbose').click();
      expect(window.__busradarVerbose).toBe(false);
    });

    it('pan-log toggle creates the overlay and a tracked interval, cleared on off', async () => {
      vi.useFakeTimers();
      buildPanel();
      setLocation('?debug=1');
      const clearSpy = vi.spyOn(global, 'clearInterval');
      await import('../../static/debug.js');
      toggleBtn('panlog').click();
      expect(document.getElementById('debug-panlog')).not.toBeNull();
      toggleBtn('panlog').click();
      expect(document.getElementById('debug-panlog')).toBeNull();
      expect(clearSpy).toHaveBeenCalled();
    });

    it('pan-log double-start does not create a second interval', async () => {
      vi.useFakeTimers();
      buildPanel();
      setLocation('?debug=1');
      const setSpy = vi.spyOn(global, 'setInterval');
      const mod = await import('../../static/debug.js');
      mod.setTool('panlog', true);
      mod.setTool('panlog', true); // idempotent
      expect(setSpy).toHaveBeenCalledTimes(1);
      mod.setTool('panlog', false);
    });

    it('setTool ignores unknown tool names', async () => {
      setLocation('?debug=1');
      const mod = await import('../../static/debug.js');
      expect(() => mod.setTool('nope', true)).not.toThrow();
      expect(localStorage.getItem('busradar_debug_tools')).toBeNull();
    });
  });

  describe('actions', () => {
    it('Dump ⬇ calls window.busradarDownloadDump', async () => {
      buildPanel();
      setLocation('?debug=1');
      await import('../../static/debug.js');
      window.busradarDownloadDump = vi.fn();
      actionBtn('Dump ⬇').click();
      expect(window.busradarDownloadDump).toHaveBeenCalledTimes(1);
    });

    it('Dump 📋 calls window.busradarCopyDump', async () => {
      buildPanel();
      setLocation('?debug=1');
      await import('../../static/debug.js');
      window.busradarCopyDump = vi.fn();
      actionBtn('Dump 📋').click();
      expect(window.busradarCopyDump).toHaveBeenCalledTimes(1);
    });

    it('Debug aus removes the group, clears the flag, and clears the pan-log interval', async () => {
      vi.useFakeTimers();
      buildPanel();
      setLocation('?debug=1');
      const clearSpy = vi.spyOn(global, 'clearInterval');
      const mod = await import('../../static/debug.js');
      mod.setTool('panlog', true); // start an interval to be torn down
      actionBtn('Debug aus').click();
      expect(document.getElementById('debug-group')).toBeNull();
      expect(localStorage.getItem('busradar_debug')).toBeNull();
      expect(window.__busradarDebug).toBe(false);
      expect(window.__debugMenu).toBeUndefined();
      expect(clearSpy).toHaveBeenCalled();
      expect(JSON.parse(localStorage.getItem('busradar_debug_tools'))).toEqual({
        console: false,
        panlog: false,
        gps: false,
        verbose: false,
      });
    });

    it('Debug aus hides console and gps tools that were active', async () => {
      buildPanel();
      setLocation('?debug=1');
      localStorage.setItem(
        'busradar_debug_tools',
        JSON.stringify({ console: true, gps: true, panlog: false, verbose: false }),
      );
      const mod = await import('../../static/debug.js');
      // Replace the handles AFTER import (debug.js's import installs the real
      // __debugConsole) so disableDebug drives our spies.
      const consoleHide = vi.fn(),
        gpsHide = vi.fn();
      window.__debugConsole = {
        show: vi.fn(),
        hide: consoleHide,
        toggle: vi.fn(),
        isOpen: vi.fn(),
      };
      window.__gpsDebug = { show: vi.fn(), hide: gpsHide, toggle: vi.fn() };
      mod.disableDebug();
      expect(consoleHide).toHaveBeenCalled();
      expect(gpsHide).toHaveBeenCalled();
    });
  });

  describe('persisted-state application on load', () => {
    it('drives active tools and reflects buttons at build time', async () => {
      buildPanel();
      setLocation('?debug=1');
      localStorage.setItem(
        'busradar_debug_tools',
        JSON.stringify({ console: true, panlog: false, gps: false, verbose: true }),
      );
      await import('../../static/debug.js');
      // console tool persisted true → the real overlay was shown; verbose set.
      expect(document.getElementById('debug-console')).not.toBeNull();
      expect(window.__busradarVerbose).toBe(true);
      expect(toggleBtn('console').classList.contains('settings-opt--active')).toBe(true);
      expect(toggleBtn('verbose').classList.contains('settings-opt--active')).toBe(true);
    });
  });

  describe('defensive / branch paths', () => {
    it('_resolveMaster returns false when localStorage throws', async () => {
      const mod = await import('../../static/debug.js');
      const spy = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      expect(mod._resolveMaster()).toBe(false);
      spy.mockRestore();
    });

    it('builds the menu on DOMContentLoaded when the document is not yet complete', async () => {
      buildPanel();
      setLocation('?debug=1');
      const orig = Object.getOwnPropertyDescriptor(Document.prototype, 'readyState');
      Object.defineProperty(document, 'readyState', {
        configurable: true,
        get: () => 'interactive',
      });
      await import('../../static/debug.js');
      expect(document.getElementById('debug-group')).toBeNull(); // deferred, not complete
      document.dispatchEvent(new Event('DOMContentLoaded'));
      expect(document.getElementById('debug-group')).not.toBeNull();
      if (orig) Object.defineProperty(document, 'readyState', orig);
      else delete document.readyState;
    });

    it('defers tool restore until DOMContentLoaded so late-set window handles are present', async () => {
      // Regression for the deferred-module ordering bug: at debug.js eval the
      // document is 'interactive' and window.__gpsDebug (from map.js) is not set
      // yet. Applying immediately would skip the GPS restore. The handle is set
      // after import (as map.js would), then DOMContentLoaded drives the restore.
      buildPanel();
      setLocation('?debug=1');
      localStorage.setItem(
        'busradar_debug_tools',
        JSON.stringify({ gps: true, console: false, panlog: false, verbose: false }),
      );
      const orig = Object.getOwnPropertyDescriptor(Document.prototype, 'readyState');
      Object.defineProperty(document, 'readyState', {
        configurable: true,
        get: () => 'interactive',
      });
      await import('../../static/debug.js');
      const show = vi.fn();
      window.__gpsDebug = { show, hide: vi.fn(), toggle: vi.fn() }; // set AFTER import, like map.js eval
      expect(show).not.toHaveBeenCalled(); // not applied yet — deferred
      document.dispatchEvent(new Event('DOMContentLoaded'));
      expect(show).toHaveBeenCalled(); // restored with the handle now present
      if (orig) Object.defineProperty(document, 'readyState', orig);
      else delete document.readyState;
    });

    it('pan-log overlay renders formatted follow-log entries', async () => {
      vi.useFakeTimers();
      setLocation('?debug=1');
      const mod = await import('../../static/debug.js');
      const { state } = await import('../../static/state.js');
      state._followLog = [
        { t: 0, action: 'panTo', dist: 800, reason: null },
        { t: 0, action: 'skip', dist: null, reason: 'panning' },
        { t: 0, action: 'skip', dist: null, reason: null },
      ];
      mod.setTool('panlog', true);
      const el = document.getElementById('debug-panlog');
      expect(el.textContent).toContain('panTo');
      expect(el.textContent).toContain('d=800');
      expect(el.textContent).toContain('skip');
      expect(el.textContent).toContain('panning');
      mod.setTool('panlog', false);
    });

    it('driving console/gps tools is a no-op when the window handles are absent', async () => {
      setLocation('?debug=1');
      const mod = await import('../../static/debug.js');
      delete window.__debugConsole;
      delete window.__gpsDebug;
      expect(() => {
        mod.setTool('console', true);
        mod.setTool('gps', true);
      }).not.toThrow();
    });

    it('_applyOnReady is a no-op when debug is off', async () => {
      const mod = await import('../../static/debug.js'); // master off (no query/storage)
      buildPanel();
      mod._applyOnReady();
      expect(document.getElementById('debug-group')).toBeNull();
      expect(window.__debugMenu).toBeUndefined();
    });

    it('pan-log interval re-renders on each tick', async () => {
      vi.useFakeTimers();
      setLocation('?debug=1');
      const mod = await import('../../static/debug.js');
      const { state } = await import('../../static/state.js');
      state._followLog = [];
      mod.setTool('panlog', true);
      const el = document.getElementById('debug-panlog');
      expect(el.textContent).toContain('pan-log (0)');
      state._followLog = [{ t: 0, action: 'panTo', dist: 5, reason: null }];
      vi.advanceTimersByTime(1000);
      expect(el.textContent).toContain('pan-log (1)');
      mod.setTool('panlog', false);
    });
  });
});
