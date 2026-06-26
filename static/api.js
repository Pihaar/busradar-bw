import { CONFIG } from './config.js';
import { state, settings } from './state.js';

// === API LAYER ===
export var api = {
  _journeyUserAbort: null,
  _stationDepAbort: null,
  _stationArrAbort: null,

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

  // Tag the SSE subscriber with a current journey or stationboard. The server
  // then ships matching SSE events on every tick. Used alongside the one-off
  // getJourney/getStationBoard fetches above so detail-panel updates flow
  // over the stream rather than per-tick polls.
  //
  // Wire format is a Pydantic discriminated union on the server side:
  //   selectStream('journey', jid)               → {"selection":{"kind":"journey","jid":...}}
  //   selectStream('stationboard', lid, 'DEP')   → {"selection":{"kind":"stationboard","lid":...,"board_type":"DEP"}}
  //   selectStream('stationboard', lid, 'ARR')   → {"selection":{"kind":"stationboard","lid":...,"board_type":"ARR"}}
  //   selectStream('none')                       → {"selection":null}
  selectStream: function(type, id, boardType) {
    var selection;
    if (type === 'journey') {
      selection = { kind: 'journey', jid: id };
    } else if (type === 'stationboard') {
      selection = { kind: 'stationboard', lid: id, board_type: boardType || 'DEP' };
    } else {
      selection = null;
    }
    return window.fetch(CONFIG.apiBase + '/stream/select', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ selection: selection }),
      credentials: 'same-origin',
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
