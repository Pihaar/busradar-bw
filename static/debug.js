// ?debug=1 debug menu — one entry point for the scattered debug tools.
//
// Appends a "🐞 Debug" group to the ⚙ settings panel when the master flag
// busradar_debug is set (via ?debug=1, persisted in localStorage; ?debug=0 or
// the "Debug aus" button clears it). Each tool is a toggle button; the toggle
// state persists in localStorage['busradar_debug_tools'] as a JSON object
// {console,panlog,gps,verbose}. Replaces the old per-tool ?console / ?gpsdebug
// URL flags.
//
// This module's ONLY static import is debug-console.js, so the console patch +
// ring buffer install before anything else logs. state.js is imported for the
// follow-log (no cycle: state.js -> config.js only; the debug-console.js import
// is listed first so the patch still installs before state.js evaluates).
// Everything else (dump, GPS pill, verbose flag) is reached through window
// handles, which stay callable from the console / Playwright INDEPENDENT of
// ?debug — the menu is only the human UI layer on top of those handles.
import './debug-console.js';
import { state } from './state.js';

var TOGGLES = [
  { key: 'console', label: 'Konsole' },
  { key: 'panlog', label: 'Pan-Log' },
  { key: 'gps', label: 'GPS-Status' },
  { key: 'verbose', label: 'Verbose-Log' },
];

// Current tool toggle state; loaded defensively from localStorage.
var _tools = _loadTools();

function _loadTools() {
  var out = { console: false, panlog: false, gps: false, verbose: false };
  try {
    var raw = localStorage.getItem('busradar_debug_tools');
    if (!raw) return out; // missing / empty
    var parsed = JSON.parse(raw); // "null" / malformed handled below + by catch
    if (parsed && typeof parsed === 'object') {
      Object.keys(out).forEach(function (k) {
        if (typeof parsed[k] === 'boolean') out[k] = parsed[k];
      });
    }
  } catch (e) {}
  return out;
}

function _saveTools() {
  try {
    localStorage.setItem('busradar_debug_tools', JSON.stringify(_tools));
  } catch (e) {}
}

// Resolve the master flag: ?debug=1 sets + persists, ?debug=0 clears, otherwise
// read the persisted value. Pattern mirrors the old debug-console.js flag read.
function _resolveMaster() {
  try {
    var q = new URLSearchParams(location.search).get('debug');
    if (q === '1') {
      try {
        localStorage.setItem('busradar_debug', '1');
      } catch (e) {}
      return true;
    }
    if (q === '0') {
      try {
        localStorage.removeItem('busradar_debug');
      } catch (e) {}
      return false;
    }
    return localStorage.getItem('busradar_debug') === '1';
  } catch (e) {
    return false;
  }
}

// === Pan-log overlay ===
// Live view of the last state._followLog entries — the follow-divergence
// diagnostic (a `skip` with `panning` reason and a large `dist` means the map
// fell behind the marker). Rendered via textContent (injection-safe), refreshed
// on a tracked 1s interval that is cleared on pan-log-off and on debug-off.
var _panLogEl = null;
var _panLogTimer = null;

function _renderPanLog() {
  if (!_panLogEl) return;
  var log = state._followLog || [];
  var lines = log.slice(-12).map(function (e) {
    var ts = new Date(e.t).toISOString().slice(11, 19);
    return (
      ts +
      ' ' +
      e.action +
      (e.dist != null ? ' d=' + e.dist : '') +
      (e.reason ? ' ' + e.reason : '')
    );
  });
  _panLogEl.textContent = 'pan-log (' + log.length + ')\n' + lines.join('\n');
}

function _startPanLog() {
  if (_panLogTimer) return; // guard double-start
  if (!_panLogEl) {
    _panLogEl = document.createElement('div');
    _panLogEl.id = 'debug-panlog';
    _panLogEl.style.cssText =
      'position:fixed;bottom:8px;right:8px;z-index:9998;' +
      'background:rgba(0,0,0,0.85);color:#8f8;padding:4px 8px;' +
      'font:10px/1.3 monospace;border-radius:4px;max-width:60vw;max-height:40vh;' +
      'overflow:auto;white-space:pre-wrap;pointer-events:none;';
    (document.body || document.documentElement).appendChild(_panLogEl);
  }
  _renderPanLog();
  _panLogTimer = setInterval(_renderPanLog, 1000);
}

function _stopPanLog() {
  if (_panLogTimer) {
    clearInterval(_panLogTimer);
    _panLogTimer = null;
  }
  if (_panLogEl && _panLogEl.parentNode) _panLogEl.parentNode.removeChild(_panLogEl);
  _panLogEl = null;
}

// Drive the underlying tool on/off. Pure with respect to persistence + button
// visuals (those live in setTool), so debug-console.js hide() etc. never loop
// back here.
function _driveTool(name, active) {
  if (name === 'console') {
    if (window.__debugConsole) {
      if (active) window.__debugConsole.show();
      else window.__debugConsole.hide();
    }
  } else if (name === 'gps') {
    if (window.__gpsDebug) {
      if (active) window.__gpsDebug.show();
      else window.__gpsDebug.hide();
    }
  } else if (name === 'panlog') {
    if (active) _startPanLog();
    else _stopPanLog();
  } else if (name === 'verbose') {
    try {
      window.__busradarVerbose = active;
    } catch (e) {}
  }
}

// Single writer for a tool toggle: persist, drive the tool, reflect the button.
// Also called by debug-console.js's overlay Close (name='console', active=false)
// so the toggle + button stay in sync when the overlay is dismissed directly.
function setTool(name, active) {
  active = !!active;
  if (!(name in _tools)) return;
  _tools[name] = active;
  _saveTools();
  _driveTool(name, active);
  _syncButtons();
}

function _syncButtons() {
  var opts = document.getElementById('debug-options');
  if (!opts) return;
  opts.querySelectorAll('.settings-opt').forEach(function (btn) {
    var active = !!_tools[btn.dataset.tool];
    btn.classList.toggle('settings-opt--active', active);
    btn.setAttribute('aria-checked', String(active));
  });
}

function _actionBtn(text, fn) {
  var b = document.createElement('button');
  b.className = 'settings-opt';
  b.type = 'button';
  b.textContent = text;
  b.addEventListener('click', fn);
  return b;
}

// Build the menu group and insert it ABOVE the destructive reset group. Labels
// are literals (no data-i18n, which applyI18n would otherwise blank). Idempotent
// — a second call is a no-op, so no double-append / duplicate listeners.
function _buildMenu() {
  var panel = document.getElementById('settings-panel');
  if (!panel) return;
  if (document.getElementById('debug-group')) return;

  var group = document.createElement('div');
  group.className = 'settings-group';
  group.id = 'debug-group';

  var label = document.createElement('span');
  label.className = 'settings-label';
  label.textContent = '🐞 Debug';
  group.appendChild(label);

  var opts = document.createElement('div');
  opts.className = 'settings-options';
  opts.id = 'debug-options';
  TOGGLES.forEach(function (tg) {
    var btn = document.createElement('button');
    btn.className = 'settings-opt';
    btn.type = 'button';
    btn.setAttribute('role', 'switch');
    btn.setAttribute('aria-checked', 'false');
    btn.dataset.tool = tg.key;
    btn.textContent = tg.label;
    btn.addEventListener('click', function () {
      setTool(tg.key, !_tools[tg.key]);
    });
    opts.appendChild(btn);
  });
  group.appendChild(opts);

  var actions = document.createElement('div');
  actions.className = 'settings-options';
  actions.appendChild(
    _actionBtn('Dump ⬇', function () {
      if (window.busradarDownloadDump) window.busradarDownloadDump();
    }),
  );
  actions.appendChild(
    _actionBtn('Dump 📋', function () {
      if (window.busradarCopyDump) window.busradarCopyDump();
    }),
  );
  actions.appendChild(
    _actionBtn('Debug aus', function () {
      disableDebug();
    }),
  );
  group.appendChild(actions);

  var reset = panel.querySelector('.settings-group--reset');
  if (reset) panel.insertBefore(group, reset);
  else panel.appendChild(group);
}

// Turn off debug mode entirely: clear the master flag, switch every tool off
// (hides overlays/pill, clears the pan-log interval), persist all-off so a later
// re-enable starts clean, and remove the menu group + its window handle. Clears
// the persisted master flag like ?debug=0 — but note a ?debug=1 still present in
// the URL re-enables debug on the next reload (URL wins over storage).
function disableDebug() {
  try {
    localStorage.removeItem('busradar_debug');
  } catch (e) {}
  window.__busradarDebug = false;
  Object.keys(_tools).forEach(function (k) {
    _tools[k] = false;
    _driveTool(k, false);
  });
  _saveTools();
  var group = document.getElementById('debug-group');
  if (group && group.parentNode) group.parentNode.removeChild(group);
  delete window.__debugMenu;
}

// Build the menu + apply the persisted tool state once the DOM and the other
// modules' window handles exist. init.js is a deferred module script, so at
// debug.js eval time the parser is done but readyState is 'interactive', NOT
// 'complete' — map.js (window.__gpsDebug) and refresh.js (the dump handles)
// have not evaluated yet. Applying now would silently skip restoring the GPS
// tool. So only run immediately when readyState is 'complete'; otherwise defer
// to DOMContentLoaded, which fires after the whole module graph has evaluated
// and set its window handles.
function _applyOnReady() {
  if (!window.__busradarDebug) return;
  _buildMenu();
  window.__debugMenu = { setTool: setTool };
  Object.keys(_tools).forEach(function (k) {
    if (_tools[k]) _driveTool(k, true);
  });
  _syncButtons();
}

window.__busradarDebug = _resolveMaster();

if (window.__busradarDebug) {
  if (document.readyState === 'complete') {
    _applyOnReady();
  } else {
    document.addEventListener('DOMContentLoaded', _applyOnReady, { once: true });
  }
}

// Exported for the unit tests (the menu is otherwise driven entirely by the
// master flag + DOM events).
export { setTool, disableDebug, _loadTools, _resolveMaster, _applyOnReady };
