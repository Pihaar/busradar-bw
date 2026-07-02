import { CONFIG } from './config.js';
import { state, settings, t, getDelayClass, getDelayText, parseHafasTimeToMin } from './state.js';
import { api } from './api.js';
import { ui } from './ui.js';
import * as refresh from './refresh.js';

// === MAP MODULE ===
export var mapModule = {
  init: function() {
    state.map = L.map('map', {
      center: CONFIG.fallbackCenter,
      zoom: CONFIG.defaultZoom,
      zoomControl: false,
      attributionControl: true,
    });

    var cartoSubdomains = 'abcd';

    var RetryTileLayer = L.TileLayer.extend({
      createTile: function(coords, done) {
        var tile = document.createElement('img');
        tile.alt = '';
        tile.setAttribute('role', 'presentation');
        if (this.options.crossOrigin || this.options.crossOrigin === '') {
          tile.crossOrigin = this.options.crossOrigin === true ? '' : this.options.crossOrigin;
        }
        tile.referrerPolicy = 'no-referrer';

        var self = this;
        var subs = (this.options.subdomains || 'abcd').split ? (this.options.subdomains || 'abcd').split('') : this.options.subdomains;
        var baseUrl = this.getTileUrl(coords);
        var tried = 0;

        function attempt() {
          var url = baseUrl.replace(/\/\/[abcd]\./, '//' + subs[tried] + '.');
          tile.onload = function() { tile.onload = tile.onerror = null; done(null, tile); };
          tile.onerror = function() {
            tried++;
            if (tried < subs.length) {
              attempt();
            } else {
              tile.onload = tile.onerror = null;
              done('failed', tile);
            }
          };
          tile.src = url;
        }
        attempt();
        return tile;
      }
    });

    function createTileLayers(subs) {
      var opts = { attribution: CONFIG.tileAttribution, maxZoom: 19, maxNativeZoom: 18, subdomains: subs };
      if (state.darkTileLayer && state.map.hasLayer(state.darkTileLayer)) state.map.removeLayer(state.darkTileLayer);
      if (state.lightTileLayer && state.map.hasLayer(state.lightTileLayer)) state.map.removeLayer(state.lightTileLayer);
      state.darkTileLayer = new RetryTileLayer(CONFIG.tileUrl, opts);
      state.lightTileLayer = new RetryTileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', opts);
      state.darkTileLayer.on('tileerror', onTileError);
      state.darkTileLayer.on('tileload', onTileLoad);
      state.lightTileLayer.on('tileerror', onTileError);
      state.lightTileLayer.on('tileload', onTileLoad);
      var active = settings.current.theme === 'light' ? state.lightTileLayer : state.darkTileLayer;
      active.addTo(state.map);
    }

    state._osmFallback = L.tileLayer(CONFIG.fallbackTileUrl, {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a>',
      maxZoom: 19,
      className: 'osm-fallback-tiles',
    });

    var brokenZooms = {};

    function onTileError() {
      var z = state.map.getZoom();
      brokenZooms[z] = true;
      if (!state.map.hasLayer(state._osmFallback)) {
        var current = settings.current.theme === 'light' ? state.lightTileLayer : state.darkTileLayer;
        if (state.map.hasLayer(current)) state.map.removeLayer(current);
        state._osmFallback.addTo(state.map);
      }
    }
    function onTileLoad() {}

    state.map.on('zoomend', function() {
      var z = state.map.getZoom();
      if (!brokenZooms[z] && state.map.hasLayer(state._osmFallback)) {
        state.map.removeLayer(state._osmFallback);
        var current = settings.current.theme === 'light' ? state.lightTileLayer : state.darkTileLayer;
        if (!state.map.hasLayer(current)) current.addTo(state.map);
      } else if (brokenZooms[z] && !state.map.hasLayer(state._osmFallback)) {
        var cur = settings.current.theme === 'light' ? state.lightTileLayer : state.darkTileLayer;
        if (state.map.hasLayer(cur)) state.map.removeLayer(cur);
        state._osmFallback.addTo(state.map);
      }
    });

    createTileLayers('abcd');

    L.control.zoom({ position: 'bottomleft' }).addTo(state.map);

    var GpsControl = L.Control.extend({
      options: { position: 'bottomleft' },
      onAdd: function() {
        var container = L.DomUtil.create('div', 'leaflet-bar leaflet-control gps-control');
        var link = L.DomUtil.create('a', '', container);
        link.href = '#';
        link.title = t('gps_center');
        link.setAttribute('aria-label', t('gps_center'));
        link.setAttribute('role', 'button');
        // Accepted innerHTML: static SVG literal, no user input (see TD-4 review)
        link.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="3"/><line x1="8" y1="1" x2="8" y2="4"/><line x1="8" y1="12" x2="8" y2="15"/><line x1="1" y1="8" x2="4" y2="8"/><line x1="12" y1="8" x2="15" y2="8"/></svg>';
        L.DomEvent.disableClickPropagation(container);
        L.DomEvent.on(link, 'click', function(e) {
          L.DomEvent.preventDefault(e);
          if (!navigator.geolocation) {
            link.classList.add('gps-control--error');
            setTimeout(function() { link.classList.remove('gps-control--error'); }, 1500);
            return;
          }
          link.style.opacity = '0.5';
          navigator.geolocation.getCurrentPosition(
            function(pos) {
              link.style.opacity = '';
              state.map.setView([pos.coords.latitude, pos.coords.longitude], CONFIG.defaultZoom);
              setUserLocationMarker(pos.coords.latitude, pos.coords.longitude);
            },
            function() {
              link.style.opacity = '';
              link.classList.add('gps-control--error');
              setTimeout(function() { link.classList.remove('gps-control--error'); }, 1500);
            },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
          );
        });
        state._gpsControlContainer = container;
        if (!settings.current.showLocation) container.style.display = 'none';
        return container;
      },
    });
    new GpsControl().addTo(state.map);

    var AboutControl = L.Control.extend({
      options: { position: 'bottomleft' },
      onAdd: function() {
        var container = L.DomUtil.create('div', 'leaflet-bar leaflet-control about-control');
        var link = L.DomUtil.create('a', '', container);
        link.href = '#';
        link.title = t('about_label');
        link.setAttribute('aria-label', t('about_label'));
        link.setAttribute('role', 'button');
        link.textContent = 'i';
        L.DomEvent.disableClickPropagation(container);
        L.DomEvent.on(link, 'click', function(e) {
          L.DomEvent.preventDefault(e);
          var dlg = document.getElementById('about-dialog');
          if (dlg && !dlg.open) {
            var vNode = document.getElementById('about-version-value');
            if (vNode) {
              if (state._appVersion) {
                vNode.textContent = state._appVersion;
              } else if (state._appVersionFetch) {
                vNode.textContent = '…';
              } else {
                vNode.textContent = '…';
                var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
                var timer = ctrl ? setTimeout(function() { ctrl.abort(); }, 10000) : null;
                state._appVersionFetch = window.fetch(CONFIG.apiBase + '/health', ctrl ? {signal: ctrl.signal} : undefined)
                  .then(function(r) { return r.ok ? r.json() : null; })
                  .then(function(j) {
                    if (j && typeof j.version === 'string' && /^[A-Za-z0-9._+\-]{1,64}$/.test(j.version)) {
                      state._appVersion = j.version;
                      vNode.textContent = j.version;
                    } else {
                      vNode.textContent = '—';
                    }
                  })
                  .catch(function() { vNode.textContent = '—'; })
                  .then(function() {
                    if (timer) clearTimeout(timer);
                    state._appVersionFetch = null;
                  });
              }
            }
            dlg.showModal();
          }
        });
        return container;
      },
    });
    new AboutControl().addTo(state.map);

    state.map.attributionControl.setPosition('bottomleft');

    var clickTimeout = null;
    state.map.on('click', function() {
      clearTimeout(clickTimeout);
      clickTimeout = setTimeout(function() {
        if (state._selectionJustMade) return;
        if (state.selectedJid || state.selectedStop) {
          ui.closePanel();
        }
      }, 550);
    });
    state.map.getContainer().addEventListener('dblclick', function() {
      clearTimeout(clickTimeout);
    });

    state._cancelMapClick = function() {
      clearTimeout(clickTimeout);
      state._selectionJustMade = true;
      setTimeout(function() { state._selectionJustMade = false; }, 600);
    };

    var moveDebounce = null;
    var lastRefreshCenter = state.map.getCenter();
    var lastRefreshZoom = state.map.getZoom();
    state.map.on('moveend', function() {
      clearTimeout(moveDebounce);
      moveDebounce = setTimeout(function() {
        if (state._followPanning) return;
        var center = state.map.getCenter();
        var bounds = state.map.getBounds();
        var radius = Math.round(center.distanceTo(bounds.getNorthEast()));
        stopsLayer.loadAll(center.lat, center.lng, Math.min(radius, 20000));

        var dist = center.distanceTo(lastRefreshCenter);
        var zoom = state.map.getZoom();
        var viewportDiameter = bounds.getNorthEast().distanceTo(bounds.getSouthWest());
        if (dist > viewportDiameter * 0.10 || zoom < lastRefreshZoom) {
          lastRefreshCenter = center;
          lastRefreshZoom = zoom;
          refresh.refresh();
        }
      }, 500);
    });

    state.map.on('dragstart', function() {
      if (state.followBus || state._followPanning) {
        ui._disableFollow();
      }
    });


    var lastZoomBucket = -1;
    function updateMarkerScale() {
      var z = state.map.getZoom();
      var bucket = z >= 16 ? 3 : z >= 14 ? 2 : z >= 12 ? 1 : 0;
      if (bucket === lastZoomBucket) return;
      lastZoomBucket = bucket;
      var scale = [0.74, 0.85, 1.0, 1.12][bucket];
      state.map.getContainer().style.setProperty('--marker-scale', String(scale));
    }
    state.map.on('zoomend', updateMarkerScale);
    updateMarkerScale();

    this.requestGPS();
  },

  requestGPS: function() {
    _gpsDebugSet("requestGPS: entry");
    if (!navigator.geolocation) { _gpsDebugSet("no geolocation"); return; }
    if (!settings.current.showLocation) { _gpsDebugSet("showLocation=off"); return; }
    // URL-restore (hash carries lat/lon/z) means we must NOT jump the map
    // to the GPS fix — the user just clicked a shared link and wants that
    // view. The dot itself is still expected though.
    var suppressView = !!(location.hash && location.hash.length > 1);
    var standalone = window.matchMedia && window.matchMedia("(display-mode: standalone)").matches;
    _gpsDebugSet("getCurrentPosition suppressView=" + suppressView + " pwa=" + standalone);
    navigator.geolocation.getCurrentPosition(
      function(pos) {
        _gpsDebugSet("cb: showLoc=" + settings.current.showLocation);
        if (!settings.current.showLocation) return;
        var lat = pos.coords.latitude;
        var lon = pos.coords.longitude;
        // PWA-Fix: at standalone startup Leaflet's map container often
        // still has zero size when the geolocation callback lands (the
        // OS shell chrome is still resolving). Rendering a marker at
        // that moment places it in a viewport of 0×0 → invisible even
        // though the leaflet layers are added correctly. invalidateSize
        // forces a fresh size measurement + tile/pane recompute; the
        // subsequent setUserLocationMarker then lands in a real viewport.
        state.map.invalidateSize();
        if (!suppressView) {
          state.map.setView([lat, lon], CONFIG.defaultZoom);
          stopsLayer.loadAll(lat, lon, 5000);
        }
        // whenReady runs synchronously if the map has already fired
        // load; otherwise it queues until the map is fully initialised.
        // Handles the PWA case where the map isn't quite ready yet.
        state.map.whenReady(function() {
          setUserLocationMarker(lat, lon);
        });
        // Belt-and-suspenders retries. Each retry also invalidates size
        // once more, in case the standalone chrome only settled after
        // our first attempt.
        setTimeout(function() {
          state.map.invalidateSize();
          setUserLocationMarker(lat, lon);
        }, 100);
        setTimeout(function() {
          state.map.invalidateSize();
          setUserLocationMarker(lat, lon);
        }, 1000);
        setTimeout(function() { setUserLocationMarker(lat, lon); }, 5000);
      },
      function(err) {
        _gpsDebugSet("err:" + (err && err.code));
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
    );
  },
};

// Diagnostic panel — visible only when the URL carries ?gpsdebug=1.
// Renders a small status pill in the bottom-left of the viewport showing
// the last thing setUserLocationMarker / requestGPS did. Ships in-prod
// because the bug reproduces on user devices we can't reach with
// DevTools. Zero visual footprint when the flag isn't set.
var _gpsDebugEl = null;
function _gpsDebugSet(msg) {
  try {
    if (typeof URLSearchParams === "undefined") return;
    var params = new URLSearchParams(location.search);
    if (params.get("gpsdebug") !== "1") return;
    if (!_gpsDebugEl) {
      _gpsDebugEl = document.createElement("div");
      _gpsDebugEl.id = "gps-debug";
      _gpsDebugEl.style.cssText =
        "position:fixed;bottom:8px;left:8px;z-index:9999;" +
        "background:rgba(0,0,0,0.85);color:#fff;padding:4px 8px;" +
        "font:11px/1.3 monospace;border-radius:4px;max-width:60vw;" +
        "pointer-events:none;";
      document.body.appendChild(_gpsDebugEl);
    }
    var ts = new Date().toISOString().slice(11, 19);
    _gpsDebugEl.textContent = ts + " " + msg;
  } catch (e) {}
}

// GPS dot: divIcon-based marker in a dedicated pane that renders ABOVE
// the bus markers. The prior implementation used L.circleMarker in the
// default overlayPane (z-index 400) — bus markers live in markerPane
// (z-index 600), so when the user's GPS position happened to coincide
// with a bus cluster, the blue dot was hidden underneath. A dedicated
// pane at z-index 650 keeps the location dot on top of everything.
var _GPS_PANE = "userLocationPane";
var _USER_LOCATION_ICON = null;
function _ensureUserLocationPaneAndIcon() {
  if (!state.map) return null;
  if (!state.map.getPane(_GPS_PANE)) {
    var pane = state.map.createPane(_GPS_PANE);
    pane.style.zIndex = "650";
    // Not interactive: clicks fall through to buses/stops underneath.
    pane.style.pointerEvents = "none";
  }
  if (_USER_LOCATION_ICON === null) {
    _USER_LOCATION_ICON = L.divIcon({
      className: "user-location-marker",
      html: '<span class="user-location-marker__dot"></span>',
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });
  }
  return _USER_LOCATION_ICON;
}

export function setUserLocationMarker(lat, lon) {
  if (!settings.current.showLocation) { _gpsDebugSet("setMarker skipped: showLoc=off"); return; }
  if (!state.map) { _gpsDebugSet("setMarker skipped: no map"); return; }
  var icon = _ensureUserLocationPaneAndIcon();
  if (!icon) { _gpsDebugSet("setMarker: no icon"); return; }
  var ll = [lat, lon];
  if (state._userLocationMarker && !state._userLocationMarker._map) {
    _gpsDebugSet("setMarker: stale ref detected, recreating");
    state._userLocationMarker = null;
  }
  if (state._userLocationMarker) {
    state._userLocationMarker.setLatLng(ll);
    _gpsDebugSet("setMarker: setLatLng " + lat.toFixed(4) + "," + lon.toFixed(4));
  } else {
    state._userLocationMarker = L.marker(ll, {
      icon: icon,
      pane: _GPS_PANE,
      interactive: false,
      keyboard: false,
      zIndexOffset: 1000,
    }).addTo(state.map);
    _gpsDebugSet("setMarker: created @" + lat.toFixed(4) + "," + lon.toFixed(4)
                 + " map=" + !!state._userLocationMarker._map);
  }
}

// === STOPS LAYER ===
var STOPS_CACHE_KEY = 'busradar_stops_v2';
var STOPS_CACHE_TTL = 24 * 60 * 60 * 1000;

export var stopsLayer = {
  minZoom: 14,

  init: function() {
    state.stopLayer = L.layerGroup().addTo(state.map);
    var self = this;
    state.map.on('zoomend', function() {
      var zoom = state.map.getZoom();
      if (zoom >= self.minZoom) {
        state.stopLayer.addTo(state.map);
        var center = state.map.getCenter();
        var bounds = state.map.getBounds();
        var radius = Math.round(center.distanceTo(bounds.getNorthEast()));
        self.loadAll(center.lat, center.lng, Math.min(radius, 20000));
      } else {
        state.map.removeLayer(state.stopLayer);
      }
    });
    this.loadFromCache();
  },

  loadFromCache: function() {
    try {
      var raw = localStorage.getItem(STOPS_CACHE_KEY);
      if (!raw) return;
      var cached = JSON.parse(raw);
      if (Date.now() - cached.ts > STOPS_CACHE_TTL) {
        localStorage.removeItem(STOPS_CACHE_KEY);
        return;
      }
      var stops = cached.stops || [];
      stops.forEach(function(stop) {
        if (state.allStops.has(stop.lid)) return;
        stopsLayer.addStopMarker(stop);
      });
    } catch (e) {}
  },

  saveToCache: function() {
    try {
      var stops = [];
      state.allStops.forEach(function(entry) {
        stops.push(entry.data);
      });
      localStorage.setItem(STOPS_CACHE_KEY, JSON.stringify({ ts: Date.now(), stops: stops }));
    } catch (e) {}
  },

  addStopMarker: function(stop) {
    if (state.allStops.has(stop.lid)) return;
    var label = stop.name + (stop.platform ? ' (' + t('platform_prefix') + ' ' + stop.platform + ')' : '');
    var m = L.circleMarker([stop.lat, stop.lon], {
      radius: 6,
      fillOpacity: 1,
      weight: 1.5,
      interactive: true,
      className: 'stop-marker',
    });
    m.bindTooltip(label, { className: 'stop-tooltip', direction: 'top', offset: [0, -6] });
    m.on('click', function() { state._userInteractionSeq++; ui.showStationBoard(stop); });
    m.addTo(state.stopLayer);
    state.allStops.set(stop.lid, { marker: m, data: stop });
  },

  loadAll: function(lat, lon, radius) {
    if (state.map.getZoom() < this.minZoom) return;
    var now = Date.now();
    var key = Math.round(lat * 100) + ',' + Math.round(lon * 100) + ',' + radius;
    if (this._lastKey === key && this._lastFetch && (now - this._lastFetch) < 30000) return;
    this._lastFetch = now;
    this._lastKey = key;
    api.getStops(lat, lon, radius || 5000).then(function(data) {
      var stops = data.stops || [];
      var added = false;
      stops.forEach(function(stop) {
        if (state.allStops.has(stop.lid)) return;
        stopsLayer.addStopMarker(stop);
        added = true;
      });
      if (added) stopsLayer.saveToCache();
    }).catch(function() {});
  },

  update: function(vehicles) {
    var added = false;
    vehicles.forEach(function(v) {
      if (!v.stops) return;
      v.stops.forEach(function(s) {
        if (!s.lid || s.lat === 0 || s.lon === 0) return;
        if (state.allStops.has(s.lid)) return;
        stopsLayer.addStopMarker(s);
        added = true;
      });
    });
    if (added) stopsLayer.saveToCache();
  },
};

// === MARKERS MODULE ===
export var markers = {
  createIcon: function(vehicle) {
    var cls = getDelayClass(vehicle.delay);
    var rotation = vehicle._bearing;

    var div = document.createElement('div');
    div.className = 'bus-marker bus-marker--' + cls;
    div.setAttribute('role', 'button');
    div.setAttribute('aria-label',
      t('aria_bus', {line: vehicle.line, dir: vehicle.direction, delay: getDelayText(vehicle.delay)}));

    if (rotation !== null) {
      var arrow = document.createElement('span');
      arrow.className = 'bus-marker__arrow';
      arrow.style.transform = 'rotate(' + rotation + 'deg)';
      div.appendChild(arrow);
    }

    var lineSpan = document.createElement('span');
    lineSpan.className = 'bus-marker__line';
    lineSpan.textContent = vehicle.line;
    div.appendChild(lineSpan);

    return L.divIcon({
      html: div.outerHTML,
      className: 'bus-marker-wrapper',
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
  },

  calcBearing: function(lat1, lon1, lat2, lon2) {
    var toRad = Math.PI / 180;
    var dLon = (lon2 - lon1) * toRad;
    var y = Math.sin(dLon) * Math.cos(lat2 * toRad);
    var x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
            Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos(dLon);
    return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
  },

  animateMarker: function(entry, targetLatLng) {
    if (!settings.current.interpolation || state.map.getZoom() < CONFIG.zoomThresholdNoAnimation) {
      entry.marker.setLatLng(targetLatLng);
      return;
    }

    var current = entry.marker.getLatLng();
    var dx = targetLatLng[1] - current.lng;
    var dy = targetLatLng[0] - current.lat;
    var dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 0.00005) return;

    if (entry._animFrame) cancelAnimationFrame(entry._animFrame);
    var start = current;
    var startTime = performance.now();
    var duration = state.currentInterval;

    function step(now) {
      var prog = Math.min((now - startTime) / duration, 1);
      var lat = start.lat + (targetLatLng[0] - start.lat) * prog;
      var lng = start.lng + (targetLatLng[1] - start.lng) * prog;
      entry.marker.setLatLng([lat, lng]);
      if (prog < 1) {
        entry._animFrame = requestAnimationFrame(step);
      }
    }
    entry._animFrame = requestAnimationFrame(step);
  },

  calcInitialBearing: function(vehicle) {
    if (!vehicle.stops || vehicle.stops.length < 2) return null;
    var first = null, second = null;
    for (var i = 0; i < vehicle.stops.length; i++) {
      var s = vehicle.stops[i];
      if (s.lat && s.lon && s.lat !== 0 && s.lon !== 0) {
        if (!first) { first = s; }
        else if (s.lat !== first.lat || s.lon !== first.lon) { second = s; break; }
      }
    }
    if (first && second) {
      return this.calcBearing(first.lat, first.lon, second.lat, second.lon);
    }
    return null;
  },

  updateAll: function(vehicles) {
    // `vehicles` here is the FULL server payload (the SSE handler returns
    // the HAFAS ring, which extends past the four-corner viewport). We
    // bbox-filter inside this function rather than upstream so we can
    // distinguish two different "missing from rendered set" cases:
    //
    //   (a) Vehicle still in the server's ring but its new position fell
    //       outside the current map.getBounds() — user-visible: the bus
    //       just drove off-screen. Remove the marker immediately. There's
    //       nothing to "wait for" because the server keeps confirming the
    //       vehicle exists, we just don't want it on this user's map.
    //
    //   (b) Vehicle not in the server's payload at all — the journey
    //       ended, HAFAS dropped it, the bus left the ring entirely.
    //       Apply the missedCycles grace so a one-frame drop-out doesn't
    //       blink the marker; remove after graceperiodCycles ticks.
    //
    // The previous shape (client-side bbox filter UPSTREAM of updateAll)
    // collapsed case (a) into case (b), leaving the marker frozen at its
    // last visible position for a full grace window — that's the
    // "buses stuck on the map when they drive out of the viewport" bug.
    var bounds = state.map ? state.map.getBounds() : null;
    var swLat = bounds ? bounds.getSouth() : -Infinity;
    var neLat = bounds ? bounds.getNorth() : Infinity;
    var swLon = bounds ? bounds.getWest() : -Infinity;
    var neLon = bounds ? bounds.getEast() : Infinity;
    function inBbox(lat, lon) {
      return lat >= swLat && lat <= neLat && lon >= swLon && lon <= neLon;
    }

    var inServerRing = new Set();
    var visibleCount = 0;

    vehicles.forEach(function(v) {
      inServerRing.add(v.jid);
      var existing = state.vehicles.get(v.jid);
      var visible = inBbox(v.lat, v.lon);

      if (!visible) {
        // Case (a). Remove the marker now (unless this is the selected
        // journey — we keep that one rendered even off-bbox so the user
        // can still see "their" bus).
        if (existing && state.selectedJid !== v.jid) {
          existing.marker.remove();
          state.vehicles.delete(v.jid);
        }
        return;
      }

      visibleCount++;

      if (existing) {
        var currentPos = existing.marker.getLatLng();
        var newLat = v.lat;
        var newLon = v.lon;

        if (currentPos.lat !== newLat || currentPos.lng !== newLon) {
          v._bearing = markers.calcBearing(currentPos.lat, currentPos.lng, newLat, newLon);
          markers.animateMarker(existing, [newLat, newLon]);
        } else {
          v._bearing = existing.data._bearing || null;
        }
        var oldCls = getDelayClass(existing.data.delay);
        var newCls = getDelayClass(v.delay);
        if (oldCls !== newCls || existing.data.line !== v.line || existing.data._bearing !== v._bearing) {
          existing.marker.setIcon(markers.createIcon(v));
        }
        existing.data = v;
        existing.missedCycles = 0;
      } else {
        v._bearing = markers.calcInitialBearing(v);
        var marker = L.marker([v.lat, v.lon], {
          icon: markers.createIcon(v),
          keyboard: true,
          alt: 'Bus ' + v.line,
        }).addTo(state.map);

        marker.on('click', function() {
          state._userInteractionSeq++;
          var entry = state.vehicles.get(v.jid);
          if (entry) ui.selectJourney(entry.data);
        });

        state.vehicles.set(v.jid, { marker: marker, data: v, missedCycles: 0 });
      }
    });

    state.vehicles.forEach(function(entry, jid) {
      if (!inServerRing.has(jid)) {
        // Case (b): vehicle not in this server payload. Two sub-cases:
        //
        //   (b1) Marker's last known position is OUTSIDE the visible
        //        bbox. The bus already drove off-screen and the server
        //        has now dropped it from the ring entirely. Removing
        //        immediately is the user-visible-correct call —
        //        keeping the missedCycles grace here was the residual
        //        "frozen marker for several ticks" report after v1.0.26:
        //        the v1.0.26 fix only caught the case where a fresh
        //        position landed off-bbox, but a bus leaving the ring
        //        outright (no fresh position at all) still fell back
        //        to the grace path.
        //
        //   (b2) Last known position is INSIDE the bbox. The vehicle
        //        was just there and is suddenly missing without an
        //        off-screen explanation — keep the grace so a single
        //        dropped frame doesn't blink the marker.
        var lastLat = entry.data ? entry.data.lat : null;
        var lastLon = entry.data ? entry.data.lon : null;
        var lastVisible = lastLat != null && lastLon != null
          ? inBbox(lastLat, lastLon)
          : false;
        if (!lastVisible && state.selectedJid !== jid) {
          // (b1) — drop now.
          entry.marker.remove();
          state.vehicles.delete(jid);
          return;
        }
        // (b2) — grace.
        entry.missedCycles++;
        if (entry.missedCycles >= CONFIG.graceperiodCycles) {
          if (state.selectedJid === jid) {
            return;
          }
          entry.marker.remove();
          state.vehicles.delete(jid);
        }
      }
    });

    // Expose so the status counter can show the actually-visible count
    // without re-filtering the array upstream.
    markers._lastVisibleCount = visibleCount;
  },

  highlightSelected: function(jid) {
    state.vehicles.forEach(function(entry, id) {
      var el = entry.marker.getElement();
      if (!el) return;
      var inner = el.querySelector('.bus-marker');
      if (inner) {
        if (id === jid) inner.classList.add('bus-marker--selected');
        else inner.classList.remove('bus-marker--selected');
      }
    });
  },
};
