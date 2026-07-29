// On-screen debug console + console ring buffer for debugging on devices
// without DevTools.
//
// Overlay:  add ?console=1 to the URL (persists via localStorage), ?console=0
//           or the "Close ✕" button to disable. Captures console.*, uncaught
//           errors and unhandled rejections into a scrollable overlay.
// Ring buffer: console.* / errors are ALWAYS captured into a bounded
//           window.__busradarConsoleTail (no DOM, negligible cost) so the
//           debug dump (Ctrl+Shift+D / the "Dump" button / window.busradarDump)
//           always carries the recent console output, even without the overlay.
//
// Vanilla + CSP-safe: only inline STYLES (style-src 'unsafe-inline') and DOM
// creation; no inline script, so no CSP hash needed. Served same-origin (self).
(function () {
  function overlayEnabled() {
    try {
      var q = new URLSearchParams(location.search).get('console');
      if (q === '1') { try { localStorage.setItem('busradar_console', '1'); } catch (e) {} return true; }
      if (q === '0') { try { localStorage.removeItem('busradar_console'); } catch (e) {} return false; }
      return localStorage.getItem('busradar_console') === '1';
    } catch (e) { return false; }
  }
  var OVERLAY = overlayEnabled();

  // Always-on ring buffer of formatted lines (for the debug dump).
  var RING = [];
  try { window.__busradarConsoleTail = RING; } catch (e) {}

  var box = null, logEl = null;

  function ensureUI() {
    if (box) return;
    box = document.createElement('div');
    box.id = 'debug-console';
    box.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;' +
      'max-height:45vh;display:flex;flex-direction:column;' +
      'background:rgba(0,0,0,0.92);color:#e0e0e0;font:11px/1.4 monospace;' +
      'border-top:2px solid #4285f4;';
    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;align-items:center;padding:5px 8px;background:#111;flex:0 0 auto;';
    var title = document.createElement('span');
    title.textContent = 'debug console';
    title.style.cssText = 'flex:1;color:#4285f4;font-weight:bold;';
    var dumpBtn = document.createElement('button');
    dumpBtn.textContent = 'Dump 📋';
    var clearBtn = document.createElement('button');
    clearBtn.textContent = 'Clear';
    var closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close ✕';
    [dumpBtn, clearBtn, closeBtn].forEach(function (b) {
      b.style.cssText = 'background:#333;color:#fff;border:1px solid #555;border-radius:4px;' +
        'padding:4px 10px;font:11px monospace;touch-action:manipulation;';
    });
    dumpBtn.addEventListener('click', function () {
      if (window.busradarCopyDump) window.busradarCopyDump();
      else console.warn('[debug-console] busradarCopyDump not available yet');
    });
    clearBtn.addEventListener('click', function () { if (logEl) logEl.textContent = ''; });
    closeBtn.addEventListener('click', function () {
      // Close = disable overlay + remove; ring buffer capture continues.
      // Re-enable with ?console=1 (address bar is available on mobile Firefox).
      try { localStorage.removeItem('busradar_console'); } catch (e) {}
      if (box && box.parentNode) box.parentNode.removeChild(box);
      box = null; logEl = null; OVERLAY = false;
    });
    bar.appendChild(title);
    bar.appendChild(dumpBtn);
    bar.appendChild(clearBtn);
    bar.appendChild(closeBtn);
    box.appendChild(bar);
    logEl = document.createElement('div');
    logEl.style.cssText = 'overflow:auto;padding:4px 8px;flex:1 1 auto;-webkit-overflow-scrolling:touch;';
    box.appendChild(logEl);
    (document.body || document.documentElement).appendChild(box);
  }

  function fmt(a) {
    if (a && (a instanceof Error || (a.name && a.message !== undefined))) {
      return a.name + ': ' + a.message;  // Error AND DOMException
    }
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
    return String(a);
  }

  function record(level, args) {
    var text;
    try {
      var ts = new Date().toISOString().slice(11, 19);
      text = ts + ' [' + level + '] ' + Array.prototype.map.call(args, fmt).join(' ');
    } catch (e) { return; }
    RING.push(text);
    while (RING.length > 250) RING.shift();  // bounded
    if (!OVERLAY) return;
    try {
      ensureUI();
      if (!logEl) return;  // overlay closed
      var line = document.createElement('div');
      var color = level === 'error' ? '#ff6b6b' : level === 'warn' ? '#ffd166' : '#e0e0e0';
      line.style.cssText = 'white-space:pre-wrap;word-break:break-word;border-bottom:1px solid #222;padding:1px 0;color:' + color + ';';
      line.textContent = text;
      logEl.appendChild(line);
      while (logEl.childNodes.length > 300) logEl.removeChild(logEl.firstChild);  // cap
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
    record('error', [(e && e.message) + ' @ ' + ((e && e.filename) || '') + ':' + ((e && e.lineno) || '')]);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    record('error', ['unhandledrejection: ' + fmt(r)]);
  });

  if (OVERLAY) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', ensureUI);
    } else {
      ensureUI();
    }
    console.log('[debug-console] enabled — ?console=0 or Close to disable');
  }
})();
