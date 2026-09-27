/*
 * Push only.
 *
 * Deliberately not a caching service worker. Offline caching for a
 * dashboard that reads live order state is mostly a way to show staff
 * yesterday's orders with confidence, and every cache bug in that class
 * looks like "the board is wrong" rather than "the cache is stale". This
 * file exists so a closed tab can still be told an order arrived.
 */

// Take over immediately rather than waiting for every tab to close. A
// counter tablet is never closed, so a worker that waits its turn is a
// worker that never ships its fix.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  // A push with no readable payload still has to show something: browsers
  // revoke push permission from origins that receive a push and display
  // nothing, so a silent early return would eventually disable the feature.
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }

  const title = data.title || "New order";
  const options = {
    body: data.body || "Open the board to see it.",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    // Per notification, so two orders stack rather than the second
    // replacing the first without anyone seeing it.
    tag: data.id ? `order-${data.id}` : undefined,
    // Kitchen alerts are the case this exists for: it should survive being
    // glanced past, and it should vibrate on a phone in an apron pocket.
    requireInteraction: true,
    vibrate: [90, 60, 90],
    data: { url: data.url || "/orders" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/orders";

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      // Focus a dashboard that is already open rather than opening a second
      // one. Staff end up with six tabs of the same board otherwise, each
      // holding its own socket.
      for (const client of clientList) {
        const url = new URL(client.url);
        if (url.origin === self.location.origin) {
          await client.focus();
          if ("navigate" in client && url.pathname !== target) {
            await client.navigate(target);
          }
          return;
        }
      }

      await self.clients.openWindow(target);
    })(),
  );
});
