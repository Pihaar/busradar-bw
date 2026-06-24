import { CONFIG } from './config.js';
import { state, settings, t, decodePolyline, formatTime, getDayOffset, parseHafasTimeToMin, calcDelay, getDelayClass, getDelayText, extractHafasMessages } from './state.js';
import { api, urlState } from './api.js';
import { markers, stopsLayer } from './map.js';
import { announce } from './status.js';

// === UI MODULE ===

function _createStateItem(cls, text, ariaLabel) {
  var li = document.createElement('li');
  li.className = cls;
  if (ariaLabel) li.setAttribute('aria-label', ariaLabel);
  if (text) li.textContent = text;
  return li;
}

export var ui = {
  panel: null,
  detailLine: null,
  detailDir: null,
  detailDelay: null,
  stopList: null,
  departureList: null,

  init: function() {
    this.panel = document.getElementById('detail-panel');
    this.detailLine = document.getElementById('detail-line');
    this.detailDir = document.getElementById('detail-direction');
    this.detailDelay = document.getElementById('detail-delay');
    this.stopList = document.getElementById('stop-list');
    this.departureList = document.getElementById('departure-list');

    document.getElementById('detail-back').addEventListener('click', function() {
      state._userInteractionSeq++;
      if (urlState._pushCount > 0) {
        history.back();
      } else {
        ui.closePanel();
      }
    });

    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        var aboutDlg = document.getElementById('about-dialog');
        if (aboutDlg && aboutDlg.open) return;
        if (state.panelState !== 'hidden') {
          state._userInteractionSeq++;
          ui.closePanel();
        }
      }
    });

    document.getElementById('tab-stops').addEventListener('click', function() {
      state._userInteractionSeq++;
      ui.switchTab('stops');
    });
    document.getElementById('tab-departures').addEventListener('click', function() {
      state._userInteractionSeq++;
      ui.switchTab('departures');
    });
    document.getElementById('tab-arrivals').addEventListener('click', function() {
      state._userInteractionSeq++;
      ui.switchTab('arrivals');
    });

    this.initBottomSheet();
    this.initJourneyActions();
    this.initSwipeTabs();

    document.getElementById('detail-share').addEventListener('click', function(e) {
      e.stopPropagation();
      if (state._cancelMapClick) state._cancelMapClick();
      ui.share();
    });
  },

  _disableFollow: function() {
    state.followBus = false;
    state._followPanning = false;
    clearTimeout(state._followPanTimeout);
    var btn = document.getElementById('btn-follow');
    if (btn) {
      btn.classList.remove('action-btn--active');
      btn.setAttribute('aria-pressed', 'false');
    }
    ui._updateFollowUrl();
  },

  _updateFollowUrl: function() {
    var params = urlState.parse();
    if (state.followBus) {
      params.follow = '1';
    } else {
      delete params.follow;
    }
    urlState.replace(params);
  },

  _updateFollowButton: function() {
    var btn = document.getElementById('btn-follow');
    if (btn) {
      btn.classList.toggle('action-btn--active', state.followBus);
      btn.setAttribute('aria-pressed', String(state.followBus));
    }
  },

  showVersionUpdateBanner: function() {
    var banner = document.getElementById('version-banner');
    if (!banner || !banner.hidden) return;
    banner.hidden = false;
    var reloadBtn = banner.querySelector('.version-banner__reload');
    var dismissBtn = banner.querySelector('.version-banner__dismiss');
    if (reloadBtn) {
      reloadBtn.addEventListener('click', function() {
        location.reload();
      }, { once: true });
    }
    if (dismissBtn) {
      dismissBtn.addEventListener('click', function() {
        banner.hidden = true;
      }, { once: true });
    }
  },

  initJourneyActions: function() {
    document.getElementById('btn-follow').addEventListener('click', function() {
      state.followBus = !state.followBus;
      ui._updateFollowButton();
      ui._updateFollowUrl();
      announce(state.followBus ? t('follow_active') : t('follow_inactive'));
      if (state.followBus && state.selectedJid) {
        if (state._notStartedJid) {
          var jData = state.selectedJourneyData;
          if (jData) {
            var jStopL = (jData.journey || {}).stopL || [];
            var jLocL = (jData.common || {}).locL || [];
            if (jStopL.length > 0) {
              var fLoc = jLocL[jStopL[0].locX] || {};
              if (fLoc.crd && fLoc.crd.y && fLoc.crd.x) {
                state.map.panTo([fLoc.crd.y / 1e6, fLoc.crd.x / 1e6], {duration: 1});
              }
            }
          }
        } else {
          var entry = state.vehicles.get(state.selectedJid);
          if (entry) {
            var target = L.latLng(entry.data.lat, entry.data.lon);
            var dist = state.map.getCenter().distanceTo(target);
            if (dist > 5) {
              state._followPanning = true;
              if (dist > 3000) {
                state.map.setView(target, state.map.getZoom(), { animate: false });
                state._followPanning = false;
              } else {
                state.map.panTo(target, { duration: Math.min(dist / 500, 2) });
                state.map.once('moveend', function() { state._followPanning = false; });
                clearTimeout(state._followPanTimeout);
                state._followPanTimeout = setTimeout(function() { state._followPanning = false; }, 2500);
              }
            }
          }
        }
      }
    });

    document.getElementById('btn-fitroute').addEventListener('click', function() {
      if (!state.routeCoords || state.routeCoords.length < 2) return;
      ui._disableFollow();

      var panelRect = document.getElementById('detail-panel').getBoundingClientRect();
      var isDesktop = window.innerWidth >= 1024;
      var opts = { maxZoom: 16 };
      if (isDesktop) {
        opts.paddingBottomRight = [panelRect.width + 30, 30];
        opts.paddingTopLeft = [30, 30];
      } else {
        var bottomPad = Math.max(30, Math.min(window.innerHeight * 0.55, window.innerHeight - panelRect.top + 30));
        opts.paddingBottomRight = [30, bottomPad];
        opts.paddingTopLeft = [30, 80];
      }

      state._navigating = true;
      state.map.fitBounds(L.latLngBounds(state.routeCoords), opts);
      state.map.once('moveend', function() { state._navigating = false; });
      setTimeout(function() { state._navigating = false; }, 3000);
    });
  },

  initSwipeTabs: function() {
    var content = document.getElementById('detail-content');
    if (!content) return;
    var startX = 0, startY = 0, active = false, captured = false;

    content.addEventListener('pointerdown', function(e) {
      if (!e.isPrimary || state._tabMode !== 'station') { active = false; captured = false; return; }
      startX = e.clientX; startY = e.clientY;
      active = true; captured = false;
    });

    content.addEventListener('pointermove', function(e) {
      if (!active || !e.isPrimary) return;
      var absDx = Math.abs(e.clientX - startX), absDy = Math.abs(e.clientY - startY);
      if (!captured) {
        if (absDx < 10 && absDy < 10) return;
        if (absDx <= absDy * 1.5) { active = false; return; }
        captured = true;
        try { content.setPointerCapture(e.pointerId); } catch(_) {}
      }
    });

    content.addEventListener('pointerup', function(e) {
      if (!active || !e.isPrimary) { active = false; captured = false; return; }
      var dx = e.clientX - startX;
      active = false; captured = false;
      try { content.releasePointerCapture(e.pointerId); } catch(_) {}
      if (state._tabMode !== 'station') return;
      if (Math.abs(dx) < 30) return;
      state._userInteractionSeq++;
      if (dx < 0 && state._activeTab === 'departures') ui.switchTab('arrivals');
      else if (dx > 0 && state._activeTab === 'arrivals') ui.switchTab('departures');
    });

    content.addEventListener('pointercancel', function(e) {
      active = false; captured = false;
      try { content.releasePointerCapture(e.pointerId); } catch(_) {}
    });
    content.addEventListener('lostpointercapture', function() { active = false; captured = false; });
  },

  initBottomSheet: function() {
    var handle = this.panel.querySelector('.detail-handle');
    var header = this.panel.querySelector('.detail-header');
    var startY = 0, startX = 0, startHeight = 0, isDown = false, isDragging = false;

    function onDown(e) {
      if (!e.isPrimary) return;
      if (e.target.closest('button, a')) return;
      isDown = true;
      startY = e.clientY;
      startX = e.clientX;
      startHeight = ui.panel.offsetHeight;
      isDragging = false;
      e.currentTarget.setPointerCapture(e.pointerId);
      if (state._cancelMapClick) state._cancelMapClick();
    }
    function onMove(e) {
      if (!e.isPrimary || !isDown) return;
      var dy = e.clientY - startY;
      var absDy = Math.abs(dy);
      var absDx = Math.abs(e.clientX - startX);

      if (!isDragging) {
        if (absDy < 10) return;
        if (absDx > absDy) return;
        var content = document.getElementById('detail-content');
        if (content && content.contains(e.target)) {
          if (content.scrollTop > 0) return;
          if (dy < 0) return;
        }
        isDragging = true;
        ui.panel.classList.remove('detail-panel--collapsed', 'detail-panel--half', 'detail-panel--open');
        ui.panel.style.height = startHeight + 'px';
        ui.panel.style.transition = 'none';
      }
      var dragDy = startY - e.clientY;
      var newHeight = Math.max(72, Math.min(window.innerHeight * 0.9, startHeight + dragDy));
      ui.panel.style.height = newHeight + 'px';
    }
    function onUp(e) {
      if (!e.isPrimary || !isDragging) { isDown = false; return; }
      isDown = false;
      isDragging = false;
      ui.panel.style.transition = '';
      var currentHeight = ui.panel.offsetHeight;
      var viewH = window.innerHeight;
      var ratio = currentHeight / viewH;

      if (ratio < 0.25) {
        ui.setPanelState('collapsed');
      } else if (ratio < 0.75) {
        ui.setPanelState('half');
      } else {
        ui.setPanelState('open');
      }
    }
    function onCancel(e) {
      if (!e.isPrimary) return;
      isDown = false;
      isDragging = false;
      ui.panel.style.transition = '';
    }

    handle.addEventListener('pointerdown', onDown);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onCancel);
    handle.addEventListener('lostpointercapture', onCancel);
    header.addEventListener('pointerdown', onDown);
    header.addEventListener('pointermove', onMove);
    header.addEventListener('pointerup', onUp);
    header.addEventListener('pointercancel', onCancel);
    header.addEventListener('lostpointercapture', onCancel);
  },

  setPanelState: function(newState) {
    state.panelState = newState;
    this.panel.classList.remove('detail-panel--collapsed', 'detail-panel--half', 'detail-panel--open');
    this.panel.setAttribute('aria-expanded', newState === 'open' ? 'true' : 'false');
    this.panel.style.height = '';

    if (newState === 'hidden') {
      if (state.followBus) ui._disableFollow();
    }

    if (newState === 'hidden') {
      this.panel.inert = true;
    } else {
      this.panel.inert = false;
      if (newState === 'collapsed') {
        this.panel.classList.add('detail-panel--collapsed');
      } else if (newState === 'half') {
        this.panel.classList.add('detail-panel--half');
      } else if (newState === 'open') {
        this.panel.classList.add('detail-panel--open');
      }
    }
  },

  closePanel: function() {
    this.setPanelState('hidden');
    state.selectedJid = null;
    state.selectedJourneyData = null;
    state.selectedStop = null;
    state._notStartedJid = null;
    state._notStartedSince = 0;
    state._notStartedLastPoll = 0;
    if (state._selectedStopMarker) { state._selectedStopMarker.remove(); state._selectedStopMarker = null; }
    markers.highlightSelected(null);
    this.clearRoute();
    document.getElementById('journey-actions').hidden = true;
    urlState.saveMapPosition();
  },

  clearRoute: function() {
    if (state.routeLayer) {
      state.routeLayer.remove();
      state.routeLayer = null;
    }
    state.routeStopMarkers.forEach(function(m) { m.remove(); });
    state.routeStopMarkers = [];
    state.routeCoords = null;
  },

  selectJourney: function(vehicle, skipHistory) {
    if (state._cancelMapClick) state._cancelMapClick();
    state._navigating = true;
    ui._disableFollow();
    state._notStartedJid = null;
    state._notStartedSince = 0;
    state._notStartedLastPoll = 0;
    state.selectedJid = vehicle.jid;
    state.selectedStop = null;
    if (state._selectedStopMarker) { state._selectedStopMarker.remove(); state._selectedStopMarker = null; }
    markers.highlightSelected(vehicle.jid);
    if (!skipHistory) {
      var center = state.map.getCenter();
      var zoom = state.map.getZoom();
      urlState.push({ jid: vehicle.jid, lat: center.lat.toFixed(5), lon: center.lng.toFixed(5), z: zoom });
    }
    setTimeout(function() { state._navigating = false; }, 600);

    document.getElementById('journey-actions').hidden = true;

    this.detailLine.textContent = vehicle.lineFull || vehicle.line;
    this.detailDir.textContent = vehicle.direction;

    var cls = getDelayClass(vehicle.delay);
    this.detailDelay.textContent = getDelayText(vehicle.delay);
    this.detailDelay.className = 'detail-delay-badge detail-delay-badge--' + cls;

    this.setTabMode('journey');
    this.stopList.replaceChildren(_createStateItem('loading-spinner', '', t('loading_stops')));
    this.switchTab('stops');
    if (state.panelState === 'hidden' || state.panelState === 'collapsed') {
      this.setPanelState('half');
    }

    api.getJourney(vehicle.jid, {userInitiated: true}).then(function(data) {
      state.selectedJourneyData = data;
      ui.renderJourneyStops(data, vehicle);
      ui.drawRoute(data, vehicle);
      announce(t('route_loaded', {line: vehicle.line}));
    }).catch(function(err) {
      if (err.name === 'AbortError') return;
      ui.stopList.replaceChildren(_createStateItem('empty-state', t('route_unavailable')));
    });
  },

  // Build the stop time display inside `timesEl`. Handles three cases:
  //   start stop (only departure), end stop (only arrival), intermediate.
  // For intermediate stops with realtime dwell >= 1 min the arrival and
  // departure are stacked on two lines (each with its own planned/real and
  // delay badge); otherwise a single time row is shown.
  _populateStopTimes: function(timesEl, stop) {
    timesEl.replaceChildren();

    var hasArr = !!(stop.aTimeS || stop.aTimeR);
    var hasDep = !!(stop.dTimeS || stop.dTimeR);
    var aDelay = calcDelay(stop.aTimeS, stop.aTimeR);
    var dDelay = calcDelay(stop.dTimeS, stop.dTimeR);

    // Detect realtime dwell (>= 1 min between real arrival and real departure).
    var dwell = null;
    if (hasArr && hasDep && stop.aTimeR && stop.dTimeR) {
      var aR = parseHafasTimeToMin(stop.aTimeR);
      var dR = parseHafasTimeToMin(stop.dTimeR);
      if (aR !== null && dR !== null) {
        var diff = dR - aR;
        if (diff < -720) diff += 1440;
        else if (diff > 720) diff -= 1440;
        if (diff >= 1) dwell = diff;
      }
    }

    if (hasArr && hasDep && dwell !== null) {
      // Two-line layout: arrival above, departure below, both with their own delay.
      timesEl.classList.add('stop-times--split');
      var arrRow = ui._buildStopTimeRow(stop.aTimeS, stop.aTimeR, aDelay, t('stop_arrival_label'));
      arrRow.classList.add('stop-time-row--arrival');
      timesEl.appendChild(arrRow);
      var depRow = ui._buildStopTimeRow(stop.dTimeS, stop.dTimeR, dDelay, t('stop_departure_label'));
      depRow.classList.add('stop-time-row--departure');
      depRow.setAttribute('aria-label', t('stop_dwell_aria', {n: dwell}));
      timesEl.appendChild(depRow);
    } else {
      // Single row: prefer departure side for intermediates and starts; fall
      // back to arrival side for end stops or when only arrival is set.
      timesEl.classList.remove('stop-times--split');
      var timeS, timeR, rowDelay;
      if (hasDep) {
        timeS = stop.dTimeS;
        timeR = stop.dTimeR;
        rowDelay = dDelay !== null ? dDelay : aDelay;
      } else {
        timeS = stop.aTimeS;
        timeR = stop.aTimeR;
        rowDelay = aDelay;
      }
      if (timeS || timeR) {
        var row = ui._buildStopTimeRow(timeS, timeR, rowDelay, null);
        row.classList.add('stop-time-row--single');
        timesEl.appendChild(row);
      }
    }
  },

  // Build one time-row element: planned/real times plus an optional delay badge.
  // `label` (when given) is rendered as a small prefix for split rows.
  _buildStopTimeRow: function(timeS, timeR, delay, label) {
    var row = document.createElement('span');
    row.className = 'stop-time-row';

    if (label) {
      var lbl = document.createElement('span');
      lbl.className = 'stop-time-label';
      lbl.textContent = label;
      row.appendChild(lbl);
    }

    if (timeR && timeS && timeR !== timeS) {
      var planned = document.createElement('span');
      planned.className = 'stop-time-planned';
      planned.textContent = formatTime(timeS);
      row.appendChild(planned);
      var real = document.createElement('span');
      real.className = 'stop-time-real';
      real.textContent = formatTime(timeR);
      row.appendChild(real);
    } else if (timeS || timeR) {
      var only = document.createElement('span');
      only.className = 'stop-time-only';
      only.textContent = formatTime(timeR || timeS);
      row.appendChild(only);
    }

    if (delay !== null && delay !== undefined && delay !== 0) {
      var badge = document.createElement('span');
      badge.className = 'stop-delay stop-delay--' + (delay > 5 ? 'major' : delay > 2 ? 'delayed' : 'ontime');
      badge.textContent = getDelayText(delay);
      row.appendChild(badge);
    }

    return row;
  },

  renderJourneyStops: function(data, vehicle) {
    var journey = data.journey || {};
    var stopL = journey.stopL || [];
    var common = data.common || {};
    var locL = common.locL || [];

    var oldMsgContainer = this.stopList.parentNode.querySelector('.journey-msg-container');
    if (oldMsgContainer) oldMsgContainer.remove();

    var progressEl = document.getElementById('stop-progress');
    while (this.stopList.firstChild) {
      if (this.stopList.firstChild === progressEl) break;
      this.stopList.removeChild(this.stopList.firstChild);
    }
    if (!progressEl) {
      progressEl = document.createElement('div');
      progressEl.className = 'stop-list-progress';
      progressEl.id = 'stop-progress';
      this.stopList.appendChild(progressEl);
    }

    var msgs = extractHafasMessages(common, journey.msgL, stopL);
    if (msgs.journeyLevel.length > 0) {
      var msgContainer = document.createElement('div');
      msgContainer.className = 'journey-msg-container';
      msgs.journeyLevel.forEach(function(m) {
        var div = document.createElement('div');
        div.className = 'journey-msg-banner';
        var span = document.createElement('span');
        span.className = 'journey-msg-text';
        span.textContent = m.text;
        div.appendChild(span);
        msgContainer.appendChild(div);
      });
      ui.stopList.parentNode.insertBefore(msgContainer, ui.stopList);
    }

    var cumulativeDayOffset = 0;
    var prevStopMin = null;
    var shownMsgLocX = Object.create(null);

    stopL.forEach(function(stop, idx) {
      var locIdx = stop.locX != null ? stop.locX : -1;
      var loc = (locIdx >= 0 && locIdx < locL.length) ? locL[locIdx] : {};

      var li = document.createElement('li');
      li.className = 'stop-item';

      var dot = document.createElement('div');
      dot.className = 'stop-dot';
      var depTime = stop.dTimeR || stop.dTimeS || stop.aTimeR || stop.aTimeS;
      if (depTime && state.serverTimeMin !== null) {
        var stopMin = parseHafasTimeToMin(depTime);
        var elapsed = Math.round((Date.now() - state.serverTimeStamp) / 60000);
        var nowMin = state.serverTimeMin + elapsed;
        if (stopMin !== null) {
          if (nowMin > 1080 && stopMin < 360) stopMin += 1440;
          if (nowMin < 360 && stopMin > 1080) stopMin -= 1440;
          if (stopMin <= nowMin) {
            dot.classList.add('stop-dot--passed');
          }
        }
      }

      var info = document.createElement('div');
      info.className = 'stop-info';

      var nameEl = document.createElement('div');
      nameEl.className = 'stop-name';
      nameEl.textContent = loc.name || t('stop_fallback', {idx: idx + 1});

      var timesEl = document.createElement('div');
      timesEl.className = 'stop-times';
      ui._populateStopTimes(timesEl, stop);

      var badgeTime = stop.dTimeS || stop.dTimeR || stop.aTimeS || stop.aTimeR || '';
      var dayOffset = getDayOffset(badgeTime);
      if (dayOffset > 0) {
        cumulativeDayOffset = dayOffset;
      } else if (cumulativeDayOffset === 0 && idx > 0 && badgeTime) {
        var curStopMin = parseHafasTimeToMin(badgeTime);
        if (prevStopMin !== null && curStopMin !== null && prevStopMin > 720 && curStopMin < 360) {
          cumulativeDayOffset = 1;
        }
      }
      if (badgeTime) {
        var curMin = parseHafasTimeToMin(badgeTime);
        if (curMin !== null) prevStopMin = curMin;
      }
      if (cumulativeDayOffset > 0) {
        var badge = document.createElement('span');
        badge.className = 'departure-day-badge';
        badge.textContent = t('day_offset_badge', {n: cumulativeDayOffset});
        badge.setAttribute('aria-label', t('day_offset_aria'));
        timesEl.appendChild(badge);
      }

      info.appendChild(nameEl);
      info.appendChild(timesEl);

      var stopLocX = stop.locX != null ? stop.locX : -1;
      if (!shownMsgLocX[stopLocX]) {
        var stopMsgs = msgs.perStopByLocX[stopLocX] || [];
        stopMsgs.forEach(function(m) {
          var msgEl = document.createElement('div');
          msgEl.className = 'stop-msg';
          msgEl.textContent = m.text;
          info.appendChild(msgEl);
        });
        if (stopMsgs.length) shownMsgLocX[stopLocX] = true;
      }

      li.appendChild(dot);
      li.appendChild(info);

      if (loc.lid) {
        nameEl.style.cursor = 'pointer';
        nameEl.style.textDecoration = 'underline';
        nameEl.style.textDecorationColor = 'var(--color-ontime)';
        nameEl.style.textUnderlineOffset = '2px';
        nameEl.addEventListener('click', function(e) {
          e.stopPropagation();
          state._navigating = true;
          state.map.setView([loc.crd.y / 1e6, loc.crd.x / 1e6], 16);

          var cachedStop = null;
          var locExtId = loc.extId || '';
          var locLat = loc.crd.y / 1e6;
          var locLon = loc.crd.x / 1e6;
          if (locExtId) {
            state.allStops.forEach(function(entry) {
              if (!cachedStop && entry.data.extId === locExtId) cachedStop = entry.data;
            });
          }
          if (!cachedStop) {
            state.allStops.forEach(function(entry) {
              var s = entry.data;
              if (s.name === loc.name || (Math.abs(s.lat - locLat) < 0.002 && Math.abs(s.lon - locLon) < 0.002 && s.name.indexOf(loc.name.split(',')[0]) >= 0)) {
                if (!cachedStop || !cachedStop.platform) cachedStop = s;
              }
            });
          }

          if (cachedStop) {
            ui.showStationBoard(cachedStop);
          } else {
            ui.showStationBoard({
              name: loc.name || '?',
              lid: loc.lid,
              lat: locLat,
              lon: locLon,
              extId: '',
              platform: '',
            });
          }
        });
      }

      ui.stopList.insertBefore(li, document.getElementById('stop-progress'));
    });

    state._currentStopL = stopL;
    setTimeout(function() {
      ui.updateStopProgress(stopL);
    }, 100);
  },

  buildLineFilter: function(data, filteredJnyL) {
    var filterEl = document.getElementById('line-filter');
    var common = data.common || {};
    var prodL = common.prodL || [];
    var jnyL = filteredJnyL || data.jnyL || [];

    var lines = new Set();
    jnyL.forEach(function(jny) {
      var prod = prodL[jny.prodX] || {};
      if (prod.nameS) lines.add(prod.nameS);
    });

    if (lines.size <= 1) {
      filterEl.hidden = true;
      return;
    }

    filterEl.replaceChildren();
    filterEl.hidden = false;

    var activeFilter = state._activeTab === 'arrivals' ? state._arrFilter : state._depFilter;

    var allBtn = document.createElement('button');
    allBtn.className = 'filter-chip' + (activeFilter === null ? ' filter-chip--active' : '');
    allBtn.textContent = t('filter_all');
    allBtn.dataset.line = '';
    allBtn.addEventListener('click', function() { ui.applyLineFilter(null); });
    filterEl.appendChild(allBtn);

    var lang = (settings.current && settings.current.lang) || 'de';
    Array.from(lines).sort(function(a, b) { return a.localeCompare(b, lang, { numeric: true }); }).forEach(function(line) {
      var btn = document.createElement('button');
      btn.className = 'filter-chip' + (line === activeFilter ? ' filter-chip--active' : '');
      btn.textContent = line;
      btn.dataset.line = line;
      btn.addEventListener('click', function() { ui.applyLineFilter(line); });
      filterEl.appendChild(btn);
    });
  },

  hideLineFilter: function() {
    var filterEl = document.getElementById('line-filter');
    filterEl.hidden = true;
    filterEl.replaceChildren();
  },

  applyLineFilter: function(line) {
    if (state._activeTab === 'arrivals') {
      state._arrFilter = line;
    } else {
      state._depFilter = line;
    }

    var filterEl = document.getElementById('line-filter');
    filterEl.querySelectorAll('.filter-chip').forEach(function(btn) {
      var isActive = (line === null && btn.dataset.line === '') || btn.dataset.line === line;
      btn.classList.toggle('filter-chip--active', isActive);
    });

    if (state._activeTab === 'arrivals' && state._stationArrData) {
      ui.renderArrivals(state._stationArrData, state._stationLoc, state._stationExtId, line);
      ui.addLoadMoreButton('arrival-list', state._stationLoc, state._stationExtId, state._stationArrDur || 60, 'ARR');
    } else if (state._stationDepData) {
      ui.renderDepartures(state._stationDepData, state._stationLoc, state._stationExtId, line);
      ui.addLoadMoreButton('departure-list', state._stationLoc, state._stationExtId, state._stationDepDur || 60, 'DEP');
    }
  },

  updateJourneyStopDelays: function(data) {
    var journey = data.journey || {};
    var stopL = journey.stopL || [];
    var items = ui.stopList.querySelectorAll('.stop-item');

    var elapsedMs = state.serverTimeStamp ? (Date.now() - state.serverTimeStamp) : 0;
    var nowMin = (state.serverTimeMin || 0) + elapsedMs / 60000;

    for (var idx = 0; idx < Math.min(stopL.length, items.length); idx++) {
      var stop = stopL[idx];
      var item = items[idx];

      var dot = item.querySelector('.stop-dot');
      if (dot) {
        var depTime = stop.dTimeR || stop.dTimeS || stop.aTimeR || stop.aTimeS;
        if (depTime) {
          var stopMin = parseHafasTimeToMin(depTime);
          if (stopMin !== null) {
            if (nowMin > 1080 && stopMin < 360) stopMin += 1440;
            if (nowMin < 360 && stopMin > 1080) stopMin -= 1440;
            dot.classList.toggle('stop-dot--passed', stopMin <= nowMin);
          }
        }
      }

      var timesEl = item.querySelector('.stop-times');
      if (timesEl) {
        // Preserve any day-offset badge that was appended after the time rows
        // (it isn't time-dependent and would otherwise be lost on rebuild).
        var dayBadge = timesEl.querySelector('.departure-day-badge');
        ui._populateStopTimes(timesEl, stop);
        if (dayBadge) timesEl.appendChild(dayBadge);
      }

      // Delay badges are now rendered inside each time row by
      // `_populateStopTimes`. Remove any leftover stop-delay element that
      // sits as a direct child of stop-info from a previous render.
      var legacyDelay = item.querySelector('.stop-info > .stop-delay');
      if (legacyDelay) legacyDelay.remove();
    }
  },

  updateStopProgress: function(stopL) {
    var progressEl = document.getElementById('stop-progress');
    if (!progressEl || !stopL || stopL.length < 2) return;

    var items = ui.stopList.querySelectorAll('.stop-item');
    if (items.length === 0) return;

    var elapsedMs = state.serverTimeStamp ? (Date.now() - state.serverTimeStamp) : 0;
    var nowMin = (state.serverTimeMin || 0) + elapsedMs / 60000;

    var times = [];
    for (var i = 0; i < stopL.length; i++) {
      var s = stopL[i];
      var timeVal = s.dTimeR || s.dTimeS || s.aTimeR || s.aTimeS;
      var min = timeVal ? parseHafasTimeToMin(timeVal) : null;
      if (min !== null) {
        if (nowMin > 1080 && min < 360) min += 1440;
        if (nowMin < 360 && min > 1080) min -= 1440;
      }
      times.push(min);
    }

    var lastPassedIdx = -1;
    for (var i = 0; i < times.length; i++) {
      if (times[i] !== null && times[i] <= nowMin) {
        lastPassedIdx = i;
      }
    }

    var listRect = ui.stopList.getBoundingClientRect();
    var pixelHeight = 0;

    if (lastPassedIdx < 0) {
      pixelHeight = 0;
    } else if (lastPassedIdx >= items.length - 1) {
      var lastItem = items[items.length - 1];
      pixelHeight = lastItem.getBoundingClientRect().top - listRect.top + 4;
    } else {
      var nextIdx = lastPassedIdx + 1;
      var lastTime = times[lastPassedIdx];
      var nextTime = times[nextIdx];
      var timeDiff = (nextTime !== null && lastTime !== null) ? nextTime - lastTime : 0;
      var progress = timeDiff > 0 ? (nowMin - lastTime) / timeDiff : 0;
      progress = Math.max(0, Math.min(1, progress));

      var lastItemRect = items[lastPassedIdx].getBoundingClientRect();
      var nextItemRect = items[nextIdx].getBoundingClientRect();
      var lastY = lastItemRect.top - listRect.top + 4;
      var nextY = nextItemRect.top - listRect.top + 4;
      pixelHeight = lastY + (nextY - lastY) * progress;
    }

    progressEl.style.height = pixelHeight + 'px';
  },

  drawRoute: function(data, vehicle) {
    this.clearRoute();
    var common = data.common || {};
    var polyL = common.polyL || [];
    var journey = data.journey || {};
    var locL = common.locL || [];
    var stopL = journey.stopL || [];

    if (polyL.length > 0 && polyL[0].crdEncYX) {
      var coords = decodePolyline(polyL[0].crdEncYX, 1e5);
      if (coords.length > 0) {
        var firstStop = stopL[0];
        if (firstStop) {
          var firstLoc = locL[firstStop.locX] || {};
          var expectedLat = (firstLoc.crd && firstLoc.crd.y) ? firstLoc.crd.y / 1e6 : null;
          var decodedLat = coords[0][0];
          if (expectedLat && Math.abs(decodedLat - expectedLat) > 1) {
            coords = decodePolyline(polyL[0].crdEncYX, 1e6);
          }
        }

        state.routeCoords = coords;
        state.routeLayer = L.layerGroup();
        if (state.selectedJid && vehicle && vehicle.lat && vehicle.lon) {
          document.getElementById('journey-actions').hidden = false;
        }

        var splitIdx = 0;
        if (vehicle && vehicle.lat && vehicle.lon) {
          var busLat = vehicle.lat;
          var busLon = vehicle.lon;
          var ppLocRefL = polyL[0].ppLocRefL || [];

          var elapsedMs = state.serverTimeStamp ? (Date.now() - state.serverTimeStamp) : 0;
          var nowMin = (state.serverTimeMin || 0) + elapsedMs / 60000;

          var lastPassedPolyIdx = 0;

          if (ppLocRefL.length > 0) {
            for (var si = 0; si < stopL.length; si++) {
              var s = stopL[si];
              var depTime = s.dTimeR || s.dTimeS || s.aTimeR || s.aTimeS;
              if (!depTime) continue;
              var stopMin = parseHafasTimeToMin(depTime);
              if (stopMin === null) continue;
              if (nowMin > 1080 && stopMin < 360) stopMin += 1440;
              if (nowMin < 360 && stopMin > 1080) stopMin -= 1440;
              if (stopMin <= nowMin) {
                for (var pi = 0; pi < ppLocRefL.length; pi++) {
                  if (ppLocRefL[pi].locX === s.locX) {
                    var candidateIdx = ppLocRefL[pi].ppIdx;
                    if (typeof candidateIdx === 'number' && isFinite(candidateIdx) &&
                        candidateIdx >= 0 && candidateIdx < coords.length) {
                      lastPassedPolyIdx = candidateIdx;
                    }
                    break;
                  }
                }
              }
            }
          } else {
            for (var si2 = 0; si2 < stopL.length; si2++) {
              var s2 = stopL[si2];
              var depTime2 = s2.dTimeR || s2.dTimeS || s2.aTimeR || s2.aTimeS;
              if (!depTime2) continue;
              var stopMin2 = parseHafasTimeToMin(depTime2);
              if (stopMin2 === null) continue;
              if (nowMin > 1080 && stopMin2 < 360) stopMin2 += 1440;
              if (nowMin < 360 && stopMin2 > 1080) stopMin2 -= 1440;
              if (stopMin2 <= nowMin) {
                var stopLoc = locL[s2.locX] || {};
                var stopCrd = stopLoc.crd || {};
                if (stopCrd.y && stopCrd.x) {
                  var sLat = stopCrd.y / 1e6;
                  var sLon = stopCrd.x / 1e6;
                  var bestD = Infinity;
                  for (var pj = lastPassedPolyIdx; pj < coords.length; pj++) {
                    var d = (coords[pj][0] - sLat) * (coords[pj][0] - sLat) +
                            (coords[pj][1] - sLon) * (coords[pj][1] - sLon);
                    if (d < bestD) { bestD = d; lastPassedPolyIdx = pj; }
                  }
                }
              }
            }
          }

          var minDist = Infinity;
          for (var ci = lastPassedPolyIdx; ci < coords.length; ci++) {
            var dLat = coords[ci][0] - busLat;
            var dLon = coords[ci][1] - busLon;
            var dist = dLat * dLat + dLon * dLon;
            if (dist < minDist) { minDist = dist; splitIdx = ci; }
          }
          if (splitIdx < lastPassedPolyIdx) splitIdx = lastPassedPolyIdx;
        }

        var passedCoords = coords.slice(0, splitIdx + 1);
        var remainCoords = coords.slice(splitIdx);

        if (passedCoords.length > 1) {
          L.polyline(passedCoords, {
            weight: 3,
            opacity: 0.5,
            className: 'route-passed',
          }).addTo(state.routeLayer);
        }
        if (remainCoords.length > 1) {
          L.polyline(remainCoords, {
            weight: 4,
            opacity: 0.7,
            dashArray: '8 5',
            className: 'route-remain',
          }).addTo(state.routeLayer);
        }
        state.routeLayer.addTo(state.map);
      }
    } else if (stopL.length >= 2) {
      var fallbackCoords = [];
      stopL.forEach(function(s) {
        var loc = (s.locX >= 0 && s.locX < locL.length) ? locL[s.locX] : {};
        if (loc.crd && loc.crd.y && loc.crd.x) {
          fallbackCoords.push([loc.crd.y / 1e6, loc.crd.x / 1e6]);
        }
      });
      if (fallbackCoords.length >= 2) {
        state.routeCoords = fallbackCoords;
        state.routeLayer = L.layerGroup();
        if (state.selectedJid && vehicle && vehicle.lat && vehicle.lon) {
          document.getElementById('journey-actions').hidden = false;
        }
        L.polyline(fallbackCoords, {
          color: '#00f5d4', weight: 3, opacity: 0.7,
          dashArray: '8 5', className: 'route-remain'
        }).addTo(state.routeLayer);
        state.routeLayer.addTo(state.map);
      }
    }

    stopL.forEach(function(stop) {
      var locIdx = stop.locX != null ? stop.locX : -1;
      var loc = (locIdx >= 0 && locIdx < locL.length) ? locL[locIdx] : {};
      if (!loc.crd) return;

      var lat = loc.crd.y / 1e6;
      var lon = loc.crd.x / 1e6;
      if (lat === 0 && lon === 0) return;

      var m = L.circleMarker([lat, lon], {
        radius: 7,
        fillOpacity: 1,
        weight: 2,
        interactive: true,
        className: 'route-stop-dot',
      }).addTo(state.map);

      m.bindTooltip(loc.name || '', { className: 'route-tooltip', direction: 'top', offset: [0, -8] });

      m.on('click', function() {
        if (!loc.lid) return;
        var cachedStop = null;
        var locExtId = loc.extId || '';
        if (locExtId) {
          state.allStops.forEach(function(entry) {
            if (!cachedStop && entry.data.extId === locExtId) {
              cachedStop = entry.data;
            }
          });
        }
        ui.showStationBoard(cachedStop || loc);
      });

      state.routeStopMarkers.push(m);
    });
  },

  showStationBoard: function(loc, skipHistory) {
    if (state._cancelMapClick) state._cancelMapClick();
    state._navigating = true;
    ui._disableFollow();
    this.clearRoute();
    state._notStartedJid = null;
    state._notStartedSince = 0;
    state._notStartedLastPoll = 0;
    state.selectedJid = null;
    state.selectedJourneyData = null;
    state.selectedStop = loc;
    state._autoExpandingDep = false;
    state._autoExpandingArr = false;
    state._stationRefreshSeq++;
    if (state._selectedStopMarker) { state._selectedStopMarker.remove(); state._selectedStopMarker = null; }
    if (loc.lat && loc.lon) {
      state._selectedStopMarker = L.circleMarker([loc.lat, loc.lon], {
        radius: 9, fillOpacity: 1, weight: 2.5, interactive: false,
        className: 'stop-marker-selected',
      }).addTo(state.map);
    }
    markers.highlightSelected(null);
    if (!skipHistory && loc.extId) {
      var center = state.map.getCenter();
      var zoom = state.map.getZoom();
      urlState.push({ stop: loc.extId, lat: center.lat.toFixed(5), lon: center.lng.toFixed(5), z: zoom });
    }
    setTimeout(function() { state._navigating = false; }, 600);

    var displayName = loc.name || t('stop_fallback', {idx: ''});
    if (loc.platform) displayName += ' (' + t('platform_prefix') + ' ' + loc.platform + ')';

    this.detailLine.textContent = '';
    this.detailDir.textContent = displayName;
    this.detailDelay.textContent = '';
    this.detailDelay.className = 'detail-delay-badge';

    this.setTabMode('station');
    this.switchTab('departures');
    if (state.panelState === 'hidden' || state.panelState === 'collapsed') {
      this.setPanelState('half');
    }
    this.departureList.replaceChildren(_createStateItem('loading-spinner', '', t('loading_departures')));
    document.getElementById('arrival-list').replaceChildren();
    state._depFilter = null;
    state._arrFilter = null;
    this.hideLineFilter();

    var stopExtId = '';
    if (loc.extId) {
      stopExtId = loc.extId;
    } else if (loc.lid) {
      var match = loc.lid.match(/@L=(\d+)@/);
      if (match) stopExtId = match[1];
    }

    state._stationLoc = loc;
    state._stationExtId = stopExtId;
    state._stationDepDur = 60;
    state._stationArrDur = 60;
    state._lastDepSig = null;
    state._lastArrSig = null;
    state._stationDepCount = 0;
    state._stationArrCount = 0;
    state._depExpandCount = 0;
    state._arrExpandCount = 0;

    ui.loadDepartures(loc, stopExtId, 60, true);
    ui.loadArrivals(loc, stopExtId, 60, true);
  },

  loadDepartures: function(loc, stopExtId, dur, autoExpand) {
    if (autoExpand) state._autoExpandingDep = true;
    var capturedLid = loc.lid;
    api.getStationBoard(loc.lid, 'DEP', dur).then(function(data) {
      if (!state.selectedStop || state.selectedStop.lid !== capturedLid) {
        state._autoExpandingDep = false;
        return;
      }
      state._stationDepData = data;
      state._stationDepDur = dur;
      var filterLine = state._depFilter || null;
      var displayedJnyL = ui.renderDepartures(data, loc, stopExtId, filterLine);
      ui.discoverPlatforms(data);

      var prevCount = state._stationDepCount || 0;
      state._stationDepCount = displayedJnyL.length;
      var hasNewResults = displayedJnyL.length > prevCount;
      state._depExpandCount = (state._depExpandCount || 0) + (autoExpand ? 1 : 0);

      if (!hasNewResults && autoExpand && dur < 1440 && state._depExpandCount < CONFIG.maxExpandIterations) {
        if (!state.selectedStop || state.selectedStop.lid !== capturedLid) {
          state._autoExpandingDep = false;
          return;
        }
        var newDur = Math.min(dur + 60, 1440);
        ui.loadDepartures(loc, stopExtId, newDur, true);
      } else {
        state._autoExpandingDep = false;
        if (state._activeTab === 'departures' || !state._activeTab) ui.buildLineFilter(data, displayedJnyL);
        ui.addLoadMoreButton('departure-list', loc, stopExtId, dur, 'DEP');
        if (autoExpand && dur === 60) {
          announce(t('departures_loaded', {name: loc.name || t('stop_fallback', {idx: ''})}));
        }
      }
    }).catch(function(err) {
      state._autoExpandingDep = false;
      if (err.name === 'AbortError') return;
      ui.departureList.replaceChildren(_createStateItem('empty-state', t('departures_unavailable')));
    });
  },

  loadArrivals: function(loc, stopExtId, dur, autoExpand) {
    if (autoExpand) state._autoExpandingArr = true;
    var capturedLid = loc.lid;
    api.getStationBoard(loc.lid, 'ARR', dur).then(function(data) {
      if (!state.selectedStop || state.selectedStop.lid !== capturedLid) {
        state._autoExpandingArr = false;
        return;
      }
      state._stationArrData = data;
      state._stationArrDur = dur;
      var filterLine = state._arrFilter || null;
      var filteredArr = ui.renderArrivals(data, loc, stopExtId, filterLine);
      ui.discoverPlatforms(data);

      var prevCount = state._stationArrCount || 0;
      var arrCount = filteredArr ? filteredArr.length : 0;
      state._stationArrCount = arrCount;
      var hasNewResults = arrCount > prevCount;
      state._arrExpandCount = (state._arrExpandCount || 0) + (autoExpand ? 1 : 0);

      if (!hasNewResults && autoExpand && dur < 1440 && state._arrExpandCount < CONFIG.maxExpandIterations) {
        if (!state.selectedStop || state.selectedStop.lid !== capturedLid) {
          state._autoExpandingArr = false;
          return;
        }
        var newDur = Math.min(dur + 60, 1440);
        ui.loadArrivals(loc, stopExtId, newDur, true);
      } else {
        state._autoExpandingArr = false;
        if (state._activeTab === 'arrivals') ui.buildLineFilter(data, null);
        ui.addLoadMoreButton('arrival-list', loc, stopExtId, dur, 'ARR');
      }
    }).catch(function(err) {
      state._autoExpandingArr = false;
      if (err.name === 'AbortError') return;
      document.getElementById('arrival-list').replaceChildren(_createStateItem('empty-state', t('arrivals_unavailable')));
    });
  },

  addLoadMoreButton: function(listId, loc, stopExtId, currentDur, type) {
    var list = document.getElementById(listId);
    var existing = list.querySelector('.load-more-item');
    if (existing) existing.remove();

    // Don't show load-more if HAFAS limit hint or empty-state is present
    if (list.querySelector('.hafas-hint')) return;
    if (list.querySelector('.empty-state')) return;

    if (currentDur >= 1440) {
      var hintLi = document.createElement('li');
      hintLi.className = 'load-more-item empty-state';
      hintLi.style.fontSize = '11px';
      hintLi.textContent = t('max_timeframe_hint');
      list.appendChild(hintLi);
      return;
    }

    var li = document.createElement('li');
    li.className = 'load-more-item';
    var btn = document.createElement('button');
    btn.className = 'load-more-btn';
    btn.textContent = type === 'ARR' ? t('load_more_arr') : t('load_more_dep');
    btn.addEventListener('click', function() {
      var newDur = Math.min(currentDur + 60, 1440);
      btn.textContent = t('loading');
      btn.disabled = true;
      if (type === 'ARR') {
        ui.loadArrivals(loc, stopExtId, newDur, true);
      } else {
        ui.loadDepartures(loc, stopExtId, newDur, true);
      }
    });
    li.appendChild(btn);
    list.appendChild(li);
  },

  discoverPlatforms: function(data) {
    var common = data.common || {};
    var locL = common.locL || [];
    var added = false;

    locL.forEach(function(loc) {
      if (!loc.lid || !loc.crd) return;
      if (state.allStops.has(loc.lid)) return;
      var lat = loc.crd.y / 1e6;
      var lon = loc.crd.x / 1e6;
      if (lat === 0 && lon === 0) return;

      var gidL = loc.gidL || [];
      var hasPhysicalStop = gidL.some(function(g) { return g.indexOf('b×') === 0; });
      if (!hasPhysicalStop) return;

      var platform = '';
      for (var i = 0; i < gidL.length; i++) {
        if (gidL[i].indexOf('A×') === 0) {
          var parts = gidL[i].split(':');
          if (parts.length >= 5 && parts[4]) {
            platform = parts[4];
          }
          break;
        }
      }

      var stopData = {
        name: loc.name || '?',
        lid: loc.lid,
        lat: lat,
        lon: lon,
        extId: loc.extId || '',
        platform: platform,
        _discovered: true,
      };
      stopsLayer.addStopMarker(stopData);
      added = true;
    });
    if (added) stopsLayer.saveToCache();
  },

  renderArrivals: function(data, loc, filterExtId, filterLine) {
    var jnyL = data.jnyL || [];
    var common = data.common || {};
    var prodL = common.prodL || [];
    var locL = common.locL || [];
    var arrList = document.getElementById('arrival-list');

    if (filterExtId) {
      var hasPlatform = loc && loc.platform;
      var extIdKnown = locL.some(function(l) { return l.extId === filterExtId; });
      var shouldFilter = false;
      if (!hasPlatform && extIdKnown) {
        var filterLoc = null;
        var otherLocs = [];
        locL.forEach(function(l) {
          if (l.extId === filterExtId) filterLoc = l;
          else if (l.name === (loc && loc.name) && l.crd) otherLocs.push(l);
        });
        if (filterLoc && filterLoc.crd && otherLocs.length > 0) {
          for (var si = 0; si < otherLocs.length; si++) {
            var dlat = Math.abs((otherLocs[si].crd.y || 0) - (filterLoc.crd.y || 0)) / 1e6 * 111000;
            var dlon = Math.abs((otherLocs[si].crd.x || 0) - (filterLoc.crd.x || 0)) / 1e6 * 111000 * 0.65;
            if (Math.sqrt(dlat * dlat + dlon * dlon) > 1) {
              shouldFilter = true;
              break;
            }
          }
        }
      } else if (!hasPlatform && !extIdKnown && locL.length > 0) {
        var hasOtherWithSameName = locL.some(function(l) { return l.name === (loc && loc.name); });
        if (hasOtherWithSameName) shouldFilter = true;
      }
      if (hasPlatform || shouldFilter) {
        jnyL = jnyL.filter(function(jny) {
          var stb = jny.stbStop || {};
          var locIdx = stb.locX != null ? stb.locX : -1;
          if (locIdx < 0 || locIdx >= locL.length) return false;
          return locL[locIdx].extId === filterExtId;
        });
      }
    }

    var filteredByExtId = jnyL;

    if (filterLine) {
      jnyL = jnyL.filter(function(jny) {
        var prod = prodL[jny.prodX] || {};
        return prod.nameS === filterLine;
      });
    }

    var seenKeys = {};
    jnyL = jnyL.filter(function(jny) {
      var stb = jny.stbStop || {};
      var time = stb.aTimeS || stb.dTimeS || '';
      var key = (jny.prodX || 0) + '|' + time + '|' + (jny.dirTxt || '');
      if (seenKeys[key]) return false;
      seenKeys[key] = true;
      return true;
    });

    arrList.replaceChildren();

    if (jnyL.length === 0) {
      var arrDurMin = state._stationArrDur || 60;
      var arrEmptyText = arrDurMin >= 1440 ? t('arr_empty_24h') : arrDurMin >= 120 ? t('arr_empty_hours', {n: Math.round(arrDurMin / 60)}) : t('arr_empty_minutes', {n: arrDurMin});
      arrList.replaceChildren(_createStateItem('empty-state', arrEmptyText));
      return filteredByExtId;
    }

    jnyL.forEach(function(jny) {
      var prodIdx = jny.prodX != null ? jny.prodX : -1;
      var prod = (prodIdx >= 0 && prodIdx < prodL.length) ? prodL[prodIdx] : {};
      var stbStop = jny.stbStop || {};
      var timeS = stbStop.aTimeS || stbStop.dTimeS || '';
      var timeR = stbStop.aTimeR || stbStop.dTimeR || '';
      var delay = calcDelay(timeS, timeR);
      var jid = jny.jid || '';

      var li = document.createElement('li');
      li.className = 'departure-item';

      var vehicleOnMap = jid ? state.vehicles.get(jid) : null;
      if (jid) {
        li.style.cursor = 'pointer';
        li.addEventListener('click', function() {
          state._userInteractionSeq++;
          if (vehicleOnMap) {
            state._navigating = true;
            state.map.setView([vehicleOnMap.data.lat, vehicleOnMap.data.lon], 16);
            ui.selectJourney(vehicleOnMap.data);
          } else {
            ui.focusJourneyById(jid, prod);
          }
        });
      }

      var lineEl = document.createElement('span');
      lineEl.className = 'departure-line';
      lineEl.textContent = prod.nameS || prod.name || '?';

      var destEl = document.createElement('span');
      destEl.className = 'departure-dest';
      destEl.textContent = t('arr_from_prefix') + ' ' + (jny.dirTxt || '?');

      var timeEl = document.createElement('span');
      timeEl.className = 'departure-time';
      if (timeR && timeS && timeR !== timeS) {
        var plannedSpan = document.createElement('span');
        plannedSpan.className = 'stop-time-planned';
        plannedSpan.textContent = formatTime(timeS);
        var realSpan = document.createElement('span');
        realSpan.className = 'stop-time-real';
        realSpan.textContent = ' ' + formatTime(timeR);
        timeEl.appendChild(plannedSpan);
        timeEl.appendChild(realSpan);
      } else {
        timeEl.textContent = formatTime(timeR || timeS);
      }
      var dayOffset = getDayOffset(timeR || timeS);
      if (!dayOffset && jny.date && data.sD && jny.date > data.sD) {
        dayOffset = 1;
      }
      if (dayOffset > 0) {
        var dayBadge = document.createElement('span');
        dayBadge.className = 'departure-day-badge';
        dayBadge.textContent = t('day_offset_badge', {n: dayOffset});
        dayBadge.setAttribute('aria-label', t('day_offset_aria'));
        timeEl.appendChild(dayBadge);
      }

      var delayEl = document.createElement('span');
      delayEl.className = 'departure-delay';
      var delayCls = getDelayClass(delay);
      if (delayCls === 'ontime') delayEl.style.color = 'var(--color-ontime)';
      else if (delayCls === 'delayed') delayEl.style.color = 'var(--color-delayed)';
      else if (delayCls === 'major-delay') delayEl.style.color = 'var(--color-major-delay)';
      else delayEl.style.color = 'var(--text-secondary)';
      delayEl.textContent = delay !== null ? getDelayText(delay) : '';

      li.appendChild(lineEl);
      li.appendChild(destEl);
      li.appendChild(timeEl);
      li.appendChild(delayEl);
      arrList.appendChild(li);
    });
    if ((data.jnyL || []).length >= CONFIG.hafasStationboardLimit) {
      var hintLi = document.createElement('li');
      hintLi.className = 'empty-state hafas-hint';
      hintLi.style.fontSize = '11px';
      hintLi.textContent = t('hafas_limit_hint');
      arrList.appendChild(hintLi);
    }
    return filteredByExtId;
  },

  renderDepartures: function(data, loc, filterExtId, filterLine) {
    var jnyL = data.jnyL || [];
    var common = data.common || {};
    var prodL = common.prodL || [];
    var locL = common.locL || [];

    if (filterExtId) {
      var hasPlatform = loc && loc.platform;
      var extIdKnown = locL.some(function(l) { return l.extId === filterExtId; });
      var shouldFilter = false;
      if (!hasPlatform && extIdKnown) {
        var filterLoc = null;
        var otherLocs = [];
        locL.forEach(function(l) {
          if (l.extId === filterExtId) filterLoc = l;
          else if (l.name === (loc && loc.name) && l.crd) otherLocs.push(l);
        });
        if (filterLoc && filterLoc.crd && otherLocs.length > 0) {
          for (var si = 0; si < otherLocs.length; si++) {
            var dlat = Math.abs((otherLocs[si].crd.y || 0) - (filterLoc.crd.y || 0)) / 1e6 * 111000;
            var dlon = Math.abs((otherLocs[si].crd.x || 0) - (filterLoc.crd.x || 0)) / 1e6 * 111000 * 0.65;
            if (Math.sqrt(dlat * dlat + dlon * dlon) > 1) {
              shouldFilter = true;
              break;
            }
          }
        }
      } else if (!hasPlatform && !extIdKnown && locL.length > 0) {
        var hasOtherWithSameName = locL.some(function(l) { return l.name === (loc && loc.name); });
        if (hasOtherWithSameName) shouldFilter = true;
      }
      if (hasPlatform || shouldFilter) {
        jnyL = jnyL.filter(function(jny) {
          var stb = jny.stbStop || {};
          var locIdx = stb.locX != null ? stb.locX : -1;
          if (locIdx < 0 || locIdx >= locL.length) return false;
          return locL[locIdx].extId === filterExtId;
        });
      }
    }

    var filteredByExtId = jnyL;

    if (filterLine) {
      jnyL = jnyL.filter(function(jny) {
        var prod = prodL[jny.prodX] || {};
        return prod.nameS === filterLine;
      });
    }

    this.departureList.replaceChildren();

    var seenKeys = {};
    jnyL = jnyL.filter(function(jny) {
      var stb = jny.stbStop || {};
      var time = stb.dTimeS || stb.aTimeS || '';
      var key = (jny.prodX || 0) + '|' + time + '|' + (jny.dirTxt || '');
      if (seenKeys[key]) return false;
      seenKeys[key] = true;
      return true;
    });

    if (jnyL.length === 0) {
      var depDurMin = state._stationDepDur || 60;
      var depEmptyText = depDurMin >= 1440 ? t('dep_empty_24h') : depDurMin >= 120 ? t('dep_empty_hours', {n: Math.round(depDurMin / 60)}) : t('dep_empty_minutes', {n: depDurMin});
      this.departureList.replaceChildren(_createStateItem('empty-state', depEmptyText));
      return filteredByExtId;
    }

    jnyL.forEach(function(jny) {
      var prodIdx = jny.prodX != null ? jny.prodX : -1;
      var prod = (prodIdx >= 0 && prodIdx < prodL.length) ? prodL[prodIdx] : {};
      var stbStop = jny.stbStop || {};
      var timeS = stbStop.dTimeS || stbStop.aTimeS || '';
      var timeR = stbStop.dTimeR || stbStop.aTimeR || '';
      var delay = calcDelay(timeS, timeR);
      var jid = jny.jid || '';

      var li = document.createElement('li');
      li.className = 'departure-item';

      var vehicleOnMap = jid ? state.vehicles.get(jid) : null;
      if (jid) {
        li.style.cursor = 'pointer';
        li.addEventListener('click', function() {
          state._userInteractionSeq++;
          if (vehicleOnMap) {
            state._navigating = true;
            state.map.setView([vehicleOnMap.data.lat, vehicleOnMap.data.lon], 16);
            ui.selectJourney(vehicleOnMap.data);
          } else {
            ui.focusJourneyById(jid, prod);
          }
        });
      }

      var lineEl = document.createElement('span');
      lineEl.className = 'departure-line';
      lineEl.textContent = prod.nameS || prod.name || '?';

      var destEl = document.createElement('span');
      destEl.className = 'departure-dest';
      destEl.textContent = jny.dirTxt || '?';

      var timeEl = document.createElement('span');
      timeEl.className = 'departure-time';
      if (timeR && timeS && timeR !== timeS) {
        var plannedSpan = document.createElement('span');
        plannedSpan.className = 'stop-time-planned';
        plannedSpan.textContent = formatTime(timeS);
        var realSpan = document.createElement('span');
        realSpan.className = 'stop-time-real';
        realSpan.textContent = ' ' + formatTime(timeR);
        timeEl.appendChild(plannedSpan);
        timeEl.appendChild(realSpan);
      } else {
        timeEl.textContent = formatTime(timeR || timeS);
      }
      var dayOffset = getDayOffset(timeR || timeS);
      if (!dayOffset && jny.date && data.sD && jny.date > data.sD) {
        dayOffset = 1;
      }
      if (dayOffset > 0) {
        var dayBadge = document.createElement('span');
        dayBadge.className = 'departure-day-badge';
        dayBadge.textContent = t('day_offset_badge', {n: dayOffset});
        dayBadge.setAttribute('aria-label', t('day_offset_aria'));
        timeEl.appendChild(dayBadge);
      }

      var delayEl = document.createElement('span');
      delayEl.className = 'departure-delay';
      var delayCls = getDelayClass(delay);
      if (delayCls === 'ontime') delayEl.style.color = 'var(--color-ontime)';
      else if (delayCls === 'delayed') delayEl.style.color = 'var(--color-delayed)';
      else if (delayCls === 'major-delay') delayEl.style.color = 'var(--color-major-delay)';
      else delayEl.style.color = 'var(--text-secondary)';
      delayEl.textContent = delay !== null ? getDelayText(delay) : '';

      li.appendChild(lineEl);
      li.appendChild(destEl);
      li.appendChild(timeEl);
      li.appendChild(delayEl);
      ui.departureList.appendChild(li);
    });
    if ((data.jnyL || []).length >= CONFIG.hafasStationboardLimit) {
      var hintLi = document.createElement('li');
      hintLi.className = 'empty-state hafas-hint';
      hintLi.style.fontSize = '11px';
      hintLi.textContent = t('hafas_limit_hint');
      ui.departureList.appendChild(hintLi);
    }
    return filteredByExtId;
  },

  switchTab: function(tab) {
    var tabStops = document.getElementById('tab-stops');
    var tabDep = document.getElementById('tab-departures');
    var tabArr = document.getElementById('tab-arrivals');
    var panelStops = document.getElementById('tabpanel-stops');
    var panelDep = document.getElementById('tabpanel-departures');
    var panelArr = document.getElementById('tabpanel-arrivals');

    [tabStops, tabDep, tabArr].forEach(function(tab) {
      tab.classList.remove('detail-tab--active');
      tab.setAttribute('aria-selected', 'false');
    });
    panelStops.hidden = true;
    panelDep.hidden = true;
    panelArr.hidden = true;

    if (tab === 'stops') {
      tabStops.classList.add('detail-tab--active');
      tabStops.setAttribute('aria-selected', 'true');
      panelStops.hidden = false;
    } else if (tab === 'departures') {
      tabDep.classList.add('detail-tab--active');
      tabDep.setAttribute('aria-selected', 'true');
      panelDep.hidden = false;
    } else if (tab === 'arrivals') {
      tabArr.classList.add('detail-tab--active');
      tabArr.setAttribute('aria-selected', 'true');
      panelArr.hidden = false;
    }

    state._activeTab = tab;
    if (tab === 'departures' && state._stationDepData) {
      ui.buildLineFilter(state._stationDepData, null);
    } else if (tab === 'arrivals' && state._stationArrData) {
      ui.buildLineFilter(state._stationArrData, null);
    } else if (tab === 'stops') {
      ui.hideLineFilter();
    }
  },

  setTabMode: function(mode) {
    var tabStops = document.getElementById('tab-stops');
    var tabDep = document.getElementById('tab-departures');
    var tabArr = document.getElementById('tab-arrivals');

    if (mode === 'journey') {
      tabStops.style.display = '';
      tabDep.style.display = 'none';
      tabArr.style.display = 'none';
      this.hideLineFilter();
    } else if (mode === 'station') {
      tabStops.style.display = 'none';
      tabDep.style.display = '';
      tabArr.style.display = '';
      document.getElementById('journey-actions').hidden = true;
      ui._disableFollow();
    }
    state._tabMode = mode;
  },

  showJourneyEnded: function() {
    this.stopList.replaceChildren(_createStateItem('empty-state', t('journey_ended')));
  },

  _showJourneyCancelled: function() {
    state._notStartedJid = null;
    state._notStartedSince = 0;
    state._notStartedLastPoll = 0;
    state.selectedJourneyData = null;
    this.stopList.replaceChildren(_createStateItem('empty-state', t('journey_cancelled')));
  },

  _transitionToRunning: function(data) {
    var journey = data.journey || {};
    var common = data.common || {};
    var prodL = common.prodL || [];
    var journeyProd = prodL[journey.prodX] || {};
    var pos = journey.pos;
    var lat = pos.y / 1e6;
    var lon = pos.x / 1e6;

    state._notStartedJid = null;
    state._notStartedSince = 0;
    state._notStartedLastPoll = 0;

    var vehicle = {
      jid: state.selectedJid,
      line: journeyProd.nameS || journeyProd.name || '?',
      lineFull: journeyProd.name || '?',
      direction: journey.dirTxt || '?',
      lat: lat, lon: lon,
      delay: null, dirGeo: null, progress: null, stops: []
    };
    state.selectedJourneyData = data;
    state._currentStopL = journey.stopL || [];

    ui.detailDir.textContent = vehicle.direction;
    ui.detailLine.textContent = vehicle.lineFull || vehicle.line;

    ui.renderJourneyStops(data, vehicle);
    ui.drawRoute(data, vehicle);

    state._navigating = true;
    state.map.panTo([lat, lon], {duration: 1.2});
    setTimeout(function() { state._navigating = false; }, 2500);

    state._needsImmediateRefresh = true;
    announce(t('journey_started_announce', {line: vehicle.line}));
  },

  refreshStationBoard: function(loc) {
    if (state._autoExpandingDep || state._autoExpandingArr) return;
    var refreshSeq = ++state._stationRefreshSeq;
    var capturedLid = loc.lid;
    var stopExtId = '';
    if (loc.extId) {
      stopExtId = loc.extId;
    } else if (loc.lid) {
      var match = loc.lid.match(/@L=(\d+)@/);
      if (match) stopExtId = match[1];
    }
    var depFilterLine = state._depFilter || null;
    var arrFilterLine = state._arrFilter || null;
    var depDur = state._stationDepDur || 60;
    var arrDur = state._stationArrDur || 60;

    var boardSig = function(jnyL) {
      return (jnyL || []).map(function(j) {
        var stb = j.stbStop || {};
        return (j.jid || '') + '|' + (j.prodX != null ? j.prodX : '') + '|' + (j.dirTxt || '') + '|' + (j.date || '') + '|' + (stb.locX != null ? stb.locX : '') + '|' + (stb.dTimeS || '') + '|' + (stb.dTimeR || '') + '|' + (stb.aTimeS || '') + '|' + (stb.aTimeR || '');
      }).join(';');
    };

    var content = document.getElementById('detail-content');
    var fixedHeight = content.offsetHeight;
    content.style.minHeight = fixedHeight + 'px';

    api.getStationBoard(loc.lid, 'DEP', depDur).then(function(data) {
      if (state._stationRefreshSeq !== refreshSeq) return;
      if (!state.selectedStop || state.selectedStop.lid !== capturedLid) return;
      var sig = boardSig(data.jnyL);
      if (sig !== state._lastDepSig) {
        state._lastDepSig = sig;
        state._stationDepData = data;
        ui.renderDepartures(data, loc, stopExtId, depFilterLine);
        ui.addLoadMoreButton('departure-list', loc, stopExtId, depDur, 'DEP');
      }
      content.style.minHeight = '';
    }).catch(function() { content.style.minHeight = ''; });

    api.getStationBoard(loc.lid, 'ARR', arrDur).then(function(data) {
      if (state._stationRefreshSeq !== refreshSeq) return;
      if (!state.selectedStop || state.selectedStop.lid !== capturedLid) return;
      var sig = boardSig(data.jnyL);
      if (sig !== state._lastArrSig) {
        state._lastArrSig = sig;
        state._stationArrData = data;
        ui.renderArrivals(data, loc, stopExtId, arrFilterLine);
        ui.addLoadMoreButton('arrival-list', loc, stopExtId, arrDur, 'ARR');
      }
    }).catch(function() {});
  },

  focusJourneyById: function(jid, prod, skipHistory) {
    if (state._cancelMapClick) state._cancelMapClick();
    state._navigating = true;
    ui._disableFollow();
    state.selectedJid = jid;
    state.selectedStop = null;
    if (state._selectedStopMarker) { state._selectedStopMarker.remove(); state._selectedStopMarker = null; }
    if (!skipHistory) {
      var center = state.map.getCenter();
      var zoom = state.map.getZoom();
      urlState.push({ jid: jid, lat: center.lat.toFixed(5), lon: center.lng.toFixed(5), z: zoom });
    }
    setTimeout(function() { state._navigating = false; }, 600);
    this.setTabMode('journey');
    this.switchTab('stops');
    if (state.panelState === 'hidden' || state.panelState === 'collapsed') {
      this.setPanelState('half');
    }
    this.detailLine.textContent = prod && prod.nameS ? prod.nameS : t('loading');
    this.detailDir.textContent = t('loading');
    this.detailDelay.textContent = '';
    this.detailDelay.className = 'detail-delay-badge';
    this.stopList.replaceChildren(_createStateItem('loading-spinner', '', t('loading_route')));

    api.getJourney(jid, {userInitiated: true}).then(function(data) {
      var journey = data.journey || {};
      var common = data.common || {};
      var prodL = common.prodL || [];
      var journeyProd = prodL[journey.prodX] || prod || {};

      var pos = journey.pos || {};
      var lat = pos.y ? pos.y / 1e6 : null;
      var lon = pos.x ? pos.x / 1e6 : null;

      if (!lat || !lon) {
        var stopL = journey.stopL || [];
        var elapsedMs = state.serverTimeStamp ? (Date.now() - state.serverTimeStamp) : 0;
        var curMin = (state.serverTimeMin || 0) + elapsedMs / 60000;

        var lastStop = stopL.length > 0 ? stopL[stopL.length - 1] : null;
        var lastArrTime = lastStop ? (lastStop.aTimeR || lastStop.aTimeS || lastStop.dTimeR || lastStop.dTimeS || '') : '';
        var lastMin = 0;
        if (lastArrTime) {
          lastMin = parseHafasTimeToMin(lastArrTime);
          if (lastMin === null) lastMin = 0;
          if (curMin > 1080 && lastMin < 360) lastMin += 1440;
          if (curMin < 360 && lastMin > 1080) lastMin -= 1440;
        }

        var journeyAlreadyEnded = lastArrTime && (lastMin + 5) <= curMin;

        if (journeyAlreadyEnded) {
          ui.detailLine.textContent = journeyProd.nameS || journeyProd.name || '?';
          ui.detailDir.textContent = journey.dirTxt || '?';
          ui.stopList.replaceChildren(_createStateItem('empty-state', t('journey_ended')));
          return;
        }

        ui.detailLine.textContent = journeyProd.nameS || journeyProd.name || '?';
        ui.detailDir.textContent = (journey.dirTxt || '?') + ' ' + t('not_started_suffix');
        ui.detailDelay.textContent = '';
        ui.detailDelay.className = 'detail-delay-badge';
        state.selectedJourneyData = data;

        if (state._notStartedJid !== jid) {
          state._notStartedJid = jid;
          state._notStartedSince = Date.now();
          state._notStartedLastPoll = 0;
        }

        var stopL = journey.stopL || [];
        if (stopL.length > 0) {
          var pendingVehicle = {
            jid: jid, line: journeyProd.nameS || journeyProd.name || '?',
            direction: journey.dirTxt || '?', lat: null, lon: null,
            delay: null, dirGeo: null, progress: null, stops: []
          };
          ui.renderJourneyStops(data, pendingVehicle);
          ui.drawRoute(data, pendingVehicle);
          document.getElementById('journey-actions').hidden = false;
          if (state._notStartedLastPoll === 0 && state.routeCoords && state.routeCoords.length >= 2) {
            state._navigating = true;
            var panelRect = document.getElementById('detail-panel').getBoundingClientRect();
            var isDesktop = window.innerWidth >= 1024;
            var fitOpts = { maxZoom: 16 };
            if (isDesktop) {
              fitOpts.paddingBottomRight = [panelRect.width + 30, 30];
              fitOpts.paddingTopLeft = [30, 30];
            } else {
              var initBottomPad = Math.max(30, Math.min(window.innerHeight * 0.55, window.innerHeight - panelRect.top + 30));
              fitOpts.paddingBottomRight = [30, initBottomPad];
              fitOpts.paddingTopLeft = [30, 80];
            }
            state.map.fitBounds(L.latLngBounds(state.routeCoords), fitOpts);
            setTimeout(function() { state._navigating = false; }, 1500);
          }
        } else {
          ui.stopList.replaceChildren(_createStateItem('empty-state', t('journey_not_started')));
        }
        return;
      }

      state._notStartedJid = null;
      state._notStartedSince = 0;
      state._notStartedLastPoll = 0;
      state.selectedJourneyData = data;

      var vehicle = {
        jid: jid,
        line: journeyProd.nameS || journeyProd.name || '?',
        lineFull: journeyProd.name || '?',
        direction: journey.dirTxt || '?',
        lat: lat,
        lon: lon,
        delay: null,
        dirGeo: null,
        progress: null,
        stops: [],
      };

      var stopL = journey.stopL || [];
      var common = data.common || {};
      var locL = common.locL || [];
      for (var i = 0; i < stopL.length; i++) {
        var s = stopL[i];
        var d = null;
        if (s.dTimeS && s.dTimeR) d = calcDelay(s.dTimeS, s.dTimeR);
        else if (s.aTimeS && s.aTimeR) d = calcDelay(s.aTimeS, s.aTimeR);
        if (d !== null) vehicle.delay = d;
      }

      ui.detailLine.textContent = vehicle.lineFull;
      ui.detailDir.textContent = vehicle.direction;
      var cls = getDelayClass(vehicle.delay);
      ui.detailDelay.textContent = getDelayText(vehicle.delay);
      ui.detailDelay.className = 'detail-delay-badge detail-delay-badge--' + cls;

      state.map.setView([lat, lon], 15);

      ui.renderJourneyStops(data, vehicle);
      ui.drawRoute(data, vehicle);
      announce(t('route_loaded', {line: vehicle.line}));
    }).catch(function(err) {
      if (err.name === 'AbortError') return;
      ui.stopList.replaceChildren(_createStateItem('empty-state', t('journey_not_found')));
    });
  },

  share: function() {
    var isJourney = state._tabMode === 'journey' && state.selectedJid;
    var isStation = state._tabMode === 'station' && state.selectedStop;
    if (!isJourney && !isStation) return;

    var hashOpts = {};
    if (isJourney) {
      hashOpts.jid = state.selectedJid;
    } else {
      var extId = state.selectedStop.extId || '';
      if (!extId && state.selectedStop.lid) {
        var m = state.selectedStop.lid.match(/@L=(\d+)@/);
        if (m) extId = m[1];
      }
      if (!extId) return;
      hashOpts.stop = extId;
      if (state._activeTab === 'arrivals') hashOpts.tab = 'arr';
      else hashOpts.tab = 'dep';
    }
    var url = location.origin + location.pathname + urlState.buildShareHash(hashOpts);

    var title;
    if (isJourney) {
      title = t('share_title_journey', {line: (ui.detailLine.textContent || '').trim(), dir: (ui.detailDir.textContent || '').trim()});
    } else {
      title = t('share_title_stop', {name: state.selectedStop.name || ''});
    }

    if (navigator.share) {
      try {
        navigator.share({title: title, text: title, url: url}).catch(function(err) {
          if (err && err.name === 'AbortError') return;
          ui._copyAndToast(url);
        });
      } catch(e) {
        ui._copyAndToast(url);
      }
    } else {
      ui._copyAndToast(url);
    }
  },

  _copyAndToast: function(url) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url)
        .then(function() { ui._showToast(t('share_copied')); })
        .catch(function() { ui._showToast(t('share_failed')); });
    } else {
      try {
        var ta = document.createElement('textarea');
        ta.value = url;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        ui._showToast(t('share_copied'));
      } catch (e) {
        ui._showToast(t('share_failed'));
      }
    }
  },

  _showToast: function(msg) {
    var el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      el.id = 'toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('toast--visible');
    clearTimeout(ui._toastTimer);
    ui._toastTimer = setTimeout(function() {
      el.classList.remove('toast--visible');
    }, 2000);
    announce(msg);
  },

};

// === SEARCH ===
export var search = {
  input: null,
  results: null,
  debounceTimer: null,

  init: function() {
    this.input = document.getElementById('search-input');
    this.results = document.getElementById('search-results');

    var self = this;
    this.input.addEventListener('input', function() {
      clearTimeout(self.debounceTimer);
      self.debounceTimer = setTimeout(function() {
        self.doSearch(self.input.value.trim());
      }, 300);
    });

    this.input.addEventListener('focus', function() {
      if (self.input.value.trim().length >= 2) {
        self.results.hidden = false;
      }
    });

    document.addEventListener('click', function(e) {
      if (!self.input.contains(e.target) && !self.results.contains(e.target)) {
        self.results.hidden = true;
      }
    });

    this.input.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        self.results.hidden = true;
        self.input.blur();
      }
    });
  },

  doSearch: function(query) {
    if (query.length < 2) {
      this.results.hidden = true;
      return;
    }

    var self = this;
    var queryLower = query.toLowerCase();
    var queryWords = queryLower.split(/\s+/).filter(function(w) { return w.length > 0; });
    var searchId = ++this._searchSeq;

    var matchesQuery = function(text) {
      var textLower = text.toLowerCase();
      return queryWords.every(function(w) { return textLower.indexOf(w) >= 0; });
    };

    var matchScore = function(text) {
      var textLower = text.toLowerCase();
      var count = 0;
      queryWords.forEach(function(w) { if (textLower.indexOf(w) >= 0) count++; });
      return count;
    };

    var localLines = [];
    state.vehicles.forEach(function(entry) {
      var v = entry.data;
      if (v.line.toLowerCase() === queryLower || matchesQuery(v.lineFull) || matchesQuery(v.line)) {
        localLines.push({ type: 'line', vehicle: v });
      }
    });

    var localStops = [];
    state.allStops.forEach(function(entry) {
      var s = entry.data;
      if (matchesQuery(s.name)) {
        localStops.push({ type: 'stop', stop: s, score: matchScore(s.name) });
      }
    });
    localStops.sort(function(a, b) {
      if (b.score !== a.score) return b.score - a.score;
      var center = state.map.getCenter();
      var da = Math.abs(a.stop.lat - center.lat) + Math.abs(a.stop.lon - center.lng);
      var db = Math.abs(b.stop.lat - center.lat) + Math.abs(b.stop.lon - center.lng);
      return da - db;
    });

    var nameCount = {};
    localStops.forEach(function(r) {
      var n = r.stop.name;
      nameCount[n] = (nameCount[n] || 0) + 1;
    });
    var nameSeen = {};
    localStops = localStops.filter(function(r) {
      if (nameCount[r.stop.name] > 1 && !r.stop.platform) {
        var key = r.stop.name + '|' + r.stop.lat + '|' + r.stop.lon;
        if (nameSeen[key]) return false;
        nameSeen[key] = true;
      }
      return true;
    });
    localStops.forEach(function(r) {
      if (nameCount[r.stop.name] > 1) {
        r.stop._disambig = true;
      }
    });

    this._asyncLines = [];
    this._asyncStops = [];
    this._localLines = localLines;
    this._localStops = localStops.slice(0, 10);
    this._queryWords = queryWords;

    this._renderCombined();

    var center = state.map.getCenter();
    var isLineQuery = /^[a-z0-9]{1,6}$/i.test(query.trim());

    if (isLineQuery && localLines.length === 0) {
      window.fetch(CONFIG.apiBase + '/line_search?q=' + encodeURIComponent(query.trim()))
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(data) {
          if (!data || self._searchSeq !== searchId) return;
          self._asyncLines = (data.vehicles || []).map(function(v) {
            return { type: 'line', vehicle: v, remote: true };
          });
          self._renderCombined();
        })
        .catch(function() {});
    }

    window.fetch(CONFIG.apiBase + '/search?q=' + encodeURIComponent(query) +
      '&lat=' + center.lat.toFixed(5) + '&lon=' + center.lng.toFixed(5))
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data || self._searchSeq !== searchId) return;
        var seen = new Set();
        var seenCoords = new Set();
        self._localStops.forEach(function(r) {
          if (r.stop) {
            seen.add(r.stop.extId);
            seenCoords.add(r.stop.name + '|' + r.stop.lat + '|' + r.stop.lon);
          }
        });
        self._asyncStops = (data.results || []).filter(function(s) {
          if (seen.has(s.extId)) return false;
          var coordKey = s.name + '|' + s.lat + '|' + s.lon;
          if (seenCoords.has(coordKey)) return false;
          return true;
        }).map(function(s) {
          return { type: 'stop', stop: s };
        });
        self._asyncStops.forEach(function(r) {
          var sameName = self._localStops.some(function(l) { return l.stop && l.stop.name === r.stop.name; });
          if (sameName) r.stop._disambig = true;
        });
        self._renderCombined();
      })
      .catch(function() {});
  },

  _searchSeq: 0,
  _asyncLines: [],
  _asyncStops: [],
  _localLines: [],
  _localStops: [],

  _renderCombined: function() {
    var lines = this._asyncLines.length > 0 ? this._asyncLines : this._localLines;
    var qw = this._queryWords || [];
    var asyncWithScore = this._asyncStops.map(function(r) {
      var textLower = (r.stop.name || '').toLowerCase();
      var score = 0;
      qw.forEach(function(w) { if (textLower.indexOf(w) >= 0) score++; });
      return { type: r.type, stop: r.stop, score: score };
    });
    var stops = this._localStops.concat(asyncWithScore);
    stops.sort(function(a, b) {
      var sa = a.score || 0;
      var sb = b.score || 0;
      return sb - sa;
    });
    var combined = lines.concat(stops.slice(0, 15));
    this.renderResults(combined);
  },

  renderResults: function(results) {
    this.results.replaceChildren();
    if (results.length === 0) {
      var emptyItem = document.createElement('div');
      emptyItem.className = 'search-result-item';
      var emptyInfo = document.createElement('span');
      emptyInfo.className = 'search-result-info';
      var emptyName = document.createElement('span');
      emptyName.className = 'search-result-name';
      emptyName.textContent = t('no_results');
      emptyInfo.appendChild(emptyName);
      emptyItem.appendChild(emptyInfo);
      this.results.appendChild(emptyItem);
      this.results.hidden = false;
      return;
    }

    var self = this;
    results.forEach(function(r) {
      var item = document.createElement('div');
      item.className = 'search-result-item';

      if (r.type === 'line') {
        var v = r.vehicle;
        var icon = document.createElement('span');
        icon.className = 'search-result-icon search-result-icon--line';
        icon.textContent = v.line;

        var info = document.createElement('span');
        info.className = 'search-result-info';
        var name = document.createElement('div');
        name.className = 'search-result-name';
        name.textContent = v.direction;
        var detail = document.createElement('div');
        detail.className = 'search-result-detail';
        var nextStop = v.stops && v.stops[0] ? v.stops[0].name : '';
        detail.textContent = nextStop ? '→ ' + nextStop : '';
        info.appendChild(name);
        info.appendChild(detail);

        item.appendChild(icon);
        item.appendChild(info);

        if (v.delay !== null) {
          var delay = document.createElement('span');
          delay.className = 'search-result-delay';
          var cls = getDelayClass(v.delay);
          if (cls === 'ontime') delay.style.color = 'var(--color-ontime)';
          else if (cls === 'delayed') delay.style.color = 'var(--color-delayed)';
          else if (cls === 'major-delay') delay.style.color = 'var(--color-major-delay)';
          delay.textContent = getDelayText(v.delay);
          item.appendChild(delay);
        }

        item.addEventListener('click', function() {
          self.results.hidden = true;
          self.input.value = '';
          state._navigating = true;
          var localEntry = state.vehicles.get(v.jid);
          if (localEntry) {
            state.map.setView([v.lat, v.lon], 16);
            ui.selectJourney(localEntry.data);
          } else {
            state.map.setView([v.lat, v.lon], 15);
            ui.focusJourneyById(v.jid, { nameS: v.line, name: v.lineFull });
          }
        });

      } else if (r.type === 'stop') {
        var s = r.stop;
        var icon2 = document.createElement('span');
        icon2.className = 'search-result-icon search-result-icon--stop';
        icon2.textContent = 'H';

        var info2 = document.createElement('span');
        info2.className = 'search-result-info';
        var name2 = document.createElement('div');
        name2.className = 'search-result-name';
        name2.textContent = s.name + (s.platform ? ' (' + t('platform_prefix') + ' ' + s.platform + ')' : '');
        info2.appendChild(name2);

        if (s._disambig) {
          var detail2 = document.createElement('div');
          detail2.className = 'search-result-detail';
          detail2.textContent = s.lat.toFixed(5) + ', ' + s.lon.toFixed(5) + ' · ID ' + s.extId;
          info2.appendChild(detail2);
        }

        item.appendChild(icon2);
        item.appendChild(info2);

        item.addEventListener('click', function() {
          self.results.hidden = true;
          self.input.value = '';
          state._navigating = true;
          state.map.setView([s.lat, s.lon], 17);
          ui.showStationBoard(s);
        });
      }

      self.results.appendChild(item);
    });

    this.results.hidden = false;
  },
};
