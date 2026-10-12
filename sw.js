const CACHE = 'portal-1.1.121';
const STATIC = [
  './',
  './index.html',
  './style.css?v=1.1.121',
  './portal.js?v=1.1.121',
  './shared/firebase-config.js?v=1.1.121',
  './shared/auth.js?v=1.1.121',
  './shared/suite-nav.js?v=1.1.121',
  './shared/load-script.js?v=1.1.121',
  './shared/a2hs.js?v=1.1.121',
  './shared/version.js?v=1.1.121',
  './manifest.json?v=1.1.121',
  './icons/icon-192.png?v=1.1.121',
  './icons/icon-512.png?v=1.1.121',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache =>
      Promise.all(STATIC.map(url =>
        fetch(new Request(url, { cache: 'reload' })).then(resp => cache.put(url, resp)).catch(() => {})
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

self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.hostname.includes('firebase') || url.hostname.includes('gstatic') || url.hostname.includes('jsdelivr') || url.hostname.includes('cloudflare')) return;

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
