// On-screen debug console for mobile browsers (no DevTools access).
//
// Enable:  add ?console=1 to the URL (persists via localStorage).
// Disable: add ?console=0, or tap the on-screen "Close ✕" button.
//
// Captures console.log/info/warn/error/debug plus uncaught errors and
// unhandled promise rejections into a fixed, scrollable overlay at the
// bottom of the viewport. Zero footprint when disabled (early return —
// no console patching, no DOM, no listeners).
//
// Vanilla + CSP-safe: only inline STYLES (style-src 'unsafe-inline') and
// DOM creation; no inline script, so no CSP hash needed. Served as a
// same-origin module (script-src 'self').
(function () {
  function enabled() {
    try {
      var q = new URLSearchParams(location.search).get('console');
      if (q === '1') { try { localStorage.setItem('busradar_console', '1'); } catch (e) {} return true; }
      if (q === '0') { try { localStorage.removeItem('busradar_console'); } catch (e) {} return false; }
      return localStorage.getItem('busradar_console') === '1';
    } catch (e) { return false; }
  }
  if (!enabled()) return;

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
    var clearBtn = document.createElement('button');
    clearBtn.textContent = 'Clear';
    var closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close ✕';
    [clearBtn, closeBtn].forEach(function (b) {
      b.style.cssText = 'background:#333;color:#fff;border:1px solid #555;border-radius:4px;' +
        'padding:4px 10px;font:11px monospace;touch-action:manipulation;';
    });
    logEl = document.createElement('div');
    logEl.style.cssText = 'overflow:auto;padding:4px 8px;flex:1 1 auto;-webkit-overflow-scrolling:touch;';
    clearBtn.addEventListener('click', function () { if (logEl) logEl.textContent = ''; });
    closeBtn.addEventListener('click', function () {
      // Close = disable + remove, so it stays gone across reloads. Re-enable
      // with ?console=1 (the address bar is available on mobile Firefox).
      try { localStorage.removeItem('busradar_console'); } catch (e) {}
      if (box && box.parentNode) box.parentNode.removeChild(box);
      box = null; logEl = null;
    });
    bar.appendChild(title);
    bar.appendChild(clearBtn);
    bar.appendChild(closeBtn);
    box.appendChild(bar);
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

  function append(level, args) {
    try {
      ensureUI();
      if (!logEl) return;  // closed
      var line = document.createElement('div');
      var color = level === 'error' ? '#ff6b6b' : level === 'warn' ? '#ffd166' : '#e0e0e0';
      line.style.cssText = 'white-space:pre-wrap;word-break:break-word;border-bottom:1px solid #222;padding:1px 0;color:' + color + ';';
      var ts = new Date().toISOString().slice(11, 19);
      line.textContent = ts + ' [' + level + '] ' + Array.prototype.map.call(args, fmt).join(' ');
      logEl.appendChild(line);
      while (logEl.childNodes.length > 300) logEl.removeChild(logEl.firstChild);  // cap
      logEl.scrollTop = logEl.scrollHeight;
    } catch (e) {}
  }

  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    var orig = console[level] ? console[level].bind(console) : function () {};
    console[level] = function () {
      orig.apply(null, arguments);
      append(level === 'debug' ? 'log' : level, arguments);
    };
  });

  window.addEventListener('error', function (e) {
    append('error', [(e && e.message) + ' @ ' + ((e && e.filename) || '') + ':' + ((e && e.lineno) || '')]);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    append('error', ['unhandledrejection: ' + fmt(r)]);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureUI);
  } else {
    ensureUI();
  }
  console.log('[debug-console] enabled — ?console=0 or Close to disable');
})();
