import { api } from "@/lib/api-client";

/**
 * Web Push: the part that reaches a device with the dashboard closed.
 *
 * Everything else in this feature works while a tab is alive. This is the
 * one path that wakes an owner who has walked away from the counter, and it
 * needs three things to line up — a registered service worker, granted
 * permission, and a subscription stored server-side — so each failure here
 * returns quietly rather than throwing into a click handler.
 */
const SW_PATH = "/sw.js";

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register(SW_PATH, { scope: "/" });
  } catch {
    return null;
  }
}

export async function subscribeToPush(
  businessId: string,
  vapidPublicKey: string,
): Promise<boolean> {
  // No VAPID keys configured on the API. Everything else still works; this
  // deployment simply has no closed-tab delivery.
  if (!vapidPublicKey) return false;

  const registration = await registerServiceWorker();
  if (!registration) return false;

  try {
    // Reuse whatever this browser already has. Calling subscribe() twice
    // with the same key returns the same subscription, but only if the key
    // matches — a rotated VAPID key needs the old one dropped first.
    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        // Required to be true by every browser that implements push: a
        // silent push is not allowed.
        userVisibleOnly: true,
        applicationServerKey: decodeVapidKey(vapidPublicKey),
      }));

    const json = subscription.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return false;

    await api.post(`/businesses/${businessId}/notifications/push`, {
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      userAgent: navigator.userAgent.slice(0, 512),
    });
    return true;
  } catch {
    return false;
  }
}

export async function unsubscribeFromPush(businessId: string): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration(SW_PATH);
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;

    // Server first. Unsubscribing locally and then failing to tell the API
    // leaves a row that pushes into a void until the service 410s it.
    await api.post(`/businesses/${businessId}/notifications/push/remove`, {
      endpoint: subscription.endpoint,
    });
    await subscription.unsubscribe();
  } catch {
    // Nothing the person can act on.
  }
}

/**
 * VAPID keys travel as base64url; `pushManager.subscribe` wants raw bytes.
 *
 * Exported for its own test: the padding and the two substituted characters
 * are easy to get wrong, and the failure is an opaque DOMException at
 * subscribe time rather than anything that points here.
 */
export function decodeVapidKey(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = base64Url.padEnd(base64Url.length + ((4 - (base64Url.length % 4)) % 4), "=");
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);

  // Built on an explicit ArrayBuffer rather than Uint8Array.from: the latter
  // is typed over ArrayBufferLike, which includes SharedArrayBuffer, and
  // pushManager.subscribe will not accept that union.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
