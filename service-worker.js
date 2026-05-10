// service-worker.js — minimal cache-first app shell for offline install.
//
// Bump CACHE_VERSION when you ship changes; old caches are cleaned on activate.

// Bump together with APP_VERSION in app.js on each release.
const CACHE_VERSION = 'pen-plotter-v0.6';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './ble.js',
  './gcode.js',
  './ui.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  // CDN libs — listed so they're cached on first online visit.
  'https://cdn.jsdelivr.net/npm/paper@0.12.17/dist/paper-core.min.js',
  'https://cdn.jsdelivr.net/npm/imagetracerjs@1.2.6/imagetracer_v1.2.6.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // addAll fails the whole install on a single 404; tolerate cdn hiccups.
      Promise.allSettled(APP_SHELL.map((u) => cache.add(u)))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        // Opportunistically cache successful same-origin + cdn responses.
        if (res.ok && (res.type === 'basic' || res.type === 'cors')) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached);
    })
  );
});
