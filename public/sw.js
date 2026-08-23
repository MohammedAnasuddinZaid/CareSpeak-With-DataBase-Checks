/* CareSpeak Service Worker v2
 * - App shell + pages: network-first with cache fallback.
 * - MediaPipe WASM/models on CDNs: cache-first (AI works fully offline after first load).
 * - /api/*: never cached (live data only).
 * - Background Sync "carespeak-flush": pings clients to flush the offline outbox.
 */
const VERSION = "carespeak-v2";
const SHELL = [
  "/", "/hand-mode", "/eye-mode", "/nurse-view", "/logs", "/report", "/about", "/emergency",
];
const CDN_HOSTS = ["cdn.jsdelivr.net", "storage.googleapis.com"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) =>
      Promise.allSettled(SHELL.map((url) => cache.add(url)))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Live API traffic must never hit the cache.
  if (url.origin === self.location.origin && url.pathname.startsWith("/api/")) return;

  // AI models + WASM: immutable content, cache forever once fetched.
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.match(req).then(
        (cached) =>
          cached ||
          fetch(req).then((res) => {
            const clone = res.clone();
            caches.open(VERSION).then((c) => c.put(req, clone));
            return res;
          })
      )
    );
    return;
  }

  // Everything else: network-first, fall back to cache when offline.
  if (url.origin === self.location.origin || url.protocol === "https:") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === "basic") {
            const clone = res.clone();
            caches.open(VERSION).then((c) => c.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || Response.error()))
    );
  }
});

self.addEventListener("sync", (event) => {
  if (event.tag === "carespeak-flush") {
    event.waitUntil(
      self.clients.matchAll({ includeUncontrolled: true }).then((clients) => {
        for (const client of clients) client.postMessage("carespeak-flush-outbox");
      })
    );
  }
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});
