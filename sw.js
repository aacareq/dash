// Service worker for the Scratchpad PWA.
//
// Scope: the whole /dash/ project (GitHub Pages subpath), but only same-origin
// GET requests are handled. Authenticated traffic to api.github.com always
// passes straight through and is NEVER written to the Cache API — tokens and
// the app private key must not be cached.
//
// Bump CACHE_VERSION whenever a precached asset changes; old caches are swept
// on activate, and the page prompts before taking over a running tab.

const CACHE_VERSION = "dash-scratch-v1";
const PRECACHE = [
  "./",
  "./scratchpad.html",
  "./manifest.webmanifest",
  "./assets/styles.css",
  "./assets/markdown.js",
  "./assets/emoji.js",
  "./assets/notes-store.js",
  "./assets/github-app.js",
  "./assets/sync-engine.js",
  "./assets/editor.js",
  "./assets/markdown-worker.js",
  "./assets/scratchpad.js",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/icons/maskable-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_VERSION).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // cross-origin API calls: untouched, uncached

  // Navigations: network-first so a new deploy is picked up, falling back to the
  // cached shell when offline (including the no-URL bar standalone launch).
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then(cached => cached || caches.match("./scratchpad.html")))
    );
    return;
  }

  // Static same-origin assets: cache-first, then network, caching what was missing.
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
