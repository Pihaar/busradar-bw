import { CONFIG } from './config.js';
import { state, settings, t, applyI18n, parseCoord, parseZoom } from './state.js';
import { urlState } from './api.js';
import { mapModule, stopsLayer } from './map.js';
import { ui, search } from './ui.js';
import { scheduleRefresh, showError, announce, refresh } from './refresh.js';

var SETTINGS_KEY = 'busradar_settings_v1';

// === CLIENT ID ===
// Synchron beim Module-Load — muss vor jedem Fetch gesetzt sein.
// Tab-lokal, kein localStorage, kein Cookie. Header X-Client-Id wird in api.js gesendet.
function _generateClientId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    try { return window.crypto.randomUUID(); } catch (e) { /* fallthrough */ }
  }
  if (window.crypto && window.crypto.getRandomValues) {
    try {
      var b = new Uint8Array(16);
      window.crypto.getRandomValues(b);
      b[6] = (b[6] & 0x0f) | 0x40;  // version 4
      b[8] = (b[8] & 0x3f) | 0x80;  // variant 10
      var hex = Array.prototype.map.call(b, function(x) { return ('0' + x.toString(16)).slice(-2); }).join('');
      return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20, 32);
    } catch (e) {
      return null;
    }
  }
  return null;
}
state._clientId = _generateClientId();

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
      clearTimeout(state.refreshTimeout);
      scheduleRefresh();
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
      scheduleRefresh(0);
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
        navigator.geolocation.getCurrentPosition(function(pos) {
          self.current.showLocation = true;
          self._save();
          self._updateGroup('setting-location', 'on');
          if (state._gpsControlContainer) state._gpsControlContainer.style.display = '';
          state._userLocationMarker = L.circleMarker([pos.coords.latitude, pos.coords.longitude], {
            radius: 8, fillOpacity: 0.9, weight: 3, color: '#fff', fillColor: '#4285f4',
            interactive: false, className: 'user-location-marker',
          }).addTo(state.map);
          state.map.setView([pos.coords.latitude, pos.coords.longitude], CONFIG.defaultZoom);
        }, function() {
          showError(t('location_denied'));
        }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 });
      } else {
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
  refresh();

  state.map.on('moveend', function() {
    if (state._restoreInProgress || state._navigating || state._followPanning) return;
    if (!state.selectedJid && !state.selectedStop) {
      urlState.saveMapPosition();
    }
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
    if (document.hidden) {
      if (state.refreshTimeout) {
        clearTimeout(state.refreshTimeout);
        state.refreshTimeout = null;
      }
    } else {
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
  scheduleRefresh(0);
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', function() {
    navigator.serviceWorker.register('/sw.js', {updateViaCache: 'none'})
      .catch(function(e) { console.warn('SW registration failed:', e); });
  });
}
