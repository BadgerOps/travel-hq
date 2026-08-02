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

// ---------------------------------------------------------------- push (#61)
//
// Everything below is appended deliberately, and the fetch handler above is
// left byte-for-byte alone: tests/server/architecture.test.ts asserts on exact
// substrings of it, and a formatter run that reflowed those lines would fail
// CI for a reason nobody reading the diff would guess.

/** The path a notification with no usable `path` falls back to. */
const DEFAULT_NOTIFICATION_PATH = "/";

/**
 * Reads the encrypted payload the Worker sent (see src/server/push/payload.ts
 * for its closed field list). Total by construction: a push with no data, with
 * a non-JSON body, or from anything other than this app still shows SOMETHING,
 * because iOS counts a push that resolves without showing a notification
 * against the app and eventually revokes the subscription.
 */
function readPushPayload(event) {
  const fallback = { title: "Travel HQ", body: "", tag: undefined, path: DEFAULT_NOTIFICATION_PATH };
  if (!event.data) return fallback;
  let parsed;
  try {
    parsed = event.data.json();
  } catch {
    const text = event.data.text();
    return text ? { ...fallback, body: text } : fallback;
  }
  if (!parsed || typeof parsed !== "object") return fallback;
  return {
    title: typeof parsed.title === "string" && parsed.title ? parsed.title : fallback.title,
    body: typeof parsed.body === "string" ? parsed.body : "",
    tag: typeof parsed.tag === "string" && parsed.tag ? parsed.tag : undefined,
    // An app-relative path and nothing else. A notification is a click target
    // nobody can inspect before tapping, so a payload that somehow carried an
    // absolute or protocol-relative URL must not be able to navigate off-origin
    // — the server refuses to build one, and this refuses to trust it anyway.
    path:
      typeof parsed.path === "string" && parsed.path.startsWith("/") && !parsed.path.startsWith("//")
        ? parsed.path
        : DEFAULT_NOTIFICATION_PATH,
  };
}

self.addEventListener("push", (event) => {
  const payload = readPushPayload(event);
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      // The tag collapses a reminder that fires twice into one notification
      // rather than stacking duplicates on a lock screen.
      tag: payload.tag,
      // The path rides in `data` because that is the only thing that survives
      // to the notificationclick event.
      data: { path: payload.path },
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
    }),
  );
});

/**
 * Focus the app if it is already open, otherwise open it — and in both cases
 * land on the day the notification is about.
 *
 * Deep links are `/trips/<id>#days:YYYY-MM-DD` (issue #60). An already-open
 * client is navigated rather than merely focused: a phone that has had Travel
 * HQ sitting on the trips list for a week would otherwise answer a "you leave
 * in an hour" tap with the trips list.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path =
    event.notification.data && typeof event.notification.data.path === "string"
      ? event.notification.data.path
      : DEFAULT_NOTIFICATION_PATH;
  const target = new URL(path, self.location.origin);

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if (new URL(client.url).origin !== target.origin) continue;
          // navigate() is not implemented everywhere (and rejects for a client
          // the worker does not control); focusing is still the right outcome,
          // so a failure to navigate must not drop the tap on the floor.
          const focused = client.focus();
          if (typeof client.navigate !== "function") return focused;
          return Promise.resolve(focused)
            .then(() => client.navigate(target.href))
            .catch(() => undefined);
        }
        return self.clients.openWindow(target.href);
      })
      .catch(() => undefined),
  );
});
