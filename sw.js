/* Blitz Odds service worker.
 *
 * ============================ READ THIS FIRST ============================
 * This file handles `push` and `notificationclick`. NOTHING ELSE. Do not add
 * a `fetch` handler, a cache, or anything from Workbox to it, ever.
 *
 * index.html is the entire application - one file, transpiled in the browser
 * by Babel, with no build step and no cache-busting on the URL. A service
 * worker that intercepts `fetch` would therefore be caching *the whole app*
 * under a URL that never changes, and would keep serving a stale copy of it
 * to returning visitors long after a deploy. There is no version to bust and
 * no filename to hash, so there is no safe way to do it. Offline support is
 * not worth an app that silently stops updating.
 *
 * A worker with no `fetch` handler is not a "controlling" worker in the sense
 * that matters here: the browser goes to the network for every request as if
 * this file didn't exist. That's the point.
 * =========================================================================
 *
 * Bump SW_VERSION on any real change. It has no functional effect - it exists
 * so the byte content differs, which is what makes the browser treat the file
 * as updated and run `install` again.
 */
const SW_VERSION = "1.0.0";

self.addEventListener("install", () => {
  // Take over immediately rather than waiting for every tab to close. Safe
  // here precisely because nothing is cached - there's no old-worker state
  // for a new worker to disagree with.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/* The payload the server sends is the platform-neutral shape from
 * lib/push.mts: { title, body, url, collapseKey, data }. `collapseKey` maps
 * onto the Notification API's `tag`, which is how successive updates for one
 * game replace each other instead of stacking six deep on a lock screen. */
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    // A push with a non-JSON body is not something we send, but a browser
    // will still wake the worker for it. Showing *something* is required:
    // several browsers revoke push permission from a site that receives a
    // push and displays no notification.
    payload = { title: "Blitz Odds", body: "Tap to open Blitz Odds." };
  }

  const title = payload.title || "Blitz Odds";
  const options = {
    body: payload.body || "",
    icon: "/branding/app-icon-192.png",
    badge: "/branding/app-icon-192.png",
    tag: payload.collapseKey || undefined,
    // With a tag set, renotify makes a genuinely new update buzz rather than
    // silently swapping the text of a notification already sitting there.
    renotify: !!payload.collapseKey,
    data: { url: payload.url || "/", ...(payload.data || {}) },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";

  // Focus an existing tab if one is open rather than piling up new ones, and
  // navigate it to the notification's destination. Falls back to opening a
  // window when nothing is open.
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          if ("navigate" in client) {
            return client.navigate(target).then((c) => (c ? c.focus() : client.focus()));
          }
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
