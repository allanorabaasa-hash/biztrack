const CACHE_NAME = "biztrack-shell-v8";
const APP_SHELL = [
  "./",
  "./index.html",
  "./static/app.css?v=6",
  "./static/app.js?v=24",
  "./static/supabase-config.js",
  "./static/vendor/supabase-2.56.0.min.js",
  "./manifest.webmanifest",
  "./static/icons/icon-192.png",
  "./static/icons/icon-512.png",
  "./static/icons/icon-512-maskable.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await cache.addAll(APP_SHELL);
      if (!self.registration.active) await self.skipWaiting();
    }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) => key.startsWith("biztrack-shell-") && key !== CACHE_NAME,
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.hostname.endsWith(".supabase.co")) {
    event.respondWith(fetch(request));
    return;
  }
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then(async (cached) => {
      if (cached) return cached;
      const versionlessPath = url.pathname;
      const cache = await caches.open(CACHE_NAME);
      const shellMatch = APP_SHELL.find((path) => {
        const resolved = new URL(path, self.registration.scope);
        return (
          resolved.pathname === url.pathname &&
          (resolved.search === url.search ||
            resolved.pathname === versionlessPath)
        );
      });
      if (shellMatch) {
        const shellUrl = new URL(shellMatch, self.registration.scope);
        const shell = await cache.match(shellUrl.href);
        if (shell) return shell;
      }
      if (request.mode === "navigate") return caches.match("./index.html");
      return fetch(request).then((response) => {
        if (response.ok && url.pathname.endsWith(".js")) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
