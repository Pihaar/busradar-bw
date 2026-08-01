import { CONFIG } from './config.js';
import { state, SSE_BOARD_DUR } from './state.js';

// Re-exported from state.js (single source of truth shared with the reconcile
// window in ui.js). Kept as a named export here for existing importers of the
// api module.
export { SSE_BOARD_DUR };

// === TRACKED FETCH ===
// Transparent wrapper around window.fetch for the debug dump: returns the
// ORIGINAL promise and records {ts, method, url, status, kind} into the bounded
// state._fetchLog ring via a SEPARATE two-arg observer. It must not change the
// caller-visible settle — never `.then().catch()` (would swallow rejections and
// break the selectStream 401/409 recovery + AbortController de-dup) and never a
// one-arg `.then` (would leave a dangling rejected promise → unhandledrejection
// that the jsErrors ring then captures). It reads only r.status/r.ok and does
// NOT consume the single-use body. Recording is itself try-guarded so a ring
// write can never turn a successful fetch into a rejection.
var _FETCH_LOG_CAP = 60;
function _recFetch(opts, url, status, kind) {
  try {
    state._fetchLog.push({
      ts: Date.now(),
      method: (opts && opts.method) || 'GET',
      url: String(url),
      status: status,
      kind: kind,
    });
    while (state._fetchLog.length > _FETCH_LOG_CAP) state._fetchLog.shift();
  } catch (e) {
    /* diagnostics must never break a fetch */
  }
}

export function trackedFetch(url, opts) {
  var p = window.fetch(url, opts);
  p.then(
    function (r) {
      _recFetch(opts, url, r.status, r.ok ? 'ok' : 'http-error');
    },
    function (e) {
      _recFetch(opts, url, 0, e && e.name === 'AbortError' ? 'abort' : 'network');
    },
  );
  return p;
}

// === SELECTSTREAM DEBOUNCE ===
// Rapid load-more clicks would fire one POST /api/stream/select per
// click; the server-side per-subscriber rate-limit (burst 3, refill 1/s)
// 429s the 4th+ in a burst. Debounce 250ms trailing: rapid clicks
// collapse into a single POST with the LAST window the user landed on.
// The intermediate dur values are irrelevant to the server — only the
// final state matters for the next SSE tick's push. The 250ms feels
// instant for a user click while comfortably ducking under the rate
// budget for click bursts up to ~6/s.
var _selectStreamTimer = null;
var _selectStreamPending = null;
var _selectStreamResolvers = [];
var _selectStreamRejecters = [];
// Defense-in-depth cap on the debounce queue. A tight-loop caller inside
// this tab (compromised extension, DevTools script) can push a resolve/
// reject pair on every call while also resetting the 250ms timer — the
// arrays grow without the flush ever firing. Blast radius is the
// attacker's own tab (the POST never goes out), but a cap costs nothing
// and keeps the memory footprint bounded. When the cap is hit we reject
// the OLDEST pending pair with a "superseded" error and let the newest
// call in; the timer stays running so the flush still fires eventually
// and drains the remaining waiters. 64 is enough for any legitimate
// burst (rapid load-more clicks max out around 6-10 per debounce window).
var _SELECTSTREAM_QUEUE_CAP = 64;

function _selectStreamFlush() {
  _selectStreamTimer = null;
  var pending = _selectStreamPending;
  var resolvers = _selectStreamResolvers;
  var rejecters = _selectStreamRejecters;
  _selectStreamPending = null;
  _selectStreamResolvers = [];
  _selectStreamRejecters = [];
  trackedFetch(CONFIG.apiBase + '/stream/select', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selection: pending }),
    credentials: 'same-origin',
  })
    .then(function (r) {
      if (r.status === 401 || r.status === 409) {
        // Broken session — caller should treat as "EventSource will reconnect".
        // The viewport-POST path in refresh.js does the actual recovery; here
        // we just signal the failure as an Error so .catch handlers can
        // diagnose. Don't reload-loop from selectStream itself, the viewport
        // POST that follows on every map move already triggers the reconnect.
        var err = new Error('HTTP ' + r.status + ' broken_session');
        rejecters.forEach(function (f) {
          f(err);
        });
        return;
      }
      if (!r.ok) {
        var err2 = new Error('HTTP ' + r.status);
        rejecters.forEach(function (f) {
          f(err2);
        });
        return;
      }
      r.json()
        .then(function (data) {
          resolvers.forEach(function (f) {
            f(data);
          });
        })
        .catch(function (e) {
          rejecters.forEach(function (f) {
            f(e);
          });
        });
    })
    .catch(function (e) {
      rejecters.forEach(function (f) {
        f(e);
      });
    });
}

function _selectStreamImpl(type, id, boardType, dur) {
  var selection;
  if (type === 'journey') {
    selection = { kind: 'journey', jid: id };
  } else if (type === 'stationboard') {
    var d = parseInt(dur, 10);
    // NaN / undefined / negative → 60. These are defensive against
    // legitimate edge cases (a caller passing an uninitialised setting).
    if (!isFinite(d) || d < 60) d = 60;
    // Above the server's upper bound: clamp so the request still has a
    // chance of succeeding rather than 422ing for a one-off overshoot.
    if (d > 1440) d = 1440;
    // No silent multiple-of-60 clamp here on purpose. The server-side
    // Pydantic validator rejects non-multiples with 422; a caller that
    // sends `dur=75` has a bug, and we want that bug visible in the
    // network tab and the console, not papered over with a silent
    // rewrite to 60 (which would shrink the rendered list and confuse
    // the user instead of confusing the developer).
    selection = { kind: 'stationboard', lid: id, board_type: boardType || 'DEP', dur: d };
  } else {
    selection = null;
  }
  _selectStreamPending = selection;
  return new Promise(function (resolve, reject) {
    // Cap at _SELECTSTREAM_QUEUE_CAP: if a tight-loop caller has already
    // pushed that many pairs without the flush firing, drop the oldest
    // by rejecting its reject-callback and shifting both arrays. The
    // released promise's `.catch` handler (if any) runs; the promise
    // itself is now eligible for GC because nothing holds a strong ref.
    if (_selectStreamResolvers.length >= _SELECTSTREAM_QUEUE_CAP) {
      _selectStreamResolvers.shift();
      var oldestReject = _selectStreamRejecters.shift();
      try {
        oldestReject(new Error('selectStream superseded (queue cap)'));
      } catch (e) {
        /* consumer .catch threw — swallow, we're just draining */
      }
    }
    _selectStreamResolvers.push(resolve);
    _selectStreamRejecters.push(reject);
    if (_selectStreamTimer) clearTimeout(_selectStreamTimer);
    _selectStreamTimer = setTimeout(_selectStreamFlush, 250);
  });
}

// === API LAYER ===
export var api = {
  _journeyUserAbort: null,
  _stationDepAbort: null,
  _stationArrAbort: null,

  getStops: function (lat, lon, radius) {
    var params = new URLSearchParams({
      lat: lat.toFixed(5),
      lon: lon.toFixed(5),
      radius: String(radius),
    });
    return trackedFetch(CONFIG.apiBase + '/stops?' + params.toString()).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  },

  getJourney: function (jid, opts) {
    var userInitiated = opts && opts.userInitiated;
    if (userInitiated) {
      if (api._journeyUserAbort) api._journeyUserAbort.abort();
      api._journeyUserAbort = new AbortController();
    }
    var fetchOpts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jid: jid }),
    };
    if (userInitiated) fetchOpts.signal = api._journeyUserAbort.signal;
    return trackedFetch(CONFIG.apiBase + '/journey', fetchOpts).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  },

  getStationBoard: function (lid, type, dur) {
    var abortKey = type === 'ARR' ? '_stationArrAbort' : '_stationDepAbort';
    if (api[abortKey]) api[abortKey].abort();
    api[abortKey] = new AbortController();
    return trackedFetch(CONFIG.apiBase + '/stationboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // One plain full-window fetch (the client paginates the result and keeps
      // it fresh via the 2h SSE reconcile). The old server-side auto-expand
      // cascade (auto_expand/min_results/ext_id) is gone.
      body: JSON.stringify({
        lid: lid,
        type: type || 'DEP',
        dur: dur || 60,
      }),
      signal: api[abortKey].signal,
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  },

  // Tag the SSE subscriber with a current journey or stationboard. The server
  // then ships matching SSE events on every tick. Used alongside the one-off
  // getJourney/getStationBoard fetches above so detail-panel updates flow
  // over the stream rather than per-tick polls.
  //
  // Wire format is a Pydantic discriminated union on the server side:
  //   selectStream('journey', jid)                     → {"selection":{"kind":"journey","jid":...}}
  //   selectStream('stationboard', lid, 'DEP', 60)     → {"selection":{"kind":"stationboard","lid":...,"board_type":"DEP","dur":60}}
  //   selectStream('stationboard', lid, 'ARR', 300)    → {"selection":{"kind":"stationboard","lid":...,"board_type":"ARR","dur":300}}
  //   selectStream('none')                             → {"selection":null}
  //
  // The `dur` value must match the window the server settled on for the current
  // board (getStationBoard returns it as `settledDur`; the server widens the
  // window internally). Pushing the wrong dur shrinks the displayed list on
  // every tick.
  //
  // Debounced 250ms trailing: rapid load-more clicks fired one POST per
  // click and hit the per-subscriber burst=3 rate-limit on /api/stream/
  // select. Coalescing to the last call keeps the user-visible action
  // (display the new window) correct while collapsing the wire traffic.
  //
  // **Debounce contract:** every caller queued inside the 250 ms window
  // receives the SAME response — specifically the one returned for the
  // LAST selection pushed during the window. The promise returned by an
  // earlier call does NOT track that call's selection. All current
  // callers use `.catch(...)` and ignore the resolved value, so this is
  // invisible in practice; any future caller that consumes the resolved
  // payload must account for the last-writer-wins semantic.
  selectStream: function (type, id, boardType, dur) {
    return _selectStreamImpl(type, id, boardType, dur);
  },

  // Subscribe the SSE stream to a stationboard's REALTIME window. The initial
  // board is fetched whole (dur=1440) and paginated client-side, but the SSE
  // push only needs to keep the near-term fresh, so it is ALWAYS subscribed at
  // the fixed 2h window — never the 1440 fetch dur. Routing every subscribe
  // (open, tab switch, SSE-reconnect resend) through this one helper is what
  // guarantees a reconnect can't accidentally re-subscribe at 1440.
  subscribeBoard: function (lid, boardType) {
    return _selectStreamImpl('stationboard', lid, boardType, SSE_BOARD_DUR);
  },
};

// === URL STATE ===
var URL_SCHEMA = Object.create(null);
URL_SCHEMA.jid = 1;
URL_SCHEMA.stop = 1;
URL_SCHEMA.lat = 1;
URL_SCHEMA.lon = 1;
URL_SCHEMA.z = 1;
URL_SCHEMA.follow = 1;
URL_SCHEMA.tab = 1;

export var urlState = {
  push: function (params) {
    var clean = Object.create(null);
    Object.keys(params).forEach(function (k) {
      if (k in URL_SCHEMA) clean[k] = params[k];
    });
    var hash =
      '#' +
      Object.keys(clean)
        .map(function (k) {
          return k + '=' + encodeURIComponent(clean[k]);
        })
        .join('&');
    history.pushState(clean, '', hash);
    urlState._pushCount = (urlState._pushCount || 0) + 1;
  },

  replace: function (params) {
    var clean = Object.create(null);
    Object.keys(params).forEach(function (k) {
      if (k in URL_SCHEMA) clean[k] = params[k];
    });
    var hash =
      '#' +
      Object.keys(clean)
        .map(function (k) {
          return k + '=' + encodeURIComponent(clean[k]);
        })
        .join('&');
    history.replaceState(clean, '', hash);
  },

  parse: function () {
    var hash = location.hash.slice(1);
    if (!hash || hash.length > 2048) return Object.create(null);
    var params = Object.create(null);
    hash.split('&').forEach(function (pair) {
      try {
        var idx = pair.indexOf('=');
        if (idx < 1) return;
        var key = pair.slice(0, idx);
        if (!(key in URL_SCHEMA)) return;
        if (key in params) return;
        var val = decodeURIComponent(pair.slice(idx + 1));
        if (val.length > 300) return;
        if (key === 'tab' && val !== 'dep' && val !== 'arr') return;
        params[key] = val;
      } catch (e) {}
    });
    return params;
  },

  saveMapPosition: function () {
    var center = state.map.getCenter();
    var zoom = state.map.getZoom();
    urlState.replace({ lat: center.lat.toFixed(5), lon: center.lng.toFixed(5), z: zoom });
  },

  buildShareHash: function (opts) {
    var clean = Object.create(null);
    if (opts.jid) clean.jid = opts.jid;
    else if (opts.stop) {
      clean.stop = opts.stop;
      if (opts.tab === 'dep' || opts.tab === 'arr') clean.tab = opts.tab;
    }
    return (
      '#' +
      Object.keys(clean)
        .map(function (k) {
          return k + '=' + encodeURIComponent(clean[k]);
        })
        .join('&')
    );
  },
};
