import { CONFIG } from './config.js';

// === STATE ===
export var state = {
  map: null,
  vehicles: new Map(),
  allStops: new Map(),
  stopLayer: null,
  selectedJid: null,
  selectedJourneyData: null,
  selectedStop: null,
  _activeStationBoardType: 'DEP',  // mirrors StationSelection.board_type server-side
  routeLayer: null,
  routeStopMarkers: [],
  routeCoords: null,
  refreshTimeout: null,
  isLoading: false,
  consecutiveErrors: 0,
  currentInterval: CONFIG.refreshInterval,
  lastUpdate: null,
  serverTimeMin: null,
  serverTimeStamp: null,
  panelState: 'hidden',
  followBus: false,
  _followPanning: false,
  _followPanTimeout: null,
  _notStartedJid: null,
  _notStartedSince: 0,
  _notStartedLastPoll: 0,
  _journeyReqSeq: 0,
  _needsImmediateRefresh: false,
  _stationRefreshSeq: 0,
  _pendingRestore: null,
  _restoreInProgress: false,
  _errorUntil: 0,
  _lastBusCount: 0,
  // increment on user gesture; async handlers compare captured-vs-current to detect interruption
  _userInteractionSeq: 0,
  _nextFreshDataIn: null,
  _appVersion: null,
  _appVersionFetch: null,
  _lastConnectedClients: undefined,
  // SSE connection state. 'connecting' | 'open' | 'reconnecting' | 'failed-terminal'.
  _sseState: 'connecting',
  // One-shot latch for the version-update banner. Once set, stays set for the
  // rest of the session even after dismissal; reload of the page resets it.
  // Intent: don't pester the user with the same banner across multiple polls.
  _versionUpdateBannerShown: false,
};

// === I18N ===
export function t(key, params) {
  var lang = (settings.current && settings.current.lang) || 'de';
  var table = window.I18N[lang] || window.I18N.de;
  if (!table[key]) table = window.I18N.de;
  var str = table[key] || key;
  if (params) {
    Object.keys(params).forEach(function(k) {
      str = str.split('{' + k + '}').join(String(params[k]));
    });
  }
  return str;
}

export function applyI18n(root) {
  root.querySelectorAll('[data-i18n]').forEach(function(el) {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach(function(el) {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  });
  root.querySelectorAll('[data-i18n-aria]').forEach(function(el) {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
  });
  document.documentElement.lang = (settings.current && settings.current.lang) || 'de';
}

// === UTILITIES ===

export function decodePolyline(encoded, precision) {
  precision = precision || 1e5;
  var points = [];
  var index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    var shift = 0, result = 0, byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    shift = 0; result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    points.push([lat / precision, lng / precision]);
  }
  return points;
}

export function formatTime(hafasTime) {
  if (!hafasTime || hafasTime.length < 4) return '';
  var offset = 0;
  if (hafasTime.length > 6) {
    offset = parseInt(hafasTime.slice(0, hafasTime.length - 6), 10);
    if (isNaN(offset)) return '';
    hafasTime = hafasTime.slice(hafasTime.length - 6);
  }
  var h = parseInt(hafasTime.slice(0, 2), 10) + offset * 24;
  var m = hafasTime.slice(2, 4);
  if (!isFinite(h)) return '';
  h = h % 24;
  return h + ':' + m;
}

export function getDayOffset(hafasTime) {
  if (!hafasTime) return 0;
  if (hafasTime.length > 6) {
    var n = parseInt(hafasTime.slice(0, hafasTime.length - 6), 10);
    return isNaN(n) || n < 0 ? 0 : n;
  }
  var h = parseInt(hafasTime.slice(0, 2), 10);
  return (!isNaN(h) && h >= 24) ? Math.floor(h / 24) : 0;
}

export function parseHafasTimeToMin(t) {
  if (!t || t.length < 4) return null;
  if (!/^\d+$/.test(t)) return null;
  var offset = 0;
  if (t.length > 6) {
    offset = parseInt(t.slice(0, t.length - 6), 10);
    t = t.slice(t.length - 6);
  }
  var h = parseInt(t.slice(0, 2), 10);
  var m = parseInt(t.slice(2, 4), 10);
  return (h + offset * 24) * 60 + m;
}

export function calcDelay(timeS, timeR) {
  if (!timeS || !timeR) return null;
  var plan = parseHafasTimeToMin(timeS);
  var real = parseHafasTimeToMin(timeR);
  if (plan === null || real === null) return null;
  var delay = real - plan;
  if (delay < -720) delay += 1440;
  else if (delay > 720) delay -= 1440;
  return delay;
}

export function getDelayClass(delay) {
  if (delay === null || delay === undefined) return 'nodata';
  if (delay <= -3) return 'early';
  if (delay <= 2) return 'ontime';
  if (delay <= 5) return 'delayed';
  return 'major-delay';
}

export function getDelayText(delay) {
  if (delay === null || delay === undefined) return t('no_realtime');
  if (delay === 0) return '±0';
  return (delay > 0 ? '+' : '') + delay + ' min';
}

export function parseCoord(val, min, max) {
  if (!val || !val.trim()) return null;
  var n = Number(val);
  return (isFinite(n) && n >= min && n <= max) ? n : null;
}

export function parseZoom(val) {
  if (!val || !val.trim()) return null;
  if (!/^\d+(\.\d+)?$/.test(val.trim())) return null;
  var n = Number(val);
  return (Number.isInteger(n) && n >= 1 && n <= 19) ? n : null;
}

// === HAFAS MESSAGES ===
var HAFAS_IGNORE_CODES = ['ae','au','az','ai','ac','ib','ic'];

export function extractHafasMessages(common, msgL, stopL) {
  var remL = (common && common.remL) || [];
  var journeyLevel = [];
  var perStopByLocX = Object.create(null);
  if (!msgL || !msgL.length) return {journeyLevel: journeyLevel, perStopByLocX: perStopByLocX};

  var firstLocX = (stopL && stopL.length > 0 && stopL[0].locX != null) ? stopL[0].locX : -1;
  var lastLocX = (stopL && stopL.length > 1 && stopL[stopL.length - 1].locX != null) ? stopL[stopL.length - 1].locX : -1;

  var seen = Object.create(null);
  for (var i = 0; i < msgL.length; i++) {
    var msg = msgL[i];
    if (msg.type !== 'REM' && msg.type !== 'HIM') continue;
    var rem = msg.type === 'REM' ? remL[msg.remX] : null;
    var text = '';
    if (msg.type === 'REM' && rem) {
      if (!rem.txtN) continue;
      var code = (rem.code || '').trim().toLowerCase();
      if (HAFAS_IGNORE_CODES.indexOf(code) >= 0) continue;
      text = String(rem.txtN).replace(/[\x00-\x1F\x7F]/g, ' ').trim().slice(0, 500);
    } else if (msg.type === 'HIM') {
      var himL = (common && common.himL) || [];
      var him = himL[msg.himX];
      if (!him || !him.head) continue;
      text = String(him.head).replace(/[\x00-\x1F\x7F]/g, ' ').trim().slice(0, 500);
    }
    if (!text) continue;

    var key = (rem ? rem.code || '' : 'HIM:' + (msg.himX || 0)) + '|' + text;

    var hasScopedRange = msg.fLocX != null && msg.tLocX != null && msg.fLocX >= 0 && msg.tLocX >= msg.fLocX;
    var isJourneyWide;
    if (!hasScopedRange) {
      isJourneyWide = true;
    } else if (firstLocX === lastLocX) {
      isJourneyWide = (msg.fLocX === firstLocX && msg.tLocX === lastLocX);
    } else {
      isJourneyWide = (msg.fLocX <= firstLocX && msg.tLocX >= lastLocX);
    }

    if (hasScopedRange && !isJourneyWide) {
      var startIdx = msg.fLocX;
      var stopKey = startIdx + ':' + key;
      if (!seen[stopKey]) {
        seen[stopKey] = true;
        if (!perStopByLocX[startIdx]) perStopByLocX[startIdx] = [];
        perStopByLocX[startIdx].push({text: text});
      }
    } else {
      if (seen['j:' + key]) continue;
      seen['j:' + key] = true;
      journeyLevel.push({text: text});
    }
  }
  return {journeyLevel: journeyLevel, perStopByLocX: perStopByLocX};
}

// === SETTINGS ===
export var SETTINGS_KEY = 'busradar_settings_v1';
export var BACKOFF_BASE = 10000;

export var settings = {
  defaults: { refreshInterval: 10000, interpolation: true, theme: 'dark', posMode: 'CALC', lang: 'de', showLocation: false },
  current: null,
  _saveTimer: null,
  _userInterpolation: true,
  _userRefreshInterval: 10000,

  init: function() {
    var stored = this._loadAndValidate();
    if (!stored.theme && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      stored.theme = 'light';
    }
    if (!stored.lang) {
      stored.lang = (navigator.language || 'de').toLowerCase().startsWith('en') ? 'en' : 'de';
    }
    this.current = Object.assign({}, this.defaults, stored);
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches && !('interpolation' in stored)) {
      this.current.interpolation = false;
    }
    this._userInterpolation = this.current.interpolation;
    this._userRefreshInterval = this.current.refreshInterval;
    this._applyThemeAttr();
    applyI18n(document.body);
  },

  _loadAndValidate: function() {
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      var validated = {};
      if ([10000, 20000, 30000].indexOf(parsed.refreshInterval) >= 0) {
        validated.refreshInterval = parsed.refreshInterval;
      }
      if (parsed.theme === 'dark' || parsed.theme === 'light') {
        validated.theme = parsed.theme;
      }
      if (typeof parsed.interpolation === 'boolean') {
        validated.interpolation = parsed.interpolation;
      }
      if (parsed.posMode === 'CALC' || parsed.posMode === 'REPORT_ONLY') {
        validated.posMode = parsed.posMode;
      }
      if (parsed.lang === 'de' || parsed.lang === 'en') {
        validated.lang = parsed.lang;
      }
      if (typeof parsed.showLocation === 'boolean') {
        validated.showLocation = parsed.showLocation;
      }
      return validated;
    } catch (e) { return {}; }
  },

  _save: function() {
    var self = this;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(function() {
      try {
        var toSave = Object.assign({}, self.current, {
          interpolation: self._userInterpolation,
          refreshInterval: self._userRefreshInterval,
        });
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(toSave));
      } catch (e) {}
    }, 300);
  },

  _flushSave: function() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      try {
        var toSave = Object.assign({}, this.current, {
          interpolation: this._userInterpolation,
          refreshInterval: this._userRefreshInterval,
        });
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(toSave));
      } catch (e) {}
    }
  },

  _applyThemeAttr: function() {
    document.documentElement.setAttribute('data-theme', this.current.theme);
    var meta = document.getElementById('meta-theme-color');
    if (meta) meta.content = this.current.theme === 'light' ? '#f5f6fa' : '#0a0e1a';
  },

  applyTileLayers: function() {
    if (!state.map) return;
    var newLayer = this.current.theme === 'light' ? state.lightTileLayer : state.darkTileLayer;
    var oldLayer = this.current.theme === 'light' ? state.darkTileLayer : state.lightTileLayer;
    if (state.map.hasLayer(newLayer)) return;
    if (state.map.hasLayer(state._osmFallback)) {
      state.map.removeLayer(state._osmFallback);
    }
    if (state.map.hasLayer(oldLayer)) state.map.removeLayer(oldLayer);
    newLayer.addTo(state.map);
  },

  _updateGroup: function(groupId, value) {
    document.querySelectorAll('#' + groupId + ' .settings-opt').forEach(function(opt) {
      var isActive = opt.dataset.value === value;
      opt.classList.toggle('settings-opt--active', isActive);
      opt.setAttribute('aria-checked', String(isActive));
    });
  },

  _updateHint: function() {
    var hint = document.getElementById('settings-hint');
    if (!state.map) { hint.hidden = true; return; }
    var zoom = state.map.getZoom();
    var msgs = [];
    if (zoom < CONFIG.zoomThresholdNoAnimation) {
      msgs.push(t('hint_animation_disabled'));
    }
    if (zoom < CONFIG.zoomThresholdSlowRefresh) {
      msgs.push(t('hint_refresh_reduced', {n: this.current.refreshInterval * 3 / 1000}));
    }
    if (msgs.length > 0) {
      hint.textContent = '⚠ ' + msgs.join(' · ');
      hint.hidden = false;
    } else {
      hint.hidden = true;
    }
  },

  _applyPosModeConstraint: function() {
    var disable = this.current.posMode === 'REPORT_ONLY';
    this.current.interpolation = disable ? false : this._userInterpolation;
    this._updateGroup('setting-interpolation', this.current.interpolation ? 'on' : 'off');
    var group = document.getElementById('setting-interpolation');
    if (group) {
      group.setAttribute('aria-disabled', String(disable));
      group.classList.toggle('settings-options--disabled', disable);
      group.querySelectorAll('.settings-opt').forEach(function(btn) {
        if (disable) {
          btn.setAttribute('disabled', '');
          btn.setAttribute('tabindex', '-1');
        } else {
          btn.removeAttribute('disabled');
          btn.removeAttribute('tabindex');
        }
      });
    }
    var hint = document.getElementById('hint-animation-disabled');
    if (hint) hint.hidden = !disable;
    if (disable) {
      state.vehicles.forEach(function(entry) {
        if (entry._animFrame) {
          cancelAnimationFrame(entry._animFrame);
          entry._animFrame = null;
        }
        if (entry.data) entry.marker.setLatLng([entry.data.lat, entry.data.lon]);
      });
    }
    // GPS-Mode: force 30s refresh interval + readonly
    var refreshGroup = document.getElementById('setting-refresh');
    if (refreshGroup) {
      refreshGroup.setAttribute('aria-disabled', String(disable));
      refreshGroup.classList.toggle('settings-options--disabled', disable);
      refreshGroup.querySelectorAll('.settings-opt').forEach(function(btn) {
        if (disable) {
          btn.setAttribute('disabled', '');
          btn.setAttribute('tabindex', '-1');
        } else {
          btn.removeAttribute('disabled');
          btn.removeAttribute('tabindex');
        }
      });
    }
    if (disable) {
      this.current.refreshInterval = 30000;
      state.currentInterval = 30000;
      this._updateGroup('setting-refresh', '30000');
    } else {
      this.current.refreshInterval = this._userRefreshInterval;
      state.currentInterval = this._userRefreshInterval;
      this._updateGroup('setting-refresh', String(this._userRefreshInterval));
    }
  },
};
