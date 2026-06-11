/* PM service worker — delivers agent-reply Web Push notifications when the
 * PM tab/app is closed, and focuses (or opens) the right chat on click.
 * Served from the app root (/sw.js) so its scope covers the whole app. */

self.addEventListener("install", () => {
  // Activate this version immediately instead of waiting for old tabs to close.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (err) {
    payload = { title: "PM", body: event.data ? event.data.text() : "" };
  }

  const title = payload.title || "PM";
  const url = payload.url || "/";
  const options = {
    body: payload.body || "",
    tag: payload.tag || undefined,
    // A later reply with the same tag replaces the previous notification
    // instead of stacking, but still re-alerts the user.
    renotify: Boolean(payload.tag),
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-72.png",
    data: { url },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        // Focus an existing PM tab and navigate it to the target if possible.
        for (const client of clientList) {
          if ("focus" in client) {
            client.focus();
            if ("navigate" in client && targetUrl) {
              try {
                client.navigate(targetUrl);
              } catch (err) {
                /* cross-origin or unsupported — fall through to openWindow */
              }
            }
            return;
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
      }),
  );
});
