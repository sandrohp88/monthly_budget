// Service worker for FINANCE_OS: PWA installability, web push, and an
// offline screen. It caches PUBLIC STATIC ASSETS ONLY.
//
// Never cache page HTML, RSC payloads or /api/ responses. They carry one
// user's financial data, and CacheStorage is shared by the whole browser
// origin, not by user. An earlier version cached every same-origin GET, so a
// private page could still be read offline after logout (review 2026-09-21
// R09). A navigation that fails offline gets the public /offline.html page,
// never a stale copy of a financial page.

// v3: drops v2 ("finance-os-v2"), which could hold authenticated HTML.
// Activation deletes every cache except the current one.
const CACHE_NAME = "finance-os-static-v3";
const OFFLINE_URL = "/offline.html";
const PRECACHE_URLS = [OFFLINE_URL, "/icons/icon-192.png", "/icons/bluefalls-mark.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Logout (or anything else) can ask for every cache to be dropped.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "clear-caches") {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))),
    );
  }
});

// Web push: the server sends a JSON PushPayload (lib/push-payload.ts) —
// { title, body, url, tag }. Same tag replaces the previous notification so
// a re-nagged interest alert never stacks.
self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    return;
  }
  event.waitUntil(
    self.registration.showNotification(payload.title || "FINANCE_OS", {
      body: payload.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: payload.tag || "finance-os",
      data: { url: payload.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windows) => {
        for (const client of windows) {
          if ("focus" in client) {
            client.navigate(url);
            return client.focus();
          }
        }
        return self.clients.openWindow(url);
      }),
  );
});

/** Same-origin paths that hold no user data and may be cached. */
function isPublicStatic(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/manifest.json" ||
    url.pathname === OFFLINE_URL
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Page navigations: always the network. Offline, show the public offline
  // screen. The response is never stored.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(OFFLINE_URL).then((r) => r || Response.error()),
      ),
    );
    return;
  }

  // Everything else that isn't a public static asset (API, RSC flight data,
  // images/routes that may be user-specific) gets default browser handling
  // with no caching.
  if (!isPublicStatic(url)) return;

  // Hashed build assets are immutable: cache-first. The other public assets
  // are network-first so updates land, falling back to cache offline.
  const immutable = url.pathname.startsWith("/_next/static/");
  const fromNetwork = () =>
    fetch(request).then((response) => {
      if (response.status === 200 && response.type === "basic") {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
      }
      return response;
    });
  event.respondWith(
    immutable
      ? caches.match(request).then((hit) => hit || fromNetwork())
      : fromNetwork().catch(() => caches.match(request).then((r) => r || Response.error())),
  );
});
