import { CONFIG } from './config.js';
import { state, settings } from './state.js';

// === API LAYER ===
export var api = {
  _journeyUserAbort: null,
  _stationDepAbort: null,
  _stationArrAbort: null,

  getVehicles: function(swLat, swLon, neLat, neLon, forceRefresh) {
    var params = new URLSearchParams({
      swLat: swLat.toFixed(5),
      swLon: swLon.toFixed(5),
      neLat: neLat.toFixed(5),
      neLon: neLon.toFixed(5),
      posMode: settings.current.posMode,
    });
    if (forceRefresh) params.set('_t', Date.now());
    return window.fetch(CONFIG.apiBase + '/vehicles?' + params.toString())
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
  },

  getStops: function(lat, lon, radius) {
    var params = new URLSearchParams({
      lat: lat.toFixed(5),
      lon: lon.toFixed(5),
      radius: String(radius),
    });
    return window.fetch(CONFIG.apiBase + '/stops?' + params.toString())
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
  },

  getJourney: function(jid, opts) {
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
    return window.fetch(CONFIG.apiBase + '/journey', fetchOpts)
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
  },

  getStationBoard: function(lid, type, dur) {
    var abortKey = type === 'ARR' ? '_stationArrAbort' : '_stationDepAbort';
    if (api[abortKey]) api[abortKey].abort();
    api[abortKey] = new AbortController();
    return window.fetch(CONFIG.apiBase + '/stationboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lid: lid, type: type || 'DEP', dur: dur || 60 }),
      signal: api[abortKey].signal,
    }).then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  },
};

// === URL STATE ===
var URL_SCHEMA = Object.create(null);
URL_SCHEMA.jid = 1; URL_SCHEMA.stop = 1; URL_SCHEMA.lat = 1;
URL_SCHEMA.lon = 1; URL_SCHEMA.z = 1; URL_SCHEMA.follow = 1; URL_SCHEMA.tab = 1;

export var urlState = {
  push: function(params) {
    var clean = Object.create(null);
    Object.keys(params).forEach(function(k) { if (k in URL_SCHEMA) clean[k] = params[k]; });
    var hash = '#' + Object.keys(clean).map(function(k) {
      return k + '=' + encodeURIComponent(clean[k]);
    }).join('&');
    history.pushState(clean, '', hash);
    urlState._pushCount = (urlState._pushCount || 0) + 1;
  },

  replace: function(params) {
    var clean = Object.create(null);
    Object.keys(params).forEach(function(k) { if (k in URL_SCHEMA) clean[k] = params[k]; });
    var hash = '#' + Object.keys(clean).map(function(k) {
      return k + '=' + encodeURIComponent(clean[k]);
    }).join('&');
    history.replaceState(clean, '', hash);
  },

  parse: function() {
    var hash = location.hash.slice(1);
    if (!hash || hash.length > 2048) return Object.create(null);
    var params = Object.create(null);
    hash.split('&').forEach(function(pair) {
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

  saveMapPosition: function() {
    var center = state.map.getCenter();
    var zoom = state.map.getZoom();
    urlState.replace({ lat: center.lat.toFixed(5), lon: center.lng.toFixed(5), z: zoom });
  },

  buildShareHash: function(opts) {
    var clean = Object.create(null);
    if (opts.jid) clean.jid = opts.jid;
    else if (opts.stop) {
      clean.stop = opts.stop;
      if (opts.tab === 'dep' || opts.tab === 'arr') clean.tab = opts.tab;
    }
    return '#' + Object.keys(clean).map(function(k) {
      return k + '=' + encodeURIComponent(clean[k]);
    }).join('&');
  },

};
