// On-screen debug console + console ring buffer for debugging on devices
// without DevTools.
//
// Ring buffer + console.* patch: installed at import time and ALWAYS on
//   (no DOM, negligible cost). console.* / uncaught errors / unhandled
//   rejections are captured into a bounded window.__busradarConsoleTail so the
//   debug dump (window.busradarDump / Ctrl+Shift+D) always carries the recent
//   output, whether or not the overlay is visible.
// Overlay: a scrollable on-screen panel, shown/hidden via
//   window.__debugConsole.show()/hide()/toggle()/isOpen(). The ?debug menu
//   (debug.js) decides when to AUTO-show it (only when the master
//   busradar_debug flag AND the console tool toggle are set) and owns the
//   toggle persistence + button state. These handles stay callable directly
//   from the console / Playwright at any time, independent of ?debug.
//
// Vanilla + CSP-safe: only inline STYLES (style-src 'unsafe-inline') and DOM
// creation; no inline script, so no CSP hash needed. Served same-origin (self).
(function () {
  // Always-on ring buffer of formatted lines (for the debug dump).
  var RING = [];
  try {
    window.__busradarConsoleTail = RING;
  } catch (e) {}

  var box = null,
    logEl = null;
  var OVERLAY = false; // whether the overlay is currently shown

  function ensureUI() {
    if (box) return;
    box = document.createElement('div');
    box.id = 'debug-console';
    box.style.cssText =
      'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;' +
      'max-height:45vh;display:flex;flex-direction:column;' +
      'background:rgba(0,0,0,0.92);color:#e0e0e0;font:11px/1.4 monospace;' +
      'border-top:2px solid #4285f4;';
    var bar = document.createElement('div');
    bar.style.cssText =
      'display:flex;gap:8px;align-items:center;padding:5px 8px;background:#111;flex:0 0 auto;';
    var title = document.createElement('span');
    title.textContent = 'debug console';
    title.style.cssText = 'flex:1;color:#4285f4;font-weight:bold;';
    var clearBtn = document.createElement('button');
    clearBtn.textContent = 'Clear';
    var closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close ✕';
    [clearBtn, closeBtn].forEach(function (b) {
      b.style.cssText =
        'background:#333;color:#fff;border:1px solid #555;border-radius:4px;' +
        'padding:4px 10px;font:11px monospace;touch-action:manipulation;';
    });
    clearBtn.addEventListener('click', function () {
      if (logEl) logEl.textContent = '';
    });
    closeBtn.addEventListener('click', function () {
      // Route the close through the ?debug menu when it's present, so the
      // console tool toggle (busradar_debug_tools.console) and its button
      // reflect the close instead of desyncing. setTool drives hide() itself.
      // Without a menu (e.g. programmatic show() from Playwright, master flag
      // off) just hide the overlay — there is no toggle state to persist.
      if (window.__debugMenu && typeof window.__debugMenu.setTool === 'function') {
        window.__debugMenu.setTool('console', false);
      } else {
        hide();
      }
    });
    bar.appendChild(title);
    bar.appendChild(clearBtn);
    bar.appendChild(closeBtn);
    box.appendChild(bar);
    logEl = document.createElement('div');
    // Cap the visible log at ~15 rows (11px/1.4 line + 1px row padding ≈ 17px),
    // then scroll — otherwise a chatty session covers the whole screen.
    logEl.style.cssText =
      'overflow:auto;padding:4px 8px;flex:1 1 auto;max-height:260px;-webkit-overflow-scrolling:touch;';
    box.appendChild(logEl);
    (document.body || document.documentElement).appendChild(box);
  }

  function show() {
    OVERLAY = true;
    if (document.body) {
      ensureUI();
    } else {
      // Called before the body exists (very early programmatic show). Defer
      // the DOM build to DOMContentLoaded; the ring buffer already captures.
      document.addEventListener(
        'DOMContentLoaded',
        function () {
          if (OVERLAY) ensureUI();
        },
        { once: true },
      );
    }
  }
  function hide() {
    OVERLAY = false;
    if (box && box.parentNode) box.parentNode.removeChild(box);
    box = null;
    logEl = null;
  }
  function toggle() {
    if (OVERLAY) hide();
    else show();
  }
  function isOpen() {
    return OVERLAY;
  }
  try {
    window.__debugConsole = { show: show, hide: hide, toggle: toggle, isOpen: isOpen };
  } catch (e) {}

  function fmt(a) {
    if (a && (a instanceof Error || (a.name && a.message !== undefined))) {
      return a.name + ': ' + a.message; // Error AND DOMException
    }
    if (typeof a === 'object') {
      try {
        return JSON.stringify(a);
      } catch (e) {
        return String(a);
      }
    }
    return String(a);
  }

  function record(level, args) {
    var text;
    try {
      var ts = new Date().toISOString().slice(11, 19);
      text = ts + ' [' + level + '] ' + Array.prototype.map.call(args, fmt).join(' ');
    } catch (e) {
      /* v8 ignore next -- defensive: Date/formatting never throws here */ return;
    }
    RING.push(text);
    while (RING.length > 10000) RING.shift(); // bounded, but generous so the dump carries the full session
    if (!OVERLAY) return;
    try {
      ensureUI();
      /* v8 ignore next -- unreachable: ensureUI sets box+logEl together and hide() nulls both, so box truthy with logEl null cannot occur */
      if (!logEl) return; // overlay closed
      var line = document.createElement('div');
      var color = level === 'error' ? '#ff6b6b' : level === 'warn' ? '#ffd166' : '#e0e0e0';
      line.style.cssText =
        'white-space:pre-wrap;word-break:break-word;border-bottom:1px solid #222;padding:1px 0;color:' +
        color +
        ';';
      line.textContent = text;
      logEl.appendChild(line);
      while (logEl.childNodes.length > 300) logEl.removeChild(logEl.firstChild); // cap
      logEl.scrollTop = logEl.scrollHeight;
    } catch (e) {}
  }

  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    var orig = console[level] ? console[level].bind(console) : function () {};
    console[level] = function () {
      orig.apply(null, arguments);
      record(level === 'debug' ? 'log' : level, arguments);
    };
  });

  window.addEventListener('error', function (e) {
    record('error', [
      (e && e.message) + ' @ ' + ((e && e.filename) || '') + ':' + ((e && e.lineno) || ''),
    ]);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    record('error', ['unhandledrejection: ' + fmt(r)]);
  });
})();
