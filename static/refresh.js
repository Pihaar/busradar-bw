import { CONFIG } from './config.js';
import { state, settings, t, getDelayClass, getDelayText, parseHafasTimeToMin, BACKOFF_BASE } from './state.js';
import { api } from './api.js';
import { markers, stopsLayer } from './map.js';
import { ui } from './ui.js';
import { updateStatus, getServerTimeStr, showError, showPersistentError, clearPersistentError, announce, formatStatusText } from './status.js';

// Re-export for init.js and other consumers
export { updateStatus, getServerTimeStr, showError, showPersistentError, clearPersistentError, announce };

// === REFRESH LOOP ===
export function scheduleRefresh(delay) {
  if (state.refreshTimeout) {
    clearTimeout(state.refreshTimeout);
  }
  state.refreshTimeout = setTimeout(refresh, delay !== undefined ? delay : state.currentInterval);
}

document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible' && state.map) {
    state.isLoading = false;
    state._forceRefresh = true;
    state.vehicles.forEach(function(entry) {
      if (entry._animFrame) {
        cancelAnimationFrame(entry._animFrame);
        entry._animFrame = null;
      }
    });
    scheduleRefresh(0);
  }
});

setInterval(function() {
  if (state._currentStopL && state.selectedJid) {
    ui.updateStopProgress(state._currentStopL);
  }
  if (state.serverTimeStamp && state._lastBusCount !== undefined && !(state._errorUntil && Date.now() < state._errorUntil)) {
    var text = document.getElementById('status-text');
    text.textContent = formatStatusText(state._lastBusCount, state._lastConnectedClients, getServerTimeStr());
  }
}, 1000);

export function refresh() {
  if (state.isLoading) {
    scheduleRefresh();
    return;
  }
  state.isLoading = true;
  var capturedInteractionSeq = state._userInteractionSeq;

  if (settings.current.showLocation && navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(function(pos) {
      if (!settings.current.showLocation) return;
      var ll = [pos.coords.latitude, pos.coords.longitude];
      if (state._userLocationMarker) {
        state._userLocationMarker.setLatLng(ll);
      } else {
        state._userLocationMarker = L.circleMarker(ll, {
          radius: 8, fillOpacity: 0.9, weight: 3, color: '#fff', fillColor: '#4285f4',
          interactive: false, className: 'user-location-marker',
        }).addTo(state.map);
      }
    }, function() {}, { enableHighAccuracy: true, timeout: 5000, maximumAge: 10000 });
  }

  var zoom = state.map.getZoom();
  state.currentInterval = zoom < CONFIG.zoomThresholdSlowRefresh
    ? settings.current.refreshInterval * 3
    : settings.current.refreshInterval;

  var bounds = state.map.getBounds();
  var sw = bounds.getSouthWest();
  var ne = bounds.getNorthEast();
  var forceRefresh = state._forceRefresh;
  state._forceRefresh = false;

  api.getVehicles(sw.lat, sw.lng, ne.lat, ne.lng, forceRefresh)
    .then(function(data) {
      if (state.consecutiveErrors > 0) {
        clearPersistentError();
      }
      state.currentInterval = settings.current.refreshInterval;
      var vehicles = data.vehicles || [];
      if (data.serverTime) {
        var sh = parseInt(data.serverTime.slice(0, 2), 10);
        var sm = parseInt(data.serverTime.slice(2, 4), 10);
        var ss = data.serverTime.length >= 6 ? parseInt(data.serverTime.slice(4, 6), 10) : 0;
        if (isNaN(ss)) ss = 0;
        if (!isNaN(sh) && !isNaN(sm)) {
          var newMin = sh * 60 + sm + ss / 60;
          var oldDisplayMin = state.serverTimeMin != null
            ? state.serverTimeMin + (Date.now() - state.serverTimeStamp) / 60000
            : -1;
          if (newMin >= oldDisplayMin - 0.05 || oldDisplayMin < 0) {
            state.serverTimeMin = newMin;
            state.serverTimeStamp = Date.now();
          }
        }
      }
      if (typeof data.nextFreshDataIn === 'number' && isFinite(data.nextFreshDataIn) && data.nextFreshDataIn >= 0) {
        state._nextFreshDataIn = data.nextFreshDataIn;
      } else {
        state._nextFreshDataIn = null;
      }
      // Connected-User-Counter: nur tracken, Anzeige passiert in updateStatus
      // Erfolgreiche Response (auch Stale-Pfad ohne `connectedClients`) → Streak resetten
      state._connectedClientsErrorStreak = 0;
      if (typeof data.connectedClients === 'string') {
        state._lastConnectedClients = data.connectedClients;
      }
      // Bei field absent (z.B. Stale-Pfad) bleibt vorheriger Wert; erst nach 2 Errors auf null
      if (typeof data.appVersion === 'string' && /^[A-Za-z0-9._+\-]{1,64}$/.test(data.appVersion)) {
        if (!state._appVersion) {
          state._appVersion = data.appVersion;
        } else if (data.appVersion !== state._appVersion && !state._versionUpdateBannerShown) {
          state._versionUpdateBannerShown = true;
          ui.showVersionUpdateBanner();
        }
      }
      markers.updateAll(vehicles);
      stopsLayer.update(vehicles);
      updateStatus(vehicles.length, data.dataAge, state._lastConnectedClients);

      var _followHandledMissed = false;
      if (state.followBus && state.selectedJid) {
        var followEntry = state.vehicles.get(state.selectedJid);
        if (!followEntry) {
          if (!state._notStartedJid) ui._disableFollow();
        } else if (followEntry.missedCycles > 0) {
          _followHandledMissed = true;
          var followSeq = ++state._journeyReqSeq;
          var followJid = state.selectedJid;
          api.getJourney(followJid).then(function(jData) {
            if (state._journeyReqSeq !== followSeq || state.selectedJid !== followJid) return;
            var jp = (jData.journey || {}).pos || {};
            var fLat = jp.y ? jp.y / 1e6 : null;
            var fLon = jp.x ? jp.x / 1e6 : null;
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
            } else {
              var lk = followEntry.data;
              api.getVehicles(lk.lat - 0.05, lk.lon - 0.05, lk.lat + 0.05, lk.lon + 0.05).then(function(d2) {
                if (state.selectedJid !== followJid) return;
                var found = (d2.vehicles || []).find(function(v) { return v.jid === followJid; });
                if (found) {
                  followEntry.data.lat = found.lat;
                  followEntry.data.lon = found.lon;
                  followEntry.data.delay = found.delay;
                  followEntry.marker.setLatLng([found.lat, found.lon]);
                  followEntry.missedCycles = 0;
                  if (!state._followPanning) {
                    state._followPanning = true;
                    state.map.setView([found.lat, found.lon], state.map.getZoom(), { animate: false });
                    state._followPanning = false;
                  }
                }
              }).catch(function() {});
            }
          }).catch(function() {});
        } else if (!state._followPanning && !state._navigating) {
          var target = L.latLng(followEntry.data.lat, followEntry.data.lon);
          var current = state.map.getCenter();
          var followDist = current.distanceTo(target);
          if (followDist > 5) {
            state._followPanning = true;
            if (followDist > 3000) {
              state.map.setView(target, state.map.getZoom(), { animate: false });
              state._followPanning = false;
            } else {
              var panDur = Math.min(state.currentInterval / 1000, 2);
              state.map.panTo(target, { duration: panDur });
              state.map.once('moveend', function() { state._followPanning = false; });
              clearTimeout(state._followPanTimeout);
              state._followPanTimeout = setTimeout(function() { state._followPanning = false; }, (panDur * 1000) + 500);
            }
          }
        }
      }

      if (state._pendingRestore && state._userInteractionSeq === capturedInteractionSeq) {
        var pr = state._pendingRestore;
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
            var stopEntry = null;
            state.allStops.forEach(function(s) {
              if (s.data.extId === pr.stop) stopEntry = s.data;
            });
            // SEC-100: extId MUST be digits-only before LID concat — do not loosen this regex
            if (!stopEntry && /^\d+$/.test(pr.stop)) {
              stopEntry = {name: '', lid: 'A=1@L=' + pr.stop + '@', lat: 0, lon: 0, extId: pr.stop, platform: ''};
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
          var transVehicle = state.vehicles.get(state.selectedJid);
          state._notStartedJid = null;
          state._notStartedSince = 0;
          state._notStartedLastPoll = 0;
          ui.detailLine.textContent = transVehicle.data.lineFull || transVehicle.data.line;
          ui.detailDir.textContent = transVehicle.data.direction;
          document.getElementById('journey-actions').hidden = false;
          if (state.selectedJourneyData) {
            ui.renderJourneyStops(state.selectedJourneyData, transVehicle.data);
            state._currentStopL = (state.selectedJourneyData.journey || {}).stopL || [];
          }
          announce(t('journey_started_announce', {line: transVehicle.data.line}));
        }

        if (state.selectedJid && state.selectedJourneyData && !_followHandledMissed) {
          var selectedVehicle = state.vehicles.get(state.selectedJid);
          if (selectedVehicle) {
            var cls = getDelayClass(selectedVehicle.data.delay);
            ui.detailDelay.textContent = getDelayText(selectedVehicle.data.delay);
            ui.detailDelay.className = 'detail-delay-badge detail-delay-badge--' + cls;

            var seq2 = ++state._journeyReqSeq;
            var capturedJid = state.selectedJid;
            api.getJourney(capturedJid).then(function(journeyData) {
              if (state._journeyReqSeq !== seq2) return;
              if (state.selectedJid !== capturedJid) return;
              state.selectedJourneyData = journeyData;
              state._currentStopL = (journeyData.journey || {}).stopL || [];
              var jPos = (journeyData.journey || {}).pos || {};
              var jLat = jPos.y ? jPos.y / 1e6 : null;
              var jLon = jPos.x ? jPos.x / 1e6 : null;
              if (!jLat || !jLon) {
                var sv0 = state.vehicles.get(capturedJid);
                if (sv0 && sv0.missedCycles > 0) {
                  var lk = sv0.data;
                  api.getVehicles(lk.lat - 0.05, lk.lon - 0.05, lk.lat + 0.05, lk.lon + 0.05).then(function(d2) {
                    if (state.selectedJid !== capturedJid) return;
                    var found = (d2.vehicles || []).find(function(v) { return v.jid === capturedJid; });
                    if (found) {
                      sv0.data.lat = found.lat;
                      sv0.data.lon = found.lon;
                      sv0.data.delay = found.delay;
                      sv0.marker.setLatLng([found.lat, found.lon]);
                      if (state.followBus && !state._followPanning) {
                        state._followPanning = true;
                        state.map.setView([found.lat, found.lon], state.map.getZoom(), { animate: false });
                        state._followPanning = false;
                        scheduleRefresh(500);
                      }
                    }
                  }).catch(function() {});
                }
                var jStopL = (journeyData.journey || {}).stopL || [];
                var jLastStop = jStopL.length > 0 ? jStopL[jStopL.length - 1] : null;
                var jLastTime = jLastStop ? (jLastStop.aTimeR || jLastStop.aTimeS || jLastStop.dTimeR || jLastStop.dTimeS || '') : '';
                var jLastMin = jLastTime ? parseHafasTimeToMin(jLastTime) : 0;
                if (jLastMin === null) jLastMin = 0;
                var elMs2 = state.serverTimeStamp ? (Date.now() - state.serverTimeStamp) : 0;
                var nowM2 = (state.serverTimeMin || 0) + elMs2 / 60000;
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
              var sv = state.vehicles.get(state.selectedJid);
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
            }).catch(function() {});
          } else if (state._notStartedJid === state.selectedJid) {
            var now = Date.now();
            if (now - state._notStartedSince > 30 * 60 * 1000) {
              state._notStartedJid = null;
              state._notStartedSince = 0;
              state._notStartedLastPoll = 0;
              var expLi = document.createElement('li');
              expLi.className = 'empty-state';
              expLi.textContent = t('journey_poll_expired');
              ui.stopList.replaceChildren(expLi);
            } else if (now - state._notStartedLastPoll >= 30000) {
              state._notStartedLastPoll = now;
              var seq3 = ++state._journeyReqSeq;
              var pollJid = state._notStartedJid;
              api.getJourney(pollJid).then(function(data) {
                if (state._journeyReqSeq !== seq3) return;
                if (state.selectedJid !== pollJid || state._notStartedJid !== pollJid) return;
                var j = data.journey || {};
                if (j.isCncl) {
                  ui._showJourneyCancelled();
                  return;
                }
                var pos = j.pos || {};
                var pLat = pos.y ? pos.y / 1e6 : null;
                var pLon = pos.x ? pos.x / 1e6 : null;
                if (pLat && pLon) {
                  ui._transitionToRunning(data);
                }
              }).catch(function() {});
            }
          } else {
            state._journeyGoneCycles = (state._journeyGoneCycles || 0) + 1;
            if (state._journeyGoneCycles >= 2) {
              state._journeyGoneCycles = 0;
              var goneSeq = ++state._journeyReqSeq;
              var goneJid = state.selectedJid;
              api.getJourney(goneJid).then(function(data) {
                if (state._journeyReqSeq !== goneSeq) return;
                if (state.selectedJid !== goneJid) return;
                var gJ = data.journey || {};
                var gPos = gJ.pos || {};
                var gLat = gPos.y ? gPos.y / 1e6 : null;
                var gLon = gPos.x ? gPos.x / 1e6 : null;
                if (gLat && gLon) {
                  state.selectedJourneyData = data;
                  state._currentStopL = gJ.stopL || [];
                  ui.updateJourneyStopDelays(data);
                  ui.drawRoute(data, {jid: goneJid, lat: gLat, lon: gLon});
                  return;
                }
                var gStopL = gJ.stopL || [];
                var gLastStop = gStopL.length > 0 ? gStopL[gStopL.length - 1] : null;
                var gLastTime = gLastStop ? (gLastStop.aTimeR || gLastStop.aTimeS || gLastStop.dTimeR || gLastStop.dTimeS || '') : '';
                var gLastMin = gLastTime ? parseHafasTimeToMin(gLastTime) : 0;
                if (gLastMin === null) gLastMin = 0;
                var gElMs = state.serverTimeStamp ? (Date.now() - state.serverTimeStamp) : 0;
                var gNowM = (state.serverTimeMin || 0) + gElMs / 60000;
                if (gNowM > 1080 && gLastMin < 360) gLastMin += 1440;
                if (gNowM < 360 && gLastMin > 1080) gLastMin -= 1440;
                if (gLastTime && (gLastMin + 5) <= gNowM) {
                  ui.showJourneyEnded();
                } else {
                  state._notStartedJid = goneJid;
                  if (!state._notStartedSince) state._notStartedSince = Date.now();
                  state._notStartedLastPoll = Date.now();
                }
              }).catch(function() {});
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
    })
    .catch(function(err) {
      state._nextFreshDataIn = null;
      if (err.name === 'AbortError') return;
      state.consecutiveErrors++;
      state._connectedClientsErrorStreak++;
      if (state._connectedClientsErrorStreak >= 2) {
        state._lastConnectedClients = null;
      }
      if (state.consecutiveErrors >= 3) {
        state.currentInterval = Math.min(
          BACKOFF_BASE * Math.pow(2, state.consecutiveErrors - 2),
          CONFIG.maxBackoff
        );
      }
      if (state.consecutiveErrors === 1) {
        showPersistentError(t('connection_error'));
      } else {
        showPersistentError(t('offline_hint', {n: state.consecutiveErrors}));
      }
    })
    .finally(function() {
      state.isLoading = false;
      var wasImmediate = state._needsImmediateRefresh;
      state._needsImmediateRefresh = false;
      if (wasImmediate) { scheduleRefresh(0); return; }
      if (state.consecutiveErrors >= 3) { scheduleRefresh(); return; }
      var userMax = state.currentInterval;
      var hint = state._nextFreshDataIn;
      if (hint != null && isFinite(hint) && hint >= 0) {
        var hintMs = Math.max(hint * 1000, 2000);
        var jitter = Math.floor(Math.random() * 500);
        scheduleRefresh(Math.min(hintMs + jitter, userMax));
      } else {
        scheduleRefresh(userMax);
      }
    });
}
