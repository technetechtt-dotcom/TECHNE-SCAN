const CACHE = "techne-scan-v6";
const ASSETS = ["./","./index.html","./app.js","./ops.js","./i18n.js","./queue.js","./styles.css","./manifest.webmanifest","./vendor/qr.js","./icons/icon.svg","./idb.js","./api.js","./code128.js"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin || url.pathname.includes("/api/")) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
      }
      return response;
    } catch {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      if (event.request.mode === "navigate") {
        const home = await caches.match("./index.html");
        if (home) return home;
      }
      throw new Error("offline");
    }
  })());
});
