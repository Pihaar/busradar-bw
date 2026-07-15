import { CONFIG } from './config.js';
import { state, settings, t, applyI18n, parseCoord, parseZoom } from './state.js';
import { urlState } from './api.js';
import { mapModule, stopsLayer, setUserLocationMarker } from './map.js';
import { ui, search } from './ui.js';
import { startStream, notifyViewportChange, refresh, showError, announce } from './refresh.js';

var SETTINGS_KEY = 'busradar_settings_v1';

// The tab-local UUID client-id mechanism is gone. The connected-clients
// counter is now driven by the SSE subscriber registry on the server,
// identified by the SSE connection itself (HttpOnly cookie). No fetch from
// the browser carries X-Client-Id anymore.

// === SETTINGS UI BINDING ===
settings._bindUI = function() {
  var self = this;
  var btn = document.getElementById('settings-btn');
  var panel = document.getElementById('settings-panel');

  btn.addEventListener('click', function() {
    var willOpen = panel.hidden;
    panel.hidden = !willOpen;
    btn.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) self._updateHint();
  });

  document.querySelectorAll('#setting-refresh .settings-opt').forEach(function(opt) {
    opt.addEventListener('click', function() {
      if (self.current.posMode === 'REPORT_ONLY') return;
      self.current.refreshInterval = parseInt(opt.dataset.value, 10);
      self._userRefreshInterval = self.current.refreshInterval;
      self._save();
      state.currentInterval = self.current.refreshInterval;
      // The SSE stream pushes data at the HAFAS-tick cadence; there is no
      // setTimeout poll loop to nudge. Refresh-interval setting is kept
      // only for the 1s status ticker / status text formatting.
      notifyViewportChange();
      self._updateGroup('setting-refresh', opt.dataset.value);
      announce(t('announce_refresh', {n: self.current.refreshInterval / 1000}));
    });
  });

  document.querySelectorAll('#setting-interpolation .settings-opt').forEach(function(opt) {
    opt.addEventListener('click', function() {
      if (self.current.posMode === 'REPORT_ONLY') return;
      var val = opt.dataset.value === 'on';
      self._userInterpolation = val;
      self.current.interpolation = val;
      self._save();
      if (!val) {
        state.vehicles.forEach(function(entry) {
          if (entry._animFrame) {
            cancelAnimationFrame(entry._animFrame);
            entry._animFrame = null;
          }
          entry.marker.setLatLng([entry.data.lat, entry.data.lon]);
        });
      }
      self._updateGroup('setting-interpolation', opt.dataset.value);
      announce(val ? t('announce_animation_on') : t('announce_animation_off'));
    });
  });

  document.querySelectorAll('#setting-posmode .settings-opt').forEach(function(opt) {
    opt.addEventListener('click', function() {
      self.current.posMode = opt.dataset.value;
      self._save();
      self._updateGroup('setting-posmode', opt.dataset.value);
      self._applyPosModeConstraint();
      if (opt.dataset.value === 'CALC') {
        announce(t('announce_posmode_calc'));
      } else {
        announce(self._userInterpolation ? t('announce_posmode_gps_anim_off') : t('announce_posmode_gps'));
      }
      notifyViewportChange();
    });
  });

  document.querySelectorAll('#setting-theme .settings-opt').forEach(function(opt) {
    opt.addEventListener('click', function() {
      self.current.theme = opt.dataset.value;
      self._save();
      self._applyThemeAttr();
      self.applyTileLayers();
      self._updateGroup('setting-theme', opt.dataset.value);
      announce(opt.dataset.value === 'light' ? t('announce_theme_light') : t('announce_theme_dark'));
    });
  });

  this._updateGroup('setting-refresh', String(this.current.refreshInterval));
  this._updateGroup('setting-interpolation', this.current.interpolation ? 'on' : 'off');
  this._updateGroup('setting-posmode', this.current.posMode);
  this._updateGroup('setting-theme', this.current.theme);
  this._updateGroup('setting-location', this.current.showLocation ? 'on' : 'off');
  this._updateGroup('setting-language', this.current.lang);

  document.querySelectorAll('#setting-location .settings-opt').forEach(function(opt) {
    opt.addEventListener('click', function() {
      var val = opt.dataset.value === 'on';
      if (val && !navigator.geolocation) {
        showError(t('location_unavailable'));
        return;
      }
      if (val) {
        // Nonce guards against a fast on→off toggle sequence: the async GPS
        // callback (up to 8 s) could otherwise resurrect showLocation=true
        // after the user already turned it off in the meantime.
        var thisNonce = ++self._locationToggleNonce;
        navigator.geolocation.getCurrentPosition(function(pos) {
          if (self._locationToggleNonce !== thisNonce) return;  // superseded
          self.current.showLocation = true;
          self._save();
          self._updateGroup('setting-location', 'on');
          if (state._gpsControlContainer) state._gpsControlContainer.style.display = '';
          setUserLocationMarker(pos.coords.latitude, pos.coords.longitude);
          state.map.setView([pos.coords.latitude, pos.coords.longitude], CONFIG.defaultZoom);
        }, function(err) {
          if (self._locationToggleNonce !== thisNonce) return;
          // Map the geolocation error code to an accurate message.
          // code 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE,
          // 3 = TIMEOUT. Showing "denied" for a timeout (the common
          // Android-Chrome case where the site permission is granted
          // but Google Location Services doesn't answer) misdirects
          // the user to the wrong setting.
          var code = err && err.code;
          var key = code === 1 ? 'location_denied'
                  : code === 3 ? 'location_timeout'
                  : code === 2 ? 'location_unavailable'
                  : 'location_error';
          showError(t(key));
        }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 });
      } else {
        self._locationToggleNonce++;
        self.current.showLocation = false;
        self._save();
        self._updateGroup('setting-location', 'off');
        if (state._gpsControlContainer) state._gpsControlContainer.style.display = 'none';
        if (state._userLocationMarker) {
          state._userLocationMarker.remove();
          state._userLocationMarker = null;
        }
      }
    });
  });

  document.querySelectorAll('#setting-language .settings-opt').forEach(function(opt) {
    opt.addEventListener('click', function() {
      if (opt.dataset.value === self.current.lang) return;
      self.current.lang = opt.dataset.value;
      try {
        var toSave = Object.assign({}, self.current, {
          interpolation: self._userInterpolation,
          refreshInterval: self._userRefreshInterval,
        });
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(toSave));
      } catch(e) {}
      location.reload();
    });
  });

  var resetBtn = document.getElementById('setting-reset');
  if (resetBtn) {
    var resetting = false;
    resetBtn.addEventListener('click', function() {
      if (resetting) return;
      if (!window.confirm(t('setting_reset_confirm'))) return;
      resetting = true;
      resetBtn.disabled = true;
      resetBtn.setAttribute('aria-busy', 'true');
      try { localStorage.clear(); } catch (e) {}
      try { sessionStorage.clear(); } catch (e) {}
      function safeClearCaches() {
        try {
          if (typeof caches === 'undefined' || !caches.keys) return Promise.resolve();
          return caches.keys().then(function(keys) {
            return Promise.all(keys.map(function(k) {
              return caches.delete(k).catch(function() {});
            }));
          }).catch(function() {});
        } catch (e) { return Promise.resolve(); }
      }
      function safeUnregisterSW() {
        try {
          if (!('serviceWorker' in navigator) || !navigator.serviceWorker.getRegistrations) return Promise.resolve();
          return navigator.serviceWorker.getRegistrations().then(function(regs) {
            return Promise.all(regs.map(function(r) {
              return r.unregister().catch(function() {});
            }));
          }).catch(function() {});
        } catch (e) { return Promise.resolve(); }
      }
      Promise.allSettled([safeClearCaches(), safeUnregisterSW()]).then(function() {
        // Cache-Buster-Query stellt sicher, dass ein noch aktiver SW die nächste
        // Navigation nicht aus seinem Cache bedient.
        location.replace(location.pathname + '?_=' + Date.now());
      });
    });
  }

  var aboutDialog = document.getElementById('about-dialog');
  if (aboutDialog) {
    aboutDialog.querySelector('.about-close').addEventListener('click', function() {
      aboutDialog.close();
    });
    aboutDialog.addEventListener('click', function(e) {
      if (e.target === aboutDialog) aboutDialog.close();
    });
  }

  document.addEventListener('visibilitychange', function() {
    if (document.hidden) self._flushSave();
  });
  window.addEventListener('pagehide', function() { self._flushSave(); });
};

// === INIT ===
function init() {
  settings.init();
  settings._bindUI();
  settings._applyPosModeConstraint();
  mapModule.init();
  stopsLayer.init();
  search.init();
  ui.init();

  state.map.on('zoomend', function() {
    if (!document.getElementById('settings-panel').hidden) {
      settings._updateHint();
    }
  });

  var params = urlState.parse();
  if (params.lat && params.lon && params.z) {
    var initLat = parseCoord(params.lat, -90, 90);
    var initLon = parseCoord(params.lon, -180, 180);
    var initZ = parseZoom(params.z);
    if (initLat !== null && initLon !== null && initZ !== null) {
      state.map.setView([initLat, initLon], initZ);
    }
  }

  var center = state.map.getCenter();
  stopsLayer.loadAll(center.lat, center.lng, 5000);

  state._pendingRestore = (params.jid || params.stop) ? params : null;
  state._restoreInProgress = !!state._pendingRestore;
  startStream();

  state.map.on('moveend', function() {
    if (state._restoreInProgress || state._navigating || state._followPanning) return;
    if (!state.selectedJid && !state.selectedStop) {
      urlState.saveMapPosition();
    }
    // Re-anchor the SSE viewport on every user-initiated pan/zoom. Server
    // debounces but also accepts every POST; refresh.js itself trailing-
    // debounces by 250 ms.
    notifyViewportChange();
  });
  state.map.on('zoomend', function() {
    if (state._restoreInProgress || state._navigating || state._followPanning) return;
    notifyViewportChange();
  });

  window.addEventListener('popstate', function(e) {
    var params = e.state || urlState.parse();
    if (urlState._pushCount > 0) urlState._pushCount--;

    if (params.jid) {
      var entry = state.vehicles.get(params.jid);
      if (entry) {
        if (params.lat && params.lon && params.z) {
          var pLat = parseCoord(params.lat, -90, 90);
          var pLon = parseCoord(params.lon, -180, 180);
          var pZ = parseZoom(params.z);
          if (pLat !== null && pLon !== null && pZ !== null) {
            state.map.setView([pLat, pLon], pZ);
          }
        }
        ui.selectJourney(entry.data, true);
      } else {
        ui.focusJourneyById(params.jid, {}, true);
      }
    } else if (params.stop) {
      if (params.lat && params.lon && params.z) {
        var sLat = parseCoord(params.lat, -90, 90);
        var sLon = parseCoord(params.lon, -180, 180);
        var sZ = parseZoom(params.z);
        if (sLat !== null && sLon !== null && sZ !== null) {
          state.map.setView([sLat, sLon], sZ);
        }
      }
      var stopEntry = null;
      state.allStops.forEach(function(s) {
        if (s.data.extId === params.stop) stopEntry = s.data;
      });
      if (!stopEntry && /^\d+$/.test(params.stop)) {
        stopEntry = {name: '', lid: 'A=1@L=' + params.stop + '@', lat: 0, lon: 0, extId: params.stop, platform: ''};
      }
      if (stopEntry) {
        ui.showStationBoard(stopEntry, true);
        if (params.tab === 'arr') ui.switchTab('arrivals');
      }
    } else {
      ui.closePanel();
      if (params.lat && params.lon && params.z) {
        var mLat = parseCoord(params.lat, -90, 90);
        var mLon = parseCoord(params.lon, -180, 180);
        var mZ = parseZoom(params.z);
        if (mLat !== null && mLon !== null && mZ !== null) {
          state.map.setView([mLat, mLon], mZ);
        }
      }
    }
  });

  document.addEventListener('visibilitychange', function() {
    // refresh.js owns SSE lifecycle on visibilitychange (close-on-hide is
    // unnecessary — EventSource stays open in the background; on visible
    // refresh.js itself reconnects if the stream had closed).
    if (!document.hidden) {
      refresh();
    }
  });
}

window.addEventListener('offline', function(e) {
  if (!e.isTrusted) return;
  showError(t('device_offline'));
});
window.addEventListener('online', function(e) {
  if (!e.isTrusted) return;
  // EventSource will auto-reconnect; just kick the viewport so the next tick
  // brings data for the right bbox.
  refresh();
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', function() {
    navigator.serviceWorker.register('/sw.js', {updateViaCache: 'none'})
      .then(function(reg) {
        // Warm PWAs (resumed from background, never navigated) don't
        // re-run this registration, so they never check for a new SW and
        // keep serving the old app version until a manual cache clear.
        // Poke the browser to re-check whenever the app returns to the
        // foreground.
        document.addEventListener('visibilitychange', function() {
          if (document.visibilityState === 'visible') {
            reg.update().catch(function() {});
          }
        });
      })
      .catch(function(e) { console.warn('SW registration failed:', e); });

    // When a new SW takes control (after skipWaiting + clients.claim),
    // reload ONCE so the page swaps to the freshly-cached assets. Guarded
    // on there already being a controller, so the very first install on a
    // fresh visit doesn't trigger a spurious reload.
    if (navigator.serviceWorker.controller) {
      var reloadedForSW = false;
      navigator.serviceWorker.addEventListener('controllerchange', function() {
        if (reloadedForSW) return;
        reloadedForSW = true;
        location.reload();
      });
    }
  });
}
