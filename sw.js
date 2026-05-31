// Service worker — offline-first caching of the entire app + catalog.
//
// Strategy:
//   - Cache is keyed by APP_VERSION (imported from version.js). The pre-commit
//     hook bumps APP_VERSION on every commit, so each deploy gets its own cache
//     and old caches are deleted on activate. No manual bookkeeping needed.
//   - Install precaches only the app shell (HTML/CSS/JS/icons) — small and
//     reliable. catalog.json + enrichment.json are large (~9 MB gzipped) and
//     get cached opportunistically on first fetch via the fetch handler.
//   - Fetch handler: cache-first for same-origin GETs, with network fallback
//     that backfills the cache. Navigation requests always serve cached
//     index.html (single-page hash-routed app).
//
// Registered from app.js as `{ type: 'module' }` so this file can use ES
// module imports. Supported in Chrome 89+, Firefox 114+, Safari 16.4+.

import { APP_VERSION } from './version.js';

const CACHE = `nortabs-v${APP_VERSION}`;

const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './state.js',
  './router.js',
  './catalog.js',
  './chord-data.js',
  './chord-diagrams.js',
  './chord-wrap.js',
  './exporter.js',
  './playback.js',
  './search.js',
  './storage.js',
  './util.js',
  './version.js',
  './views/artist.js',
  './views/letter-index.js',
  './views/search-bar.js',
  './views/share.js',
  './views/song.js',
  './views/songbook.js',
  './views/songbooks.js',
  './views/tab.js',
  './images/home-wordcloud.svg',
  './manifest.json',
  './images/icon-192.png',
  './images/icon-512.png',
  './images/icon-maskable-512.png',
  './images/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (req.mode === 'navigate') {
    // Only serve cached index.html for the SPA's root path. Deeper
    // navigation (docs/import-ug-guide.html, etc.) falls through to the
    // cache-first handler below so the actual HTML is served — not the
    // SPA shell. Pages outside the SPA route's hash-fragment land here.
    const path = url.pathname;
    const isSpaRoot = path === '/' || path === '' || path === '/index.html';
    if (isSpaRoot) {
      event.respondWith(
        caches.match('./index.html').then((cached) => cached ?? fetch(req))
      );
      return;
    }
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        if (resp.ok && resp.type === 'basic') {
          const clone = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, clone));
        }
        return resp;
      });
    })
  );
});
