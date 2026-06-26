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

export function formatStatusText(count, users, timeStr) {
  var usersStr = null;
  if (typeof users === 'string' && users && users !== '0') {
    usersStr = (users === '1') ? t('users_one') : t('users_many', {n: users});
  }
  if (count === 1) {
    return usersStr
      ? t('bus_count_one_with_users', {users: usersStr, time: timeStr})
      : t('bus_count_one', {time: timeStr});
  }
  return usersStr
    ? t('buses_count_with_users', {count: count, users: usersStr, time: timeStr})
    : t('buses_count', {count: count, time: timeStr});
}

export function updateStatus(count, dataAge, users) {
  // A fresh vehicles event is itself the recovery signal: clear any
  // persistent error (stale-flag, connection-lost banner) before painting
  // the live state. Without this, the 45s stale-timer setting
  // _errorUntil=Infinity wedges the dot red forever even after data
  // resumes (the `online` window event can clear it too, but only when
  // navigator.onLine actually flips — proxy stalls don't trigger that).
  // Transient `showError` calls (5s window) still suppress updates as
  // before — only the Infinity persistent state gets short-circuited.
  if (state._errorUntil === Infinity) {
    state._errorUntil = 0;
    state.consecutiveErrors = 0;
  } else if (state._errorUntil && Date.now() < state._errorUntil) {
    state._lastBusCount = count;
    return;
  }
  var dot = document.querySelector('.status-dot');
  var text = document.getElementById('status-text');
  dot.className = 'status-dot status-dot--live';
  if (dataAge != null && dataAge < 2) {
    dot.classList.add('status-dot--flash');
    setTimeout(function() { dot.classList.remove('status-dot--flash'); }, 600);
  }
  state._lastBusCount = count;
  text.textContent = formatStatusText(count, users, getServerTimeStr());
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
