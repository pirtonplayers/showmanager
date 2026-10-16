const CACHE = 'showdrinks-1.1.177';
const STATIC = [
  './',
  './index.html',
  './style.css?v=1.1.177',
  './order.js?v=1.1.177',
  '../shared/version.js?v=1.1.177',
  './manifest.json?v=1.1.177',
];

self.addEventListener('install', e => {
  // Cache files but don't skip waiting — let the update banner handle that
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)));
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
  if (url.hostname.includes('firebase') || url.hostname.includes('gstatic') || url.hostname.includes('cloudflare')) return;

  // Network-first: always try to get fresh content; fall back to cache when offline
  e.respondWith(
    fetch(e.request)
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
