/**
 * Whether to offer alerts, asked exactly once.
 *
 * A native permission dialog fired on page load is the worst version of
 * this: most people dismiss a prompt they did not ask for, and a dismissal
 * is permanent — the browser will not ask again, so the origin is poisoned
 * for that device and no amount of later UI can recover it. So nothing here
 * calls `Notification.requestPermission()`; it returns whether to show a
 * card that a person can click, and the click is what asks.
 *
 * Kept free of `window` and `localStorage` so the rule can be tested
 * directly. The browser wiring is `browserPromptStore()` at the bottom.
 */
export interface PromptStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

const KEY = "menu.alerts.prompted";

export interface PromptContext {
  /** Notification and ServiceWorker both exist in this browser. */
  supported: boolean;
  permission: NotificationPermission;
  store: PromptStore;
}

export function shouldOfferAlerts({ supported, permission, store }: PromptContext): boolean {
  if (!supported) return false;

  // Already answered at the browser level. Granted needs no card; denied
  // cannot be undone by one, because the browser will not re-prompt.
  if (permission !== "default") return false;

  return read(store) === null;
}

/**
 * Records that the person answered — including by dismissing the card.
 *
 * Dismissal counts. It is the answer "no", and treating it as "ask me again
 * next time" is exactly the nagging this exists to prevent.
 */
export function recordPromptAnswered(store: PromptStore): void {
  write(store, new Date().toISOString());
}

/** Settings' re-enable control. The only way the card ever returns. */
export function clearPromptRecord(store: PromptStore): void {
  try {
    store.remove(KEY);
  } catch {
    // See read().
  }
}

/**
 * Storage access throws in private browsing and in some embedded webviews.
 * A dashboard that white-screens over a preference is a far worse failure
 * than a prompt shown twice, so every access here is allowed to fail.
 */
function read(store: PromptStore): string | null {
  try {
    return store.get(KEY);
  } catch {
    return null;
  }
}

function write(store: PromptStore, value: string): void {
  try {
    store.set(KEY, value);
  } catch {
    // As above.
  }
}

export function browserPromptStore(): PromptStore {
  return {
    get: (k) => window.localStorage.getItem(k),
    set: (k, v) => window.localStorage.setItem(k, v),
    remove: (k) => window.localStorage.removeItem(k),
  };
}

/** True when this browser can show notifications at all. */
export function notificationsSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "Notification" in window &&
    "serviceWorker" in navigator
  );
}

/**
 * iOS delivers Web Push only to sites installed to the Home Screen, and
 * says so by not exposing the API at all in a normal tab. Worth telling
 * people, because the alternative is a feature that appears broken.
 */
export function needsHomeScreenInstall(): boolean {
  if (typeof window === "undefined") return false;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const installed = window.matchMedia?.("(display-mode: standalone)").matches === true;
  return ios && !installed && !("Notification" in window);
}
