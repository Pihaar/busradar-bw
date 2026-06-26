import { CONFIG } from './config.js';
import { state, settings, t, getDelayClass, getDelayText, parseHafasTimeToMin } from './state.js';
import { api } from './api.js';
import { markers, stopsLayer } from './map.js';
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

let _es = null;
let _reconnectAttempt = 0;
let _reconnectTimer = null;
let _viewportTimer = null;
let _gotFirstSubscribe = false;
// True if the user moved/zoomed the map while the stream was not yet OPEN.
// The next `subscribe` event will flush a viewport POST; without this flag,
// pans during reconnect/connecting are silently dropped.
let _pendingViewportSend = false;

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

  _es.addEventListener('error', function (ev) {
    // Server-emitted `error` SSE event (stale-on-upstream-fail). Browser-level
    // network errors do NOT come through addEventListener('error', ...); those
    // land on _es.onerror below.
    try {
      const d = JSON.parse(ev.data || '{}');
      if (d && d.stale) showPersistentError(t('connection_stale'));
    } catch (e) {}
  });

  _es.onerror = function () {
    if (!_es || _es.readyState !== 2 /* CLOSED */) return;
    _scheduleReconnect();
  };
}

document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible' && state.map) {
    if (!_es || _es.readyState === 2) {
      _reconnectAttempt = 0;
      clearTimeout(_reconnectTimer);
      startStream();
    }
  }
});

// 1s status ticker — independent of network. Same behaviour as before.
setInterval(function () {
  if (state._currentStopL && state.selectedJid) {
    ui.updateStopProgress(state._currentStopL);
  }
  if (state.serverTimeStamp && state._lastBusCount !== undefined && !(state._errorUntil && Date.now() < state._errorUntil)) {
    const textEl = document.getElementById('status-text');
    if (textEl) textEl.textContent = formatStatusText(state._lastBusCount, state._lastConnectedClients, getServerTimeStr());
  }
}, 1000);

// Viewport POST — debounced. Called from map.js after moveend/zoomend.
export function notifyViewportChange() {
  clearTimeout(_viewportTimer);
  _viewportTimer = setTimeout(function () {
    if (!_es || _es.readyState !== 1) {
      // Stream not OPEN yet (connecting/reconnecting). Remember that the
      // viewport changed; the next `subscribe` event will flush it.
      _pendingViewportSend = true;
      return;
    }
    _sendCurrentViewport();
  }, VIEWPORT_DEBOUNCE_MS);
}

function _sendCurrentViewport() {
  if (!state.map) return;
  if (!_es || _es.readyState !== 1) {
    _pendingViewportSend = true;
    return;
  }
  _pendingViewportSend = false;
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
  }).catch(function () {});
}

// Public alias kept so existing callers (init.js URL-restore flow) still work.
// Triggers an immediate viewport resend; the next SSE tick brings fresh data.
export function refresh() {
  _sendCurrentViewport();
}

// === Vehicle-payload handler ===
// Extracted from the old polling success branch. Everything below was the
// .then() body of the previous refresh() implementation; the EventSource just
// drives the same downstream code paths.
function _handleVehiclesPayload(data) {
  const capturedInteractionSeq = state._userInteractionSeq;
  const vehicles = data.vehicles || [];

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
  updateStatus(vehicles.length, data.dataAge, state._lastConnectedClients);

  let _followHandledMissed = false;
  if (state.followBus && state.selectedJid) {
    const followEntry = state.vehicles.get(state.selectedJid);
    if (!followEntry) {
      if (!state._notStartedJid) ui._disableFollow();
    } else if (followEntry.missedCycles > 0) {
      _followHandledMissed = true;
      const followSeq = ++state._journeyReqSeq;
      const followJid = state.selectedJid;
      api.getJourney(followJid).then(function (jData) {
        if (state._journeyReqSeq !== followSeq || state.selectedJid !== followJid) return;
        const jp = (jData.journey || {}).pos || {};
        const fLat = jp.y ? jp.y / 1e6 : null;
        const fLon = jp.x ? jp.x / 1e6 : null;
        if (fLat && fLon) {
          followEntry.data.lat = fLat;
          followEntry.data.lon = fLon;
          followEntry.marker.setLatLng([fLat, fLon]);
          followEntry.missedCycles = 0;
          state.selectedJourneyData = jData;
          state._currentStopL = (jData.journey || {}).stopL || [];
          if (!state._followPanning) {
            state._followPanning = true;
            state.map.setView([fLat, fLon], state.map.getZoom(), { animate: false });
            state._followPanning = false;
          }
        }
      }).catch(function () {});
    } else if (!state._followPanning && !state._navigating) {
      const target = L.latLng(followEntry.data.lat, followEntry.data.lon);
      const current = state.map.getCenter();
      const followDist = current.distanceTo(target);
      if (followDist > 5) {
        state._followPanning = true;
        if (followDist > 3000) {
          state.map.setView(target, state.map.getZoom(), { animate: false });
          state._followPanning = false;
        } else {
          const panDur = Math.min(2, 2);  // 2s default pan duration
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

    if (state.selectedJid && state.selectedJourneyData && !_followHandledMissed) {
      const selectedVehicle = state.vehicles.get(state.selectedJid);
      if (selectedVehicle) {
        const cls = getDelayClass(selectedVehicle.data.delay);
        ui.detailDelay.textContent = getDelayText(selectedVehicle.data.delay);
        ui.detailDelay.className = 'detail-delay-badge detail-delay-badge--' + cls;

        const seq2 = ++state._journeyReqSeq;
        const capturedJid = state.selectedJid;
        api.getJourney(capturedJid).then(function (journeyData) {
          if (state._journeyReqSeq !== seq2) return;
          if (state.selectedJid !== capturedJid) return;
          state.selectedJourneyData = journeyData;
          state._currentStopL = (journeyData.journey || {}).stopL || [];
          const jPos = (journeyData.journey || {}).pos || {};
          const jLat = jPos.y ? jPos.y / 1e6 : null;
          const jLon = jPos.x ? jPos.x / 1e6 : null;
          if (!jLat || !jLon) {
            const jStopL = (journeyData.journey || {}).stopL || [];
            const jLastStop = jStopL.length > 0 ? jStopL[jStopL.length - 1] : null;
            const jLastTime = jLastStop ? (jLastStop.aTimeR || jLastStop.aTimeS || jLastStop.dTimeR || jLastStop.dTimeS || '') : '';
            let jLastMin = jLastTime ? parseHafasTimeToMin(jLastTime) : 0;
            if (jLastMin === null) jLastMin = 0;
            const elMs2 = state.serverTimeStamp ? (Date.now() - state.serverTimeStamp) : 0;
            const nowM2 = (state.serverTimeMin || 0) + elMs2 / 60000;
            if (nowM2 > 1080 && jLastMin < 360) jLastMin += 1440;
            if (nowM2 < 360 && jLastMin > 1080) jLastMin -= 1440;
            if (jLastTime && (jLastMin + 5) <= nowM2) {
              ui.showJourneyEnded();
            } else if (!state.vehicles.get(capturedJid)) {
              if (state._notStartedJid === capturedJid) return;
              ui.showJourneyEnded();
            } else {
              ui.updateJourneyStopDelays(journeyData);
            }
            return;
          }
          const sv = state.vehicles.get(state.selectedJid);
          if (sv) {
            if (sv.missedCycles > 0) {
              sv.data.lat = jLat;
              sv.data.lon = jLon;
              sv.marker.setLatLng([jLat, jLon]);
              sv.missedCycles = 0;
            }
            ui.updateJourneyStopDelays(journeyData);
            ui.drawRoute(journeyData, sv.data);
          }
        }).catch(function () {});
      } else if (state._notStartedJid === state.selectedJid) {
        const now = Date.now();
        if (now - state._notStartedSince > 30 * 60 * 1000) {
          state._notStartedJid = null;
          state._notStartedSince = 0;
          state._notStartedLastPoll = 0;
          const expLi = document.createElement('li');
          expLi.className = 'empty-state';
          expLi.textContent = t('journey_poll_expired');
          ui.stopList.replaceChildren(expLi);
        } else if (now - state._notStartedLastPoll >= 30000) {
          state._notStartedLastPoll = now;
          const seq3 = ++state._journeyReqSeq;
          const pollJid = state._notStartedJid;
          api.getJourney(pollJid).then(function (jData) {
            if (state._journeyReqSeq !== seq3) return;
            if (state.selectedJid !== pollJid || state._notStartedJid !== pollJid) return;
            const j = jData.journey || {};
            if (j.isCncl) { ui._showJourneyCancelled(); return; }
            const pos = j.pos || {};
            const pLat = pos.y ? pos.y / 1e6 : null;
            const pLon = pos.x ? pos.x / 1e6 : null;
            if (pLat && pLon) { ui._transitionToRunning(jData); }
          }).catch(function () {});
        }
      } else {
        state._journeyGoneCycles = (state._journeyGoneCycles || 0) + 1;
        if (state._journeyGoneCycles >= 2) {
          state._journeyGoneCycles = 0;
          const goneSeq = ++state._journeyReqSeq;
          const goneJid = state.selectedJid;
          api.getJourney(goneJid).then(function (jData) {
            if (state._journeyReqSeq !== goneSeq) return;
            if (state.selectedJid !== goneJid) return;
            const gJ = jData.journey || {};
            const gPos = gJ.pos || {};
            const gLat = gPos.y ? gPos.y / 1e6 : null;
            const gLon = gPos.x ? gPos.x / 1e6 : null;
            if (gLat && gLon) {
              state.selectedJourneyData = jData;
              state._currentStopL = gJ.stopL || [];
              ui.updateJourneyStopDelays(jData);
              ui.drawRoute(jData, { jid: goneJid, lat: gLat, lon: gLon });
              return;
            }
            const gStopL = gJ.stopL || [];
            const gLastStop = gStopL.length > 0 ? gStopL[gStopL.length - 1] : null;
            const gLastTime = gLastStop ? (gLastStop.aTimeR || gLastStop.aTimeS || gLastStop.dTimeR || gLastStop.dTimeS || '') : '';
            let gLastMin = gLastTime ? parseHafasTimeToMin(gLastTime) : 0;
            if (gLastMin === null) gLastMin = 0;
            const gElMs = state.serverTimeStamp ? (Date.now() - state.serverTimeStamp) : 0;
            const gNowM = (state.serverTimeMin || 0) + gElMs / 60000;
            if (gNowM > 1080 && gLastMin < 360) gLastMin += 1440;
            if (gNowM < 360 && gLastMin > 1080) gLastMin -= 1440;
            if (gLastTime && (gLastMin + 5) <= gNowM) {
              ui.showJourneyEnded();
            } else {
              state._notStartedJid = goneJid;
              if (!state._notStartedSince) state._notStartedSince = Date.now();
              state._notStartedLastPoll = Date.now();
            }
          }).catch(function () {});
        }
      }
    }

    if (state.selectedStop) {
      ui.refreshStationBoard(state.selectedStop);
    }
  } catch (e) {
    console.warn('Panel update error:', e);
  }

  if (vehicles.length === 0) {
    announce(t('no_buses'));
  }
}
