import { CONFIG } from './config.js';
import { state, settings, t, getDelayClass, getDelayText, parseHafasTimeToMin } from './state.js';
import { api } from './api.js';
import { markers, stopsLayer, setUserLocationMarker } from './map.js';
import { ui } from './ui.js';
import { updateStatus, getServerTimeStr, showError, showPersistentError, clearPersistentError, announce, formatStatusText } from './status.js';

// Re-export for init.js and other consumers
export { updateStatus, getServerTimeStr, showError, showPersistentError, clearPersistentError, announce };

// === SSE event-stream driver ===
// Polling is gone. We hold one EventSource open for the lifetime of the tab,
// reconnect with a small backoff sequence on drop, and POST viewport updates
// when the user pans/zooms. Reconnect is capped at 5 cycles; after that we
// surface a terminal banner with a manual reload button instead of looping
// forever.

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 15000, 15000];
const VIEWPORT_DEBOUNCE_MS = 250;
const REGEX_VERSION = /^[A-Za-z0-9._+\-]{1,64}$/;
// The protocol version the client speaks. Must match the server's
// `subscribe` event payload — mismatch means the deployed app and the
// running tab are incompatible and the user must reload.
const SSE_PROTOCOL_VERSION = '1';

let _es = null;
let _reconnectAttempt = 0;
let _reconnectTimer = null;
let _viewportTimer = null;
let _gotFirstSubscribe = false;

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
      s === 'failed-terminal' ? t('connection_lost_terminal') : t('connection_lost')
    );
  } else if (s === 'open') {
    clearPersistentError();
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
  if (_es) { try { _es.close(); } catch (e) {} _es = null; }
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
  _setSseState('reconnecting');
  clearTimeout(_reconnectTimer);
  _reconnectTimer = setTimeout(function () { startStream(); }, delay);
}

export function startStream() {
  if (_es) { try { _es.close(); } catch (e) {} _es = null; }
  _gotFirstSubscribe = false;
  _setSseState('connecting');
  try {
    _es = new EventSource(CONFIG.apiBase + '/stream/');
  } catch (e) {
    _onTerminal();
    return;
  }

  _es.addEventListener('subscribe', function (ev) {
    _gotFirstSubscribe = true;
    _reconnectAttempt = 0;
    _setSseState('open');
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
        try { _es.close(); } catch (e) {}
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
    try { data = JSON.parse(ev.data); } catch (e) { return; }
    _handleVehiclesPayload(data);
  });

  _es.addEventListener('journey', function (ev) {
    // The server pushes the currently-selected journey on every tick. Drop
    // the event if the user has since selected a different jid or closed
    // the panel — the server filters on its end too, but a late-delivered
    // payload still has to be filtered client-side.
    let data;
    try { data = JSON.parse(ev.data); } catch (e) { return; }
    if (!data || !data.jid) return;
    if (state.selectedJid !== data.jid) return;
    const journeyData = data.journey;
    if (!journeyData) return;
    _applyJourneyPayload(data.jid, journeyData);
  });

  _es.addEventListener('stationboard', function (ev) {
    // The server pushes the selected stop's board on every tick. Board-type
    // (DEP or ARR) follows the user's current tab; the payload includes a
    // `boardType` field so the client renders the right list.
    let data;
    try { data = JSON.parse(ev.data); } catch (e) { return; }
    if (!data || !data.lid) return;
    if (!state.selectedStop || state.selectedStop.lid !== data.lid) return;
    try {
      ui.applyPushedStationboard(state.selectedStop, data.stationboard || {}, data.boardType || 'DEP');
    } catch (e) { console.warn('stationboard SSE handler:', e); }
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

document.addEventListener('visibilitychange', function () {
  if (document.visibilityState !== 'visible' || !state.map) return;
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
  if (state.lastUpdate && Date.now() - state.lastUpdate > STALE_THRESHOLD_MS) {
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
  if (_es) { try { _es.close(); } catch (e) {} _es = null; }
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
// 45s is a generous floor: HAFAS ticks ~30s, and the first tick on a fresh
// stream can be up to one tick away (so worst-case 30s + slack). At 45s we
// flag a stale stream without flapping on normal tick-to-tick latency.
const STALE_THRESHOLD_MS = 45000;

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
  if (state.serverTimeStamp && state._lastBusCount !== undefined && !(state._errorUntil && Date.now() < state._errorUntil)) {
    const textEl = document.getElementById('status-text');
    if (textEl) textEl.textContent = formatStatusText(state._lastBusCount, state._lastConnectedClients, getServerTimeStr());
  }
  // Stale-stream guard. lastUpdate is bumped by every vehicles event;
  // when it ages past STALE_THRESHOLD_MS we transition the dot to
  // --offline and let the next event clear it. Also reacts to the
  // navigator.onLine flag for instant offline feedback (test scaffold +
  // real-world radio-off scenarios where SSE doesn't immediately error).
  var staleByTime = state.lastUpdate && Date.now() - state.lastUpdate > STALE_THRESHOLD_MS;
  var offlineByNavigator = typeof navigator !== 'undefined' && navigator.onLine === false;
  if (staleByTime || offlineByNavigator) {
    var dot = document.querySelector('.status-dot');
    if (dot && !dot.classList.contains('status-dot--offline') && !dot.classList.contains('status-dot--error')) {
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
    if (!_es || _es.readyState !== 1) {
      // Stream not OPEN yet (connecting/reconnecting). Skip the POST; the
      // next `subscribe` handler unconditionally calls
      // _sendCurrentViewport() so the freshest bounds reach the server
      // once the stream comes up.
      return;
    }
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
    if (_es) { try { _es.close(); } catch (e) {} _es = null; }
    _reconnectAttempt = 0;
    clearTimeout(_reconnectTimer);
    startStream();
    return true;
  }
  return false;
}

function _sendCurrentViewport() {
  if (!state.map) return;
  if (!_es || _es.readyState !== 1) {
    // Stream not OPEN — skip. The `subscribe` handler calls us again
    // once the stream comes up, picking up the latest map.getBounds().
    return;
  }
  const b = state.map.getBounds();
  const sw = b.getSouthWest();
  const ne = b.getNorthEast();
  const payload = {
    swLat: sw.lat,
    swLon: sw.lng,
    neLat: ne.lat,
    neLon: ne.lng,
    posMode: settings.current && settings.current.posMode || 'CALC',
  };
  window.fetch(CONFIG.apiBase + '/stream/viewport', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    credentials: 'same-origin',
  }).then(function (resp) {
    _recoverIfBrokenSession(resp);
  }).catch(function () {});
}

// Public alias kept so existing callers (init.js URL-restore flow) still work.
// Triggers an immediate viewport resend; the next SSE tick brings fresh data.
export function refresh() {
  _sendCurrentViewport();
}

// GPS-dot refresh, throttled to ~30 s cadence. In v1.0.0 the polling loop
// drove this at the poll rate. v1.1.1 restored it on every SSE tick, but
// the v1.2.0 push cadence dropped to 10 s and firing getCurrentPosition
// with enableHighAccuracy every 10 s hammers mobile-device GPS + battery.
// Throttle back to every 3rd tick (~30 s effective) which matches the
// original polling cadence — the dot doesn't need more precision than
// the underlying GPS-hardware update rate anyway.
var _gpsRefreshTickCounter = 0;
export function _maybeRefreshUserLocation() {
  if (!settings.current.showLocation) return;
  if (!navigator.geolocation) return;
  _gpsRefreshTickCounter++;
  if (_gpsRefreshTickCounter % 3 !== 1) return;  // 1, 4, 7, ... ≈ every 30 s
  navigator.geolocation.getCurrentPosition(function (pos) {
    setUserLocationMarker(pos.coords.latitude, pos.coords.longitude);
  }, function () {}, { enableHighAccuracy: true, timeout: 5000, maximumAge: 30000 });
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
      const oldDisplayMin = state.serverTimeMin != null
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
  _maybeRefreshUserLocation();
  // markers.updateAll exposes the in-bbox count it just rendered; using
  // that keeps the status counter aligned with the actual marker set on
  // screen (vehicles.length would include the ring-but-not-bbox tail).
  const visibleCount = markers._lastVisibleCount != null
    ? markers._lastVisibleCount
    : vehicles.length;
  updateStatus(visibleCount, data.dataAge, state._lastConnectedClients);

  if (state.followBus && state.selectedJid) {
    const followEntry = state.vehicles.get(state.selectedJid);
    if (!followEntry) {
      // Bus disappeared from BBox. The journey SSE event handles position
      // correction when the bus is selected; if not selected, nothing to do.
      if (!state._notStartedJid) ui._disableFollow();
    } else if (followEntry.missedCycles === 0
               && !state._followPanning && !state._navigating) {
      // Bus is visible — pan to it. Missed-cycles correction happens in the
      // `journey` SSE handler from server-pushed position data.
      const target = L.latLng(followEntry.data.lat, followEntry.data.lon);
      const current = state.map.getCenter();
      const followDist = current.distanceTo(target);
      if (followDist > 5) {
        state._followPanning = true;
        if (followDist > 3000) {
          state.map.setView(target, state.map.getZoom(), { animate: false });
          state._followPanning = false;
        } else {
          const panDur = 2;  // 2s default pan duration
          state.map.panTo(target, { duration: panDur });
          state.map.once('moveend', function () { state._followPanning = false; });
          clearTimeout(state._followPanTimeout);
          state._followPanTimeout = setTimeout(function () { state._followPanning = false; }, (panDur * 1000) + 500);
        }
      }
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
          stopEntry = { name: '', lid: 'A=1@L=' + pr.stop + '@', lat: 0, lon: 0, extId: pr.stop, platform: '' };
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
    const sv = state.vehicles.get(jid);
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
    return;
  }

  // No position. Either the journey ended, or it hasn't started yet.
  const stopL = journey.stopL || [];
  const lastStop = stopL.length > 0 ? stopL[stopL.length - 1] : null;
  const lastTime = lastStop ? (lastStop.aTimeR || lastStop.aTimeS || lastStop.dTimeR || lastStop.dTimeS || '') : '';
  let lastMin = lastTime ? parseHafasTimeToMin(lastTime) : 0;
  if (lastMin === null) lastMin = 0;
  const elMs = state.serverTimeStamp ? (Date.now() - state.serverTimeStamp) : 0;
  const nowM = (state.serverTimeMin || 0) + elMs / 60000;
  if (nowM > 1080 && lastMin < 360) lastMin += 1440;
  if (nowM < 360 && lastMin > 1080) lastMin -= 1440;

  if (lastTime && (lastMin + 5) <= nowM) {
    ui.showJourneyEnded();
    return;
  }
  if (journey.isCncl) {
    if (ui._showJourneyCancelled) ui._showJourneyCancelled();
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
