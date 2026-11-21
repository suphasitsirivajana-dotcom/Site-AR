// SiteAR service worker: app shell cache-first, CDN libraries cached on first use → works offline on site.
const VERSION = 'sitear-v1.4.0';
const SHELL = [
  './', './index.html', './css/app.css', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
  './js/main.js', './js/viewer.js', './js/loaders.js', './js/geo.js', './js/store.js', './js/project.js', './js/sensors.js',
  './js/ar.js', './js/pose.js', './js/bcf.js', './js/qr.js', './js/ui.js', './js/icons.js'
];
const CDN = /^https:\/\/(cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (CDN.test(req.url)) {
    // versioned CDN files never change: cache-first
    e.respondWith(caches.open(VERSION).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin === location.origin) {
    // app files: network-first so updates arrive, cache fallback offline
    // cache:'reload' = always go to the server (and refresh the browser cache), so a new upload shows up at once and
    // old/new files can never be mixed (GitHub Pages otherwise lets the browser reuse a stale copy for ~10 minutes)
    e.respondWith(fetch(req, { cache: 'reload' }).then((res) => {
      if (res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone()));
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match('./index.html'))));
  }
});
