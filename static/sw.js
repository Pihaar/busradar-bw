// CACHE suffix is substituted by proxy.py from _VERSION when this file is
// served; the name changes on every deploy so the old cache is evicted in the
// activate event below.
var CACHE = 'busradar-__APP_VERSION__';
var PRECACHE_URLS = [
  '/',
  '/index.html',
  '/style.css',
  '/config.js',
  '/state.js',
  '/api.js',
  '/status.js',
  '/map.js',
  '/ui.js',
  '/refresh.js',
  '/init.js',
  '/i18n.js',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/vendor/leaflet.js',
  '/vendor/leaflet.css',
  '/fonts/dm-sans-latin.woff2',
  '/fonts/dm-sans-latin-ext.woff2',
  '/fonts/dm-mono-400-latin.woff2',
  '/fonts/dm-mono-400-latin-ext.woff2',
  '/fonts/dm-mono-500-latin.woff2',
  '/fonts/dm-mono-500-latin-ext.woff2',
  '/fonts/syne-latin.woff2',
  '/fonts/syne-latin-ext.woff2',
  '/fonts/syne-ext2.woff2',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return cache.addAll(PRECACHE_URLS);
    }).then(function() { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE && k.indexOf('busradar-') === 0; })
            .map(function(k) { return caches.delete(k); })
      );
    }).then(function() { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(event) {
  var url = new URL(event.request.url);

  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (event.request.mode === 'navigate') {
    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 3000);
    event.respondWith(
      fetch(event.request, {signal: controller.signal})
        .then(function(resp) { clearTimeout(timeout); return resp; })
        .catch(function() { clearTimeout(timeout); return caches.match('/index.html'); })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(function(cached) {
      if (cached) return cached;
      return fetch(event.request).then(function(resp) {
        if (resp.ok) {
          var clone = resp.clone();
          caches.open(CACHE).then(function(c) { c.put(event.request, clone); });
        }
        return resp;
      });
    })
  );
});
