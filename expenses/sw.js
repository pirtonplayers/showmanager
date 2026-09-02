const CACHE = 'expenses-1.0.68';
const STATIC = [
  './',
  './index.html',
  './admin.html',
  './help.html',
  './admin-help.html',
  './style.css?v=1.0.68',
  './app.js?v=1.0.68',
  './admin.js?v=1.0.68',
  '../shared/firebase-config.js?v=1.0.68',
  '../shared/auth.js?v=1.0.68',
  '../shared/suite-nav.js?v=1.0.68',
  '../shared/embed.js?v=1.0.68',
  './version.js?v=1.0.68',
  './manifest.json',
  './admin-manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/icon-admin-192.png',
  './icons/icon-admin-512.png',
  './icons/apple-touch-icon-admin.png',
];

self.addEventListener('install', e => {
  // Cache files but don't skip waiting — let the update banner handle that.
  // Fetch each with cache: 'reload' — plain addAll() lets the browser's own HTTP cache answer,
  // which can pre-cache stale copies (exactly the kind of "half old, half new" mismatch that
  // makes broken layouts hard to explain).
  e.waitUntil(
    caches.open(CACHE).then(cache =>
      Promise.all(STATIC.map(url =>
        fetch(new Request(url, { cache: 'reload' })).then(resp => cache.put(url, resp))
      ))
    )
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Page posts this message when the user taps "Update now"
self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.hostname.includes('firebase') || url.hostname.includes('gstatic') || url.hostname.includes('jsdelivr') || url.hostname.includes('cloudflare')) return;

  // Network-first: always try to get fresh content; fall back to cache when offline.
  // cache: 'reload' bypasses the browser's own HTTP cache, not just ours — otherwise a same-
  // origin fetch() can be silently answered from there instead of really hitting the network.
  e.respondWith(
    fetch(new Request(e.request, { cache: 'reload' }))
      .then(resp => {
        if (resp && resp.status === 200 && url.origin === location.origin) {
          caches.open(CACHE).then(c => c.put(e.request, resp.clone()));
        }
        return resp;
      })
      .catch(() => caches.match(e.request))
  );
});
