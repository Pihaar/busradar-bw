import { state, t } from './state.js';

// === STATUS & ACCESSIBILITY ===

var _announceTimer = null;

export function announce(msg) {
  var el = document.getElementById('sr-announcer');
  if (!el) return;
  el.textContent = msg;
  clearTimeout(_announceTimer);
  _announceTimer = setTimeout(function() { el.textContent = ''; }, 3000);
}

export function getServerTimeStr() {
  var elapsedMs = state.serverTimeStamp ? (Date.now() - state.serverTimeStamp) : 0;
  var totalMin = (state.serverTimeMin || 0) + elapsedMs / 60000;
  var h = Math.floor(totalMin / 60) % 24;
  var m = Math.floor(totalMin % 60);
  var s = Math.floor((totalMin * 60) % 60);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

export function updateStatus(count, dataAge) {
  if (state._errorUntil && Date.now() < state._errorUntil) { state._lastBusCount = count; return; }
  var dot = document.querySelector('.status-dot');
  var text = document.getElementById('status-text');
  dot.className = 'status-dot status-dot--live';
  if (dataAge != null && dataAge < 2) {
    dot.classList.add('status-dot--flash');
    setTimeout(function() { dot.classList.remove('status-dot--flash'); }, 600);
  }
  state._lastBusCount = count;
  var timeStr = getServerTimeStr();
  text.textContent = (count === 1 ? t('bus_count_one', {time: timeStr}) : t('buses_count', {count: count, time: timeStr}));
  state.lastUpdate = Date.now();
}

export function showError(msg) {
  var dot = document.querySelector('.status-dot');
  dot.className = 'status-dot status-dot--error';
  var text = document.getElementById('status-text');
  text.textContent = msg || t('connection_error');
  state._errorUntil = Date.now() + 5000;
}

export function showPersistentError(msg) {
  var dot = document.querySelector('.status-dot');
  dot.className = state.consecutiveErrors >= 3 ? 'status-dot status-dot--error' : 'status-dot status-dot--offline';
  var text = document.getElementById('status-text');
  text.textContent = msg;
  state._errorUntil = Infinity;
}

export function clearPersistentError() {
  state._errorUntil = 0;
  state.consecutiveErrors = 0;
}
