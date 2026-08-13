/* Service worker for Neon Serpent 30.
 *
 * The game is entirely static and has no network dependency in its core loop,
 * so it can be made fully playable offline by pre-caching a handful of files.
 *
 * Strategy:
 *   - navigations and code (html/css/js) -> network first, cache as fallback
 *   - /assets/*                          -> cache first (content-stable art)
 *   - /api/*                             -> never touched; leaderboard stays live
 *
 * Code is deliberately network-first rather than cache-first. Serving a stale
 * game.js would mean a fix does not reach players until a second reload, and
 * for a game the correctness of the build matters more than shaving a few
 * milliseconds off a warm load. Offline still works, because every response is
 * mirrored into the cache and used the moment the network is unavailable.
 *
 * Bump CACHE_VERSION whenever a precached file changes; the activate handler
 * deletes every other cache so old assets cannot linger.
 */
const CACHE_VERSION = "neon-serpent-v4";

const PRECACHE = [
  "./",
  "./index.html",
  "./privacy.html",
  "./terms.html",
  "./styles.css",
  "./src/main.js",
  "./src/engine.js",
  "./src/levels.js",
  "./src/utils.js",
  "./src/cloudSync.js",
  "./src/supabaseClient.js",
  "./src/supabaseConfig.js",
  "./sw-register.js",
  "./manifest.json",
  "./assets/favicon.svg",
  "./assets/favicon-32.png",
  "./assets/favicon-16.png",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/icon-maskable-512.png",
  "./assets/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      // Individual puts rather than addAll: one missing optional asset should
      // not abort the whole installation.
      .then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The leaderboard must never be served from cache.
  if (url.pathname.includes("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put("./index.html", copy));
          return response;
        })
        .catch(() => caches.match("./index.html").then((cached) => cached || caches.match("./")))
    );
    return;
  }

  // Art is content-stable and regenerated deliberately, so cache-first is safe
  // and keeps repeat loads instant.
  if (url.pathname.includes("/assets/")) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetchAndCache(request))
    );
    return;
  }

  // Everything else is code: prefer the network, fall back to cache.
  event.respondWith(networkFirstWithTimeout(request));
});

/* How long to wait for the network before serving a cached copy instead.
 *
 * Plain network-first had no timeout at all: "offline" is a clean, fast
 * rejection, but a weak mobile signal is not — fetch() can hang for tens of
 * seconds before giving up. With several module requests in flight that left
 * the game visibly half-loaded, which is the "does not load completely"
 * report. A cached response after 3s beats a correct one after 30s, and the
 * revalidation below still refreshes the cache in the background either way,
 * so the next load is current. */
const NETWORK_TIMEOUT_MS = 3000;

function networkFirstWithTimeout(request) {
  return caches.match(request).then((cached) => {
    const network = fetchAndCache(request);
    if (!cached) {
      // Nothing to fall back to, so the network is the only answer — waiting
      // is better than failing outright.
      return network;
    }
    return new Promise((resolve) => {
      let settled = false;
      const settle = (response) => {
        if (settled) return;
        settled = true;
        resolve(response);
      };
      const timer = setTimeout(() => settle(cached), NETWORK_TIMEOUT_MS);
      network
        .then((response) => {
          clearTimeout(timer);
          settle(response);
        })
        .catch(() => {
          clearTimeout(timer);
          settle(cached);
        });
    });
  });
}

function fetchAndCache(request) {
  return fetch(request).then((response) => {
    if (response && response.ok) {
      const copy = response.clone();
      caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
    }
    return response;
  });
}
