const CACHE = "travelhq-static-v2";
const CACHE_PREFIX = "travelhq-";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
              .map((key) => caches.delete(key)),
          ),
        ),
      self.clients.claim(),
    ]),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname === "/healthz"
  ) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, event));
    return;
  }

  // Vite fingerprints production assets, so a cached /assets/* response is
  // immutable. Everything else stays on the network to avoid retaining
  // unversioned application data or an old service-worker script.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request, event));
  }
});

async function cacheFirst(request, event) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  cacheSuccessful(request, response, event);
  return response;
}

async function networkFirst(request, event) {
  try {
    const response = await fetch(request);
    cacheSuccessful(request, response, event);
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw error;
  }
}

function cacheSuccessful(request, response, event) {
  if (!response.ok || response.type === "opaque") return;
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.put(request, response.clone())),
  );
}
