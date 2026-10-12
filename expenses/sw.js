const CACHE = 'expenses-1.1.149';
const STATIC = [
  './',
  './index.html',
  './admin.html',
  './help.html',
  './admin-help.html',
  './style.css?v=1.1.149',
  './app.js?v=1.1.149',
  './admin.js?v=1.1.149',
  '../shared/firebase-config.js?v=1.1.149',
  '../shared/auth.js?v=1.1.149',
  '../shared/suite-nav.js?v=1.1.149',
  '../shared/a2hs.js?v=1.1.149',
  '../shared/embed.js?v=1.1.149',
  '../shared/version.js?v=1.1.149',
  './manifest.json?v=1.1.149',
  './admin-manifest.json?v=1.1.149',
  './icons/icon-192.png?v=1.1.149',
  './icons/icon-512.png?v=1.1.149',
  './icons/apple-touch-icon.png?v=1.1.149',
  './icons/icon-admin-192.png?v=1.1.149',
  './icons/icon-admin-512.png?v=1.1.149',
  './icons/apple-touch-icon-admin.png?v=1.1.149',
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
          // Clone synchronously, right here — doing it inside caches.open().then() below raced the
          // browser already starting to consume resp's body, throwing "Response body is already used".
          const respClone = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, respClone));
        }
        return resp;
      })
      .catch(() => caches.match(e.request))
  );
});
