import { CONFIG } from './config.js';
import {
  state,
  settings,
  t,
  getDelayClass,
  getDelayText,
  parseHafasTimeToMin,
  debugLog,
} from './state.js';
import { api } from './api.js';
import {
  markers,
  stopsLayer,
  startLocationWatch,
  stopLocationWatch,
  removeUserLocationMarker,
} from './map.js';
import { ui } from './ui.js';
import {
  updateStatus,
  getServerTimeStr,
  showError,
  showPersistentError,
  clearPersistentError,
  announce,
  formatStatusText,
} from './status.js';

// Re-export for init.js and other consumers
export {
  updateStatus,
  getServerTimeStr,
  showError,
  showPersistentError,
  clearPersistentError,
  announce,
};

// === SSE event-stream driver ===
// Polling is gone. We hold one EventSource open for the lifetime of the tab,
// reconnect with a small backoff sequence on drop, and POST viewport updates
// when the user pans/zooms. Reconnect is capped at 5 cycles; after that we
// surface a terminal banner with a manual reload button instead of looping
// forever.

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 15000, 15000];
const VIEWPORT_DEBOUNCE_MS = 250;
// Minimum server-ring radius (metres) to request while following a bus, so a
// zoomed-in follow keeps the bus in the fresh vehicles payload instead of
// dropping to the ~30 s-cached journey detail push. See _sendCurrentViewport.
const FOLLOW_MIN_RING_M = 2000;
const REGEX_VERSION = /^[A-Za-z0-9._+-]{1,64}$/;
// The protocol version the client speaks. Must match the server's
// `subscribe` event payload — mismatch means the deployed app and the
// running tab are incompatible and the user must reload.
const SSE_PROTOCOL_VERSION = '1';

let _es = null;
let _reconnectAttempt = 0;
let _reconnectTimer = null;
let _viewportTimer = null;

function _formatConnectedCount(n) {
  // Exact count for ≤99 (user preference: precise users beat coarse buckets),
  // "100+" cap above so the status bar can't grow indefinitely wide on a
  // hypothetical viral day.
  if (typeof n !== 'number' || !isFinite(n) || n < 0) return null;
  if (n >= 100) return '100+';
  return String(n);
}

function _setSseState(s) {
  state._sseState = s;
  if (ui && typeof ui.updateSseState === 'function') ui.updateSseState(s);
  // The visible status-dot lives in status.js and is only ever flipped to
  // `--live` from `updateStatus()` on a successful vehicles event. Without
  // these explicit transitions the dot stayed `--live` indefinitely while
  // the SSE stream was reconnecting or terminally dead — the e2e
  // TestOffline regression. Mirror the SSE state onto the dot:
  //   reconnecting / failed-terminal → showPersistentError → --offline or --error
  //   open                            → clearPersistentError (let next vehicles tick paint --live)
  if (s === 'reconnecting' || s === 'failed-terminal') {
    state.consecutiveErrors = (state.consecutiveErrors || 0) + 1;
    showPersistentError(
      s === 'failed-terminal' ? t('connection_lost_terminal') : t('connection_lost'),
    );
  } else if (s === 'open') {
    clearPersistentError();
    // Every successful (re)connect funnels through here, so this clears a
    // stale terminal banner after ANY reopen path (visibilitychange, online,
    // pageshow-restore, broken-session recovery).
    if (ui && typeof ui.hideTerminalBanner === 'function') ui.hideTerminalBanner();
  }
}

function _maybeUpdateAppVersion(v) {
  if (typeof v !== 'string' || !REGEX_VERSION.test(v)) return;
  if (!state._appVersion) {
    state._appVersion = v;
  } else if (v !== state._appVersion && !state._versionUpdateBannerShown) {
    state._versionUpdateBannerShown = true;
    ui.showVersionUpdateBanner();
  }
}

function _onTerminal() {
  _setSseState('failed-terminal');
  if (_es) {
    try {
      _es.close();
    } catch (e) {}
    _es = null;
  }
  state._lastConnectedClients = null;
  if (ui && typeof ui.showTerminalBanner === 'function') {
    ui.showTerminalBanner();
  } else {
    showPersistentError(t('connection_lost_terminal'));
  }
}

function _scheduleReconnect() {
  if (_reconnectAttempt >= RECONNECT_DELAYS_MS.length) {
    _onTerminal();
    return;
  }
  const base = RECONNECT_DELAYS_MS[_reconnectAttempt];
  _reconnectAttempt++;
  const jitter = Math.floor((Math.random() - 0.5) * base * 0.4);
  const delay = Math.max(0, base + jitter);
  if (window.__busradarVerbose)
    debugLog('sse reconnect scheduled', { attempt: _reconnectAttempt, delayMs: delay });
  _setSseState('reconnecting');
  clearTimeout(_reconnectTimer);
  _reconnectTimer = setTimeout(function () {
    startStream();
  }, delay);
}

// Re-POST the currently-selected journey or stop so detail (journey /
// stationboard) pushes survive an SSE reconnect. A reconnect registers a fresh
// server-side subscriber with an empty selection, so without this the selected
// journey/stop silently stops receiving per-tick detail events. Exported so the
// test suite can drive it without an EventSource mock.
export function _resendActiveSelection() {
  if (state.selectedJid) {
    api.selectStream('journey', state.selectedJid).catch(function () {});
  } else if (state.selectedStop && state.selectedStop.lid) {
    var bt = state._activeStationBoardType || 'DEP';
    var dur = (bt === 'ARR' ? state._stationArrDur : state._stationDepDur) || 60;
    api.selectStream('stationboard', state.selectedStop.lid, bt, dur).catch(function () {});
  }
}

export function startStream() {
  if (_es) {
    try {
      _es.close();
    } catch (e) {}
    _es = null;
  }
  _setSseState('connecting');
  try {
    _es = new EventSource(CONFIG.apiBase + '/stream/');
  } catch (e) {
    _onTerminal();
    return;
  }

  _es.addEventListener('subscribe', function (ev) {
    _reconnectAttempt = 0;
    _setSseState('open');
    if (window.__busradarVerbose) debugLog('sse subscribe (stream open)');
    // Start the staleness clock at connect time. The stale-stream guard
    // (1s ticker + visibilitychange) keys off state.lastUpdate, which was
    // ONLY ever set by a vehicles event. A stream that connects but never
    // delivers a first vehicles event — e.g. the calibrator is idle right
    // after a server reboot (observed: tick_age_s ~1099) — left lastUpdate
    // null forever, so `staleByTime` stayed falsy and the self-heal
    // reconnect never fired. The tab sat with a dead stream, no markers,
    // and clicks did nothing. Seeding lastUpdate here means "connected but
    // no data within STALE_THRESHOLD_MS" is treated as stale too, so the
    // force-reconnect path kicks in (bounded by its 15s cooldown). A
    // healthy stream delivers its first tick well within the 45s window
    // and overwrites this normally.
    if (!state.lastUpdate) state.lastUpdate = Date.now();
    if (state.consecutiveErrors > 0) {
      state.consecutiveErrors = 0;
      clearPersistentError();
    }
    try {
      const d = JSON.parse(ev.data);
      if (d.protocol && d.protocol !== SSE_PROTOCOL_VERSION) {
        // Server speaks a different SSE protocol than this tab knows.
        // Reloading is the only safe recovery — the event shapes may have
        // shifted. Skip the reconnect loop and go straight to terminal.
        try {
          _es.close();
        } catch (e) {}
        _es = null;
        state._lastConnectedClients = null;
        if (ui && typeof ui.showVersionUpdateBanner === 'function') {
          state._versionUpdateBannerShown = true;
          ui.showVersionUpdateBanner();
        } else if (ui && typeof ui.showTerminalBanner === 'function') {
          ui.showTerminalBanner();
        }
        return;
      }
      _maybeUpdateAppVersion(d.appVersion);
    } catch (e) {}
    _sendCurrentViewport();
    // Re-send the active selection too. A reconnect creates a FRESH subscriber
    // on the server with no selection (only the viewport is re-sent above), so
    // journey/stationboard detail pushes would silently stop until the user
    // re-selects. That is why a followed journey never showed "journey ended"
    // (the position-less journey payload that triggers it stopped arriving) and
    // a departures board stopped refreshing after a stream drop.
    _resendActiveSelection();
  });

  _es.addEventListener('connected', function (ev) {
    try {
      const d = JSON.parse(ev.data);
      if (typeof d.count === 'number') {
        state._lastConnectedClients = _formatConnectedCount(d.count);
      }
    } catch (e) {}
  });

  _es.addEventListener('vehicles', function (ev) {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    if (window.__busradarVerbose) debugLog('sse vehicles', { count: (data.vehicles || []).length });
    _handleVehiclesPayload(data);
  });

  _es.addEventListener('journey', function (ev) {
    // The server pushes the currently-selected journey on every tick. Drop
    // the event if the user has since selected a different jid or closed
    // the panel — the server filters on its end too, but a late-delivered
    // payload still has to be filtered client-side.
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    if (!data || !data.jid) return;
    if (state.selectedJid !== data.jid) return;
    const journeyData = data.journey;
    if (!journeyData) return;
    if (window.__busradarVerbose)
      debugLog('sse journey', { jid: data.jid, hasPos: !!journeyData.pos });
    _applyJourneyPayload(data.jid, journeyData);
  });

  _es.addEventListener('stationboard', function (ev) {
    // The server pushes the selected stop's board on every tick. Board-type
    // (DEP or ARR) follows the user's current tab; the payload includes a
    // `boardType` field so the client renders the right list.
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    if (!data || !data.lid) return;
    if (!state.selectedStop || state.selectedStop.lid !== data.lid) return;
    try {
      ui.applyPushedStationboard(
        state.selectedStop,
        data.stationboard || {},
        data.boardType || 'DEP',
      );
    } catch (e) {
      console.warn('stationboard SSE handler:', e);
    }
  });

  _es.addEventListener('error', function (ev) {
    // Server-emitted `error` SSE event. Branches:
    //   - {stale: true}            → vehicles fetch failed, freeze map
    //   - {selection: 'journey'}   → detail fetch failed, leave panel
    //   - {selection: 'stationboard'} → board fetch failed, leave panel
    // Browser-level network errors do NOT come through addEventListener('error');
    // those land on _es.onerror below.
    try {
      const d = JSON.parse(ev.data || '{}');
      if (!d) return;
      if (d.stale) {
        showPersistentError(t('connection_stale'));
        return;
      }
      if (d.selection === 'journey' || d.selection === 'stationboard') {
        // Transient upstream hiccup for the currently-selected panel.
        // Stay quiet — next tick (≤30s) the data will refresh. A persistent
        // banner here would flap on every short HAFAS blip.
        console.warn('detail-fetch error from server:', d.selection, d.reason);
      }
    } catch (e) {}
  });

  _es.onerror = function () {
    if (!_es || _es.readyState !== 2 /* CLOSED */) return;
    _scheduleReconnect();
  };
}

// === Page-lifecycle orchestration ===
// These two orchestrate the whole page lifecycle, not just the SSE stream:
// the EventSource, the staleness clock (state.lastUpdate), and the geolocation
// watch + dot. Closing the EventSource on pagehide is what makes the page
// bf-cache eligible; _resumeStream rebuilds everything on a bf-restore.

export function _suspendStream() {
  if (_es) {
    try {
      _es.close();
    } catch (e) {}
    _es = null;
  }
  clearTimeout(_reconnectTimer);
  clearTimeout(_viewportTimer);
  _reconnectAttempt = 0;
  _lastForceReconnectAt = 0;
  // Null lastUpdate so the 1s stale-ticker and a trailing visibilitychange
  // can't read a now-ancient timestamp during the reconnect gap and fire a
  // false force-reconnect. The subscribe handler re-seeds it on reopen.
  state.lastUpdate = null;
  stopLocationWatch();
  removeUserLocationMarker();
  // Intentionally does NOT set any SSE error/terminal UI state — a suspend is
  // a clean teardown for bf-cache, not a connection failure.
}

export function _resumeStream() {
  // pagehide→_suspendStream usually reset these already; kept defensively.
  _reconnectAttempt = 0;
  clearTimeout(_reconnectTimer);
  // Re-arm the version banner: the JS heap survives a bf-restore, so a later
  // deploy must still be able to prompt. _appVersion is intentionally NOT
  // reset — a genuine version change is detected against the value we hold.
  state._versionUpdateBannerShown = false;
  startStream();
  startLocationWatch();
}

// pageshow with persisted=false/undefined is a normal load, where init.js
// already starts the stream — no-op so we don't double-start it. Only a
// bf-restore (persisted=true) needs the explicit resume.
window.addEventListener('pagehide', function () {
  _suspendStream();
});
window.addEventListener('pageshow', function (e) {
  if (e.persisted) _resumeStream();
});

document.addEventListener('visibilitychange', function () {
  if (document.visibilityState !== 'visible' || !state.map) return;
  // Resume location tracking on every visible transition, regardless of which
  // SSE branch below runs (incl. the hidden-not-frozen case where the stream
  // stayed open and we return early). startLocationWatch is idempotent — it
  // no-ops if a watch is already active or showLocation is off.
  startLocationWatch();
  // Two recovery paths:
  //   (a) Browser noticed the disconnect — readyState is CLOSED.
  //   (b) Mobile-zombie: the OS suspended the tab long enough for the
  //       server to time out and reap our subscriber, but the
  //       EventSource still reports readyState===OPEN. No `onerror`
  //       fires until the next data event tries to land, which is
  //       never on a dead connection. The user then sees stale buses
  //       and has to pan the map to "fix" it — that pan-triggered
  //       viewport POST 401s and our recovery path kicks in. We catch
  //       it here instead by checking how stale lastUpdate is.
  if (!_es || _es.readyState === 2) {
    _reconnectAttempt = 0;
    clearTimeout(_reconnectTimer);
    startStream();
    return;
  }
  if (state.lastUpdate && Date.now() - state.lastUpdate > _staleThresholdMs()) {
    _forceReconnect('stale-on-visible');
  }
});

// Force a fresh reconnect when the stream is dead-but-claiming-open. The
// cooldown keeps a misdetected "stale" from triggering a reconnect storm
// if the actual problem is upstream (HAFAS slow, server overloaded). A
// single bad detection costs one cycle; the cooldown caps the cost.
let _lastForceReconnectAt = 0;
const FORCE_RECONNECT_COOLDOWN_MS = 15000;

function _forceReconnect(reason) {
  const now = Date.now();
  if (now - _lastForceReconnectAt < FORCE_RECONNECT_COOLDOWN_MS) return;
  _lastForceReconnectAt = now;
  // Every caller (1s ticker, visibilitychange) guards on `_es` being truthy
  // before reaching here, so the else is defensive-only and cannot be hit.
  /* v8 ignore next 5 -- unreachable: all callers guarantee _es is set */
  if (_es) {
    try {
      _es.close();
    } catch (e) {}
    _es = null;
  }
  _reconnectAttempt = 0;
  clearTimeout(_reconnectTimer);
  startStream();
}

// 1s status ticker — independent of network. Same behaviour as before.
// HAFAS pushes vehicles every ~30s tick. If we don't see one for this long
// the stream is effectively dead even when the underlying TCP/EventSource
// thinks it's open — happens when an intermediary (nginx, mobile proxy,
// page.route abort in tests) drops new outgoing fetches but lets the
// existing SSE socket idle. Flip the dot to --offline so the user sees it.
//
// 45s is a generous floor for CALC mode, where the server pushes every
// ~10s so lastUpdate is bumped with wide margin. In REPORT_ONLY ("Nur
// GPS") the server skips 2 of every 3 pushes, so vehicles events arrive
// only every ~30s — that leaves just 15s of slack under a 45s threshold,
// and a single delayed tick (server load, HAFAS latency) would trip a
// false force-reconnect. Widen the threshold to 75s in REPORT_ONLY so the
// staleness detection matches the mode's real cadence.
const STALE_THRESHOLD_CALC_MS = 45000;
const STALE_THRESHOLD_REPORT_ONLY_MS = 75000;
function _staleThresholdMs() {
  return settings.current && settings.current.posMode === 'REPORT_ONLY'
    ? STALE_THRESHOLD_REPORT_ONLY_MS
    : STALE_THRESHOLD_CALC_MS;
}

// Network-loss signal independent of the SSE stream. The browser's offline
// event fires when navigator.onLine flips false (radio off, no carrier),
// which we surface immediately rather than waiting for the SSE socket to
// notice it. The E2E offline-indicator test relies on this signal — for
// the test we synthesize an offline state via a probe further down.
window.addEventListener('offline', function () {
  showPersistentError(t('connection_lost'));
});
window.addEventListener('online', function () {
  // Don't auto-clear; let the next vehicles event paint --live so the user
  // sees data arriving before the indicator goes green.
  if (_es && _es.readyState === 2) {
    _reconnectAttempt = 0;
    clearTimeout(_reconnectTimer);
    startStream();
  } else if (_es && _es.readyState === 1) {
    // Socket survived the offline blip — clear the persistent error
    // banner here so the next vehicles tick can paint --live again.
    // Without this clear, the showPersistentError set on `offline` leaves
    // _errorUntil=Infinity, and updateStatus wedges into early-return on
    // every tick (status.js has a matching safety net for the proxy-stall
    // case where this `online` event never fires).
    clearPersistentError();
  }
});

setInterval(function () {
  if (state._currentStopL && state.selectedJid) {
    ui.updateStopProgress(state._currentStopL);
  }
  if (
    state.serverTimeStamp &&
    state._lastBusCount !== undefined &&
    !(state._errorUntil && Date.now() < state._errorUntil)
  ) {
    const textEl = document.getElementById('status-text');
    if (textEl)
      textEl.textContent = formatStatusText(
        state._lastBusCount,
        state._lastConnectedClients,
        getServerTimeStr(),
      );
  }
  // Stale-stream guard. lastUpdate is bumped by every vehicles event;
  // when it ages past STALE_THRESHOLD_MS we transition the dot to
  // --offline and let the next event clear it. Also reacts to the
  // navigator.onLine flag for instant offline feedback (test scaffold +
  // real-world radio-off scenarios where SSE doesn't immediately error).
  var staleByTime = state.lastUpdate && Date.now() - state.lastUpdate > _staleThresholdMs();
  var offlineByNavigator = typeof navigator !== 'undefined' && navigator.onLine === false;
  if (staleByTime || offlineByNavigator) {
    var dot = document.querySelector('.status-dot');
    if (
      dot &&
      !dot.classList.contains('status-dot--offline') &&
      !dot.classList.contains('status-dot--error')
    ) {
      showPersistentError(t('connection_stale'));
    }
  }
  // Active recovery for the mobile-zombie case: the socket still claims
  // OPEN but no vehicles have arrived for more than a HAFAS tick worth
  // of wall-clock. Reconnect to find out — if HAFAS is genuinely down
  // the new connection 5xxs and the indicator stays red, if the local
  // socket was dead the new connection works and the dot turns green
  // on the next tick. The cooldown stops a confused detection from
  // re-tearing-down a healthy stream every second.
  if (staleByTime && _es && _es.readyState === 1 && !offlineByNavigator) {
    _forceReconnect('stale-timer');
  }
}, 1000);

// Viewport POST — debounced. Called from map.js after moveend/zoomend.
export function notifyViewportChange() {
  clearTimeout(_viewportTimer);
  _viewportTimer = setTimeout(function () {
    if (!_es) {
      // Stream torn down (suspended for bf-cache, or terminal). Only resurrect
      // when the user is actively looking at a VISIBLE page — a straggler
      // moveend on a page heading into the bf-cache freeze must not reopen the
      // EventSource and defeat eligibility. Intentionally does NOT reset
      // _reconnectAttempt (unlike the visibilitychange/online reopens): a pan is
      // high-frequency, and resetting per gesture would restart the full backoff
      // each time; one-shot retry per gesture is enough (subscribe zeroes the
      // counter on success).
      if (document.visibilityState === 'visible') startStream();
      return;
    }
    if (_es.readyState !== 1) return;
    _sendCurrentViewport();
  }, VIEWPORT_DEBOUNCE_MS);
}

// Detects stream-state mismatch from a sidecar POST response (401
// missing-cookie or 409 unknown_connection). Either means the EventSource
// we're holding is no longer paired with a registered subscriber — usually
// because the server restarted (registry empty) or the cookie expired.
// The only recovery: close EventSource, reset reconnect counter, reopen.
// Without this the dot stays offline forever because viewport/select POSTs
// silently fail and no vehicles events arrive.
function _recoverIfBrokenSession(resp) {
  if (resp.status === 401 || resp.status === 409) {
    if (_es) {
      try {
        _es.close();
      } catch (e) {}
      _es = null;
    }
    _reconnectAttempt = 0;
    clearTimeout(_reconnectTimer);
    startStream();
    return true;
  }
  return false;
}

// Build the viewport POST payload from the current map bounds. When following
// a bus the FETCH bbox is widened to a minimum ring so the bus stays in the
// fresh vehicles payload (see the freeze rationale below). Pure/exported for
// tests. Returns null if the map isn't ready.
export function _viewportPayload() {
  if (!state.map) return null;
  const b = state.map.getBounds();
  const sw = b.getSouthWest();
  const ne = b.getNorthEast();
  let swLat = sw.lat,
    swLon = sw.lng,
    neLat = ne.lat,
    neLon = ne.lng;

  // When following a bus, keep the FETCH ring large enough that the bus stays
  // inside it across zoom levels. The server ring ≈ max(span)/2 shrinks with
  // zoom; strongly zoomed in it drops below the distance the bus covers in one
  // tick, so the bus falls off-ring and the follow degrades to the journey
  // detail push — which is cached ~30 s, so the followed position (and the
  // pan) freezes for 30 s at a time. Widening only the fetch bbox (the display
  // still filters to map.getBounds(), so no extra markers appear) keeps the
  // followed bus in the fresh 10 s vehicles payload. Gated on follow so normal
  // panning still fetches exactly the visible viewport.
  if (state.followBus && state.selectedJid) {
    const c = state.map.getCenter();
    const dLat = FOLLOW_MIN_RING_M / 111000;
    const dLon = FOLLOW_MIN_RING_M / (111000 * Math.cos((c.lat * Math.PI) / 180));
    swLat = Math.max(-90, Math.min(swLat, c.lat - dLat));
    neLat = Math.min(90, Math.max(neLat, c.lat + dLat));
    swLon = Math.max(-180, Math.min(swLon, c.lng - dLon));
    neLon = Math.min(180, Math.max(neLon, c.lng + dLon));
  }

  return {
    swLat: swLat,
    swLon: swLon,
    neLat: neLat,
    neLon: neLon,
    posMode: (settings.current && settings.current.posMode) || 'CALC',
  };
}

function _sendCurrentViewport() {
  if (!state.map) return;
  if (!_es || _es.readyState !== 1) {
    // Stream not OPEN — skip. The `subscribe` handler calls us again
    // once the stream comes up, picking up the latest map.getBounds().
    return;
  }
  const payload = _viewportPayload();
  if (window.__busradarVerbose) debugLog('viewport POST', payload);
  window
    .fetch(CONFIG.apiBase + '/stream/viewport', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'same-origin',
    })
    .then(function (resp) {
      _recoverIfBrokenSession(resp);
    })
    .catch(function () {});
}

// Public alias kept so existing callers (init.js URL-restore flow) still work.
// Triggers an immediate viewport resend; the next SSE tick brings fresh data.
export function refresh() {
  _sendCurrentViewport();
}

// Ring-buffered follow-pan decision log for the debug dump. Records every pan
// decision including SKIPS with reason + distance. A "skip:panning" (or
// "skip:navigating") with a LARGE dist is the follow-divergence signature: the
// map was left behind because a pan was in flight while the target moved on.
// Always on; bounded, negligible footprint.
function _flog(action, dist, reason) {
  try {
    var log = state._followLog || (state._followLog = []);
    log.push({ t: Date.now(), action: action, dist: dist, reason: reason || null });
    if (log.length > 120) log.shift();
  } catch (e) {}
}

// Pan the map to keep the followed bus centered. Shared by the vehicles
// handler (in-ring) and the journey handler (viewport-independent, keeps the
// follow working once the bus leaves the ring). No-op if a pan is already in
// flight (_followPanning), during a URL-restore navigation (_navigating), or if
// the target is within 5 m of the current center. Exported for tests.
export function _followPanTo(lat, lon) {
  if (!state.map) return;
  if (lat == null || lon == null) {
    _flog('skip', null, 'nullpos');
    return;
  }
  const target = L.latLng(lat, lon);
  const followDist = Math.round(state.map.getCenter().distanceTo(target));
  // Distance is computed before this guard (unlike the original early-return)
  // so the skip is logged WITH its distance — that's what reveals the
  // divergence (a large-distance skip means the map fell behind the marker).
  if (state._followPanning || state._navigating) {
    _flog('skip', followDist, state._followPanning ? 'panning' : 'navigating');
    return;
  }
  if (followDist <= 5) {
    _flog('skip', followDist, 'near');
    return;
  }
  state._followPanning = true;
  if (followDist > 3000) {
    // Big jump (bus already far off-screen): snap, don't animate across the map.
    state.map.setView(target, state.map.getZoom(), { animate: false });
    state._followPanning = false;
    _flog('setView', followDist);
  } else {
    const panDur = 2; // 2s default pan duration
    state.map.panTo(target, { duration: panDur });
    state.map.once('moveend', function () {
      state._followPanning = false;
    });
    clearTimeout(state._followPanTimeout);
    state._followPanTimeout = setTimeout(
      function () {
        state._followPanning = false;
      },
      panDur * 1000 + 500,
    );
    _flog('panTo', followDist);
  }
}

// === Debug dump ===
// window.busradarDump() returns a complete JSON snapshot for debugging;
// Ctrl+Shift+D copies it to the clipboard. Includes the follow-pan log (above),
// the current marker-vs-map-center offset (the divergence magnitude), the
// selection/follow state, and the captured console tail (debug-console.js).
export function busradarDump() {
  const m = state.map;
  const sel = state.selectedJid && state.vehicles && state.vehicles.get(state.selectedJid);
  let markerInfo = null;
  if (m && sel && sel.marker) {
    try {
      const ml = sel.marker.getLatLng();
      const c = m.getCenter();
      markerInfo = {
        markerLat: +ml.lat.toFixed(6),
        markerLon: +ml.lng.toFixed(6),
        offsetMeters: Math.round(c.distanceTo(ml)), // marker vs map center = divergence
      };
    } catch (e) {}
  }
  let boundsInfo = null;
  if (m) {
    try {
      const b = m.getBounds();
      boundsInfo = {
        swLat: +b.getSouthWest().lat.toFixed(6),
        swLon: +b.getSouthWest().lng.toFixed(6),
        neLat: +b.getNorthEast().lat.toFixed(6),
        neLon: +b.getNorthEast().lng.toFixed(6),
      };
    } catch (e) {}
  }
  const dump = {
    ts: new Date().toISOString(),
    url: location.href,
    appVersion: state._appVersion || null,
    // Browser/environment fingerprint — required to compare dumps across
    // browsers (e.g. LibreWolf vs Brave). Per-field guarded because hardened
    // browsers can make some navigator/Intl reads throw or return undefined.
    env: (function () {
      const g = function (fn) {
        try {
          return fn();
        } catch (e) {
          return null;
        }
      };
      return {
        userAgent: g(() => navigator.userAgent),
        language: g(() => navigator.language),
        languages: g(() => (navigator.languages || []).join(',')),
        platform: g(() => navigator.platform),
        hardwareConcurrency: g(() => navigator.hardwareConcurrency),
        deviceMemory: g(() => navigator.deviceMemory),
        online: g(() => navigator.onLine),
        cookieEnabled: g(() => navigator.cookieEnabled),
        swController: g(() => !!(navigator.serviceWorker && navigator.serviceWorker.controller)),
        visibility: g(() => document.visibilityState),
        timeZone: g(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
        viewportW: g(() => window.innerWidth),
        viewportH: g(() => window.innerHeight),
        dpr: g(() => window.devicePixelRatio),
        screenW: g(() => window.screen.width),
        screenH: g(() => window.screen.height),
      };
    })(),
    mode: (settings.current && settings.current.posMode) || null,
    follow: state.followBus,
    followPanning: state._followPanning,
    navigating: state._navigating,
    selectedJid: state.selectedJid || null,
    endedJid: state._endedJid || null,
    notStartedJid: state._notStartedJid || null,
    hadPosJid: state._selectedHadPosJid || null,
    activeTab: state._activeTab || null,
    tabMode: state._tabMode || null,
    filters: { dep: state._depFilter || null, arr: state._arrFilter || null },
    map: m
      ? {
          centerLat: +m.getCenter().lat.toFixed(6),
          centerLon: +m.getCenter().lng.toFixed(6),
          zoom: m.getZoom(),
          bounds: boundsInfo,
        }
      : null,
    selectedMarker: markerInfo,
    vehiclesCount: state.vehicles ? state.vehicles.size : 0,
    // Every bus currently on the map: jid/line/position/delay plus missedCycles
    // (how many ticks it has been off the server ring) and whether it is the
    // selected one. Lets a dump show which buses were present and where, so a
    // "wrong/missing marker" report is diagnosable without the live map.
    vehicles: (function () {
      try {
        if (!state.vehicles) return [];
        const out = [];
        state.vehicles.forEach(function (v, jid) {
          const d = v.data || {};
          out.push({
            jid: jid,
            line: d.line || null,
            lat: d.lat != null ? +d.lat.toFixed(6) : null,
            lon: d.lon != null ? +d.lon.toFixed(6) : null,
            delay: d.delay != null ? d.delay : null,
            missedCycles: v.missedCycles || 0,
            selected: jid === state.selectedJid,
          });
        });
        return out;
      } catch (e) {
        return [{ error: String(e) }];
      }
    })(),
    // Full trip info — MUST be in every dump so cross-client divergence is
    // diagnosable. Captures both the server-pushed stop data AND what the DOM
    // actually renders, so a state-vs-DOM mismatch (misaligned delay patch) is
    // visible directly, and two clients' dumps can be compared stop-by-stop.
    journey: (function () {
      try {
        const jd = state.selectedJourneyData || {};
        const jny = jd.journey || {};
        const locL = (jd.common && jd.common.locL) || [];
        const dataStops = (jny.stopL || []).map(function (s) {
          const loc = s.locX != null && locL[s.locX] ? locL[s.locX] : {};
          return {
            name: loc.name || null,
            dTimeS: s.dTimeS || null,
            dTimeR: s.dTimeR || null,
            aTimeS: s.aTimeS || null,
            aTimeR: s.aTimeR || null,
          };
        });
        const domStops = [];
        const list = document.getElementById('stop-list');
        if (list) {
          list.querySelectorAll('.stop-item').forEach(function (li) {
            const nm = li.querySelector('.stop-name');
            const tm = li.querySelector('.stop-times');
            const dot = li.querySelector('.stop-dot');
            domStops.push({
              name: nm ? nm.textContent : null,
              times: tm ? tm.textContent.replace(/\s+/g, ' ').trim() : null,
              passed: dot ? dot.classList.contains('stop-dot--passed') : null,
            });
          });
        }
        return {
          hasPos: !!jny.pos,
          renderedStopSig: state._renderedStopSig || null,
          dataStopCount: dataStops.length,
          domStopCount: domStops.length,
          dataStops: dataStops,
          domStops: domStops,
        };
      } catch (e) {
        return { error: String(e) };
      }
    })(),
    // Selected stop + the board the user actually sees. Captures the rendered
    // DEP and ARR rows (condensed text) plus the active board type and windows,
    // so a "wrong/stale departures" report is diagnosable from the dump alone.
    stop: (function () {
      try {
        const s = state.selectedStop;
        if (!s) return null;
        const board = function (listId) {
          const el = document.getElementById(listId);
          if (!el) return null;
          const rows = [];
          el.querySelectorAll('.departure-item').forEach(function (li) {
            rows.push(li.textContent.replace(/\s+/g, ' ').trim());
          });
          return { count: rows.length, rows: rows };
        };
        return {
          lid: s.lid || null,
          name: s.name || null,
          extId: s.extId || null,
          activeBoardType: state._activeStationBoardType || null,
          depDur: state._stationDepDur || null,
          arrDur: state._stationArrDur || null,
          departures: board('departure-list'),
          arrivals: board('arrival-list'),
        };
      } catch (e) {
        return { error: String(e) };
      }
    })(),
    followLog: (state._followLog || []).slice(-120),
    // Full console ring (always-on capture) — the dump must carry the complete
    // session output, independent of the on-screen overlay's Clear/scroll state.
    consoleTail: (window.__busradarConsoleTail || []).slice(),
  };
  return JSON.stringify(dump, null, 2);
}

export function _copyDump() {
  const text = busradarDump();
  const report = function (ok) {
    console.log(
      '[dump] ' +
        (ok ? 'copied to clipboard' : 'clipboard unavailable — full JSON below') +
        ' (' +
        text.length +
        ' chars)',
    );
    if (!ok) console.log(text);
  };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () {
          report(true);
        },
        function () {
          report(false);
        },
      );
    } else {
      report(false);
    }
  } catch (e) {
    report(false);
  }
}

// Download the dump as a .json file. A file is easier to hand over than a
// clipboard paste for a large dump. The anchor must be attached to the DOM
// before .click() for the download to fire in some browsers, and the object
// URL is revoked on a delay because an immediate revoke can abort the download.
// Falls back to the clipboard copy if Blob/URL/anchor is unavailable.
export function busradarDownloadDump() {
  const text = busradarDump();
  try {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'busradar-dump-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () {
      try {
        URL.revokeObjectURL(url);
      } catch (e) {}
    }, 10000);
    console.log('[dump] download triggered (' + text.length + ' chars)');
  } catch (e) {
    console.warn('[dump] download failed, falling back to clipboard copy:', e);
    _copyDump();
  }
}

// The module registers window listeners at load-time above, so it cannot run
// without a window; this typeof-guard's else is dead SSR-defensive code.
/* v8 ignore next -- unreachable: module already used window at load */
if (typeof window !== 'undefined') {
  window.busradarDump = busradarDump;
  window.busradarCopyDump = _copyDump;
  window.busradarDownloadDump = busradarDownloadDump;
  window.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
      e.preventDefault();
      _copyDump();
    }
  });
}

// === Vehicle-payload handler ===
// Receives `vehicles` SSE events. Updates markers, status, follow-bus pan,
// and triggers URL-restore on first delivery. Detail-panel updates flow
// through the dedicated `journey`/`stationboard` SSE handlers — no per-tick
// polling here.
function _handleVehiclesPayload(data) {
  const capturedInteractionSeq = state._userInteractionSeq;
  const vehicles = data.vehicles || [];

  // Note: no upstream bbox-filter here. markers.updateAll() applies the
  // map-bounds check itself so it can distinguish "still in HAFAS ring,
  // just out of viewport" (remove immediately) from "gone from server"
  // (grace-period). Filtering upstream collapsed the two cases and
  // froze the marker at its last visible position for a full grace
  // window when a bus drove off-screen.

  if (data.serverTime) {
    const sh = parseInt(data.serverTime.slice(0, 2), 10);
    const sm = parseInt(data.serverTime.slice(2, 4), 10);
    let ss = data.serverTime.length >= 6 ? parseInt(data.serverTime.slice(4, 6), 10) : 0;
    if (isNaN(ss)) ss = 0;
    if (!isNaN(sh) && !isNaN(sm)) {
      const newMin = sh * 60 + sm + ss / 60;
      const oldDisplayMin =
        state.serverTimeMin != null
          ? state.serverTimeMin + (Date.now() - state.serverTimeStamp) / 60000
          : -1;
      if (newMin >= oldDisplayMin - 0.05 || oldDisplayMin < 0) {
        state.serverTimeMin = newMin;
        state.serverTimeStamp = Date.now();
      }
    }
  }

  // `appVersion` is still carried on vehicle frames (for tabs that joined
  // mid-deploy and missed the `subscribe` event).
  _maybeUpdateAppVersion(data.appVersion);

  markers.updateAll(vehicles);
  stopsLayer.update(vehicles);
  // The user-location dot is driven by a geolocation watchPosition
  // (map.js:startLocationWatch), not by the tick, so it tracks movement
  // independently of the SSE cadence and posMode. Previously it refreshed
  // here every 3rd tick, which in REPORT_ONLY mode (vehicles events only
  // every ~30s) compounded to a ~3-minute effective dot update.
  // markers.updateAll exposes the in-bbox count it just rendered; using
  // that keeps the status counter aligned with the actual marker set on
  // screen (vehicles.length would include the ring-but-not-bbox tail).
  const visibleCount =
    markers._lastVisibleCount != null ? markers._lastVisibleCount : vehicles.length;
  updateStatus(visibleCount, data.dataAge, state._lastConnectedClients);

  if (state.followBus && state.selectedJid) {
    const followEntry = state.vehicles.get(state.selectedJid);
    if (!followEntry) {
      // Selected bus is exempt from removal, so this is rare; if it truly
      // vanished and isn't a not-yet-started journey, stop following.
      if (!state._notStartedJid) ui._disableFollow();
    } else if (followEntry.missedCycles === 0) {
      // Bus is in the ring — pan to its vehicles-payload position (smooth,
      // carries bearing). When the bus leaves the ring/viewport it drops to
      // missedCycles>0 here and this pan is skipped; the `journey` SSE handler
      // then drives the pan from the viewport-independent journey position, so
      // the map keeps following the bus OFF-screen. (The ring is only ~viewport
      // sized: max_dist = max(span)/2, so a bus leaving the viewport leaves the
      // ring almost immediately.)
      _followPanTo(followEntry.data.lat, followEntry.data.lon);
    }
  }

  if (state._pendingRestore && state._userInteractionSeq === capturedInteractionSeq) {
    const pr = state._pendingRestore;
    state._pendingRestore = null;
    try {
      if (pr.jid) {
        ui.focusJourneyById(pr.jid, {}, true);
        if (pr.follow === '1') {
          state.followBus = true;
          ui._updateFollowButton();
          ui._updateFollowUrl();
        }
      } else if (pr.stop) {
        let stopEntry = null;
        state.allStops.forEach(function (s) {
          if (s.data.extId === pr.stop) stopEntry = s.data;
        });
        // SEC-100: extId MUST be digits-only before LID concat
        if (!stopEntry && /^\d+$/.test(pr.stop)) {
          stopEntry = {
            name: '',
            lid: 'A=1@L=' + pr.stop + '@',
            lat: 0,
            lon: 0,
            extId: pr.stop,
            platform: '',
          };
        }
        if (stopEntry) {
          ui.showStationBoard(stopEntry, true);
          if (pr.tab === 'arr') ui.switchTab('arrivals');
        }
      }
    } finally {
      state._restoreInProgress = false;
    }
  } else {
    state._restoreInProgress = false;
  }

  // Transition out of "not-started" once the bus appears in BBox. The journey
  // SSE event drives further detail updates from there.
  try {
    if (state.selectedJid && state._notStartedJid && state.vehicles.get(state.selectedJid)) {
      const transVehicle = state.vehicles.get(state.selectedJid);
      state._notStartedJid = null;
      state._notStartedSince = 0;
      state._notStartedLastPoll = 0;
      ui.detailLine.textContent = transVehicle.data.lineFull || transVehicle.data.line;
      ui.detailDir.textContent = transVehicle.data.direction;
      const ja = document.getElementById('journey-actions');
      if (ja) ja.hidden = false;
      if (state.selectedJourneyData) {
        ui.renderJourneyStops(state.selectedJourneyData, transVehicle.data);
        state._currentStopL = (state.selectedJourneyData.journey || {}).stopL || [];
      }
      announce(t('journey_started_announce', { line: transVehicle.data.line }));
    }

    // Delay badge updates when the bus reappears in BBox per tick. The full
    // journey panel is rendered from the `journey` SSE event, not here.
    if (state.selectedJid && state.selectedJourneyData) {
      const selectedVehicle = state.vehicles.get(state.selectedJid);
      if (selectedVehicle) {
        const cls = getDelayClass(selectedVehicle.data.delay);
        ui.detailDelay.textContent = getDelayText(selectedVehicle.data.delay);
        ui.detailDelay.className = 'detail-delay-badge detail-delay-badge--' + cls;
      }
    }
  } catch (e) {
    console.warn('Panel update error:', e);
  }

  if (vehicles.length === 0) {
    announce(t('no_buses'));
  }
}

// Apply a server-pushed journey payload to the detail panel. Shared by the
// `journey` SSE event handler and by the not-started/journey-ended branch
// below. Handles three cases:
//   1. Position present       → update marker + draw route + delays
//   2. Position absent, route ended (last stop time elapsed) → showJourneyEnded
//   3. Position absent, route still upcoming → mark as not-started, keep panel
// Exported (underscore-prefixed) so the test suite can drive each branch
// without setting up an EventSource mock.
export function _applyJourneyPayload(jid, journeyData) {
  state.selectedJourneyData = journeyData;
  const journey = journeyData.journey || {};
  state._currentStopL = journey.stopL || [];

  const jPos = journey.pos || {};
  const jLat = jPos.y ? jPos.y / 1e6 : null;
  const jLon = jPos.x ? jPos.x / 1e6 : null;

  if (jLat != null && jLon != null) {
    // This journey is live — remember it so a later loss of position is
    // recognised as "ended" rather than "not started" (see the no-pos branch).
    state._selectedHadPosJid = jid;
    const sv = state.vehicles.get(jid);
    // Capture the ring status BEFORE the missedCycles reset below. In-ring
    // (missedCycles === 0, incl. off-bbox-but-in-ring) the vehicles handler
    // already follow-pans to the REAL position; only when the bus is off the
    // server ring (missedCycles > 0, or gone from the map) may the journey
    // position drive the pan.
    const busOffRing = !sv || sv.missedCycles > 0;
    if (sv) {
      if (sv.missedCycles > 0) {
        sv.data.lat = jLat;
        sv.data.lon = jLon;
        sv.marker.setLatLng([jLat, jLon]);
        sv.missedCycles = 0;
      }
      ui.updateJourneyStopDelays(journeyData);
      ui.drawRoute(journeyData, sv.data);
    } else {
      // Bus has pos but isn't in BBox (user panned away). Still update the
      // panel from the server-pushed data.
      ui.updateJourneyStopDelays(journeyData);
    }
    // Follow-bus: drive the pan from the journey position ONLY when the bus is
    // off the ring. In-ring the vehicles handler owns the pan with the REAL
    // GPS position; letting the (interpolated, in REPORT_ONLY) journey position
    // also pan made the map jump between the real and interpolated positions —
    // the vehicles pan is a no-op within 5 m (no guard set) or a guard-clearing
    // setView on a big jump, either of which let the interpolated journey pan
    // slip through. Off-ring the journey position is the only follow source
    // (real via the REPORT_ONLY GeoPos splice, interpolated on splice-miss).
    if (state.followBus && state.selectedJid === jid && busOffRing) {
      _followPanTo(jLat, jLon);
    }
    return;
  }

  // No position in this push. Compute the last-stop time once (Ist-time, so
  // delay-aware); both branches below use it.
  const stopL = journey.stopL || [];
  const lastStop = stopL.length > 0 ? stopL[stopL.length - 1] : null;
  const lastTime = lastStop
    ? lastStop.aTimeR || lastStop.aTimeS || lastStop.dTimeR || lastStop.dTimeS || ''
    : '';
  let lastMin = lastTime ? parseHafasTimeToMin(lastTime) : 0;
  if (lastMin === null) lastMin = 0;
  const elMs = state.serverTimeStamp ? Date.now() - state.serverTimeStamp : 0;
  const nowM = (state.serverTimeMin || 0) + elMs / 60000;
  if (nowM > 1080 && lastMin < 360) lastMin += 1440;
  if (nowM < 360 && lastMin > 1080) lastMin -= 1440;

  if (journey.isCncl) {
    if (ui._showJourneyCancelled) ui._showJourneyCancelled();
    return;
  }

  // A journey that was LIVE this selection (had a position) and now has none
  // has ENDED once its last stop time has passed. Until then it is still en
  // route but momentarily without a live position (near the terminus, or a GPS
  // gap like a tunnel) — keep the panel as-is: do NOT flip to "not started"
  // (the stale kept vehicle would flip it back to "running", so it never showed
  // as ended, the reported regression) and do NOT wipe the stop list (which
  // would leave a broken panel if the position returns). Using the schedule
  // time as the discriminator means a mid-route GPS gap is never mistaken for
  // an ended journey. +1 min slop past the (delay-aware) last stop absorbs
  // clock skew.
  if (state._selectedHadPosJid === jid) {
    if (lastTime && lastMin + 1 <= nowM) {
      ui.showJourneyEnded();
    } else {
      ui.updateJourneyStopDelays(journeyData);
    }
    return;
  }

  // Journey we never saw live (selected after it ended, or not yet started).
  // More conservative "last stop + 5 min" rule since we have no live-history.
  if (lastTime && lastMin + 5 <= nowM) {
    ui.showJourneyEnded();
    return;
  }
  // Otherwise: not started yet. Mark the jid so _handleVehiclesPayload can
  // transition once the bus appears in BBox.
  if (!state._notStartedJid || state._notStartedJid !== jid) {
    state._notStartedJid = jid;
    if (!state._notStartedSince) state._notStartedSince = Date.now();
  }
  ui.updateJourneyStopDelays(journeyData);
}
