"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "@/lib/api-client";
import {
  createChime,
  readMuted,
  writeMuted,
  type Chime,
} from "@/lib/notifications/chime";
import { createEscalation, type Escalation } from "@/lib/notifications/escalation";
import {
  emptyFeed,
  markReadLocally,
  mergeFeed,
  type Feed,
  type FeedItem,
} from "@/lib/notifications/feed";
import {
  browserPromptStore,
  clearPromptRecord,
  notificationsSupported,
  recordPromptAnswered,
  shouldOfferAlerts,
} from "@/lib/notifications/permission";
import { openChannel, realtimeConfig, type LiveChannel } from "@/lib/notifications/realtime";
import { subscribeToPush, unsubscribeFromPush } from "@/lib/notifications/push";

/**
 * How often to re-read while the socket is down.
 *
 * Only runs when Realtime is not subscribed, which is the point: the
 * previous design polled every 5s unconditionally, on every open device,
 * forever. Here the socket carries the latency and this exists so that
 * losing it degrades to "slower" rather than "silent".
 */
const FALLBACK_POLL_MS = 25_000;

/** Toasts on screen at once. Beyond this the newest ones are unreadable. */
const MAX_TOASTS = 3;

interface NotificationsValue {
  feed: Feed;
  connected: boolean;
  muted: boolean;
  setMuted: (muted: boolean) => void;
  /** Whether to show the one-time "turn on alerts" card. */
  offerAlerts: boolean;
  enableAlerts: () => Promise<void>;
  dismissAlertsOffer: () => void;
  /** Settings' re-enable control. */
  resetAlertsOffer: () => void;
  alertsEnabled: boolean;
  disableAlerts: () => Promise<void>;
  markRead: (ids: number[]) => void;
  markAllRead: () => void;
  toasts: FeedItem[];
  dismissToast: (id: number) => void;
  /** Opening the board acknowledges everything on it. */
  acknowledgeAll: () => void;
}

const Ctx = createContext<NotificationsValue | null>(null);

export function useNotifications(): NotificationsValue {
  const value = useContext(Ctx);
  if (!value) throw new Error("useNotifications must be used inside NotificationsProvider");
  return value;
}

export function NotificationsProvider({
  businessId,
  children,
}: {
  businessId: string | null;
  children: React.ReactNode;
}) {
  const [feed, setFeed] = useState<Feed>(emptyFeed);
  const [connected, setConnected] = useState(false);
  const [muted, setMutedState] = useState(false);
  const [offerAlerts, setOfferAlerts] = useState(false);
  const [alertsEnabled, setAlertsEnabled] = useState(false);
  const [toasts, setToasts] = useState<FeedItem[]>([]);
  const [pushPublicKey, setPushPublicKey] = useState("");

  const chime = useRef<Chime | null>(null);
  const escalation = useRef<Escalation | null>(null);
  // Read inside callbacks that must not be re-created when the feed moves —
  // re-creating them would tear down and rebuild the socket on every order.
  const cursor = useRef(0);
  const booted = useRef(false);

  // ── Sound ───────────────────────────────────────────────────────────────

  useEffect(() => {
    const initial = readMuted();
    setMutedState(initial);
    chime.current = createChime({
      muted: initial,
      onMutedChange: writeMuted,
    });

    // The browser will not start an AudioContext outside a gesture, so the
    // first touch anywhere in the dashboard is what makes sound possible.
    // `once` because after that the context exists.
    const unlock = () => chime.current?.unlock();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });

    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  // ── Escalation ──────────────────────────────────────────────────────────

  useEffect(() => {
    escalation.current = createEscalation({
      onRealert: () => chime.current?.play("order"),
    });
    return () => escalation.current?.stop();
  }, []);

  // ── Reading ─────────────────────────────────────────────────────────────

  const announce = useCallback((fresh: FeedItem[]) => {
    if (fresh.length === 0) return;

    chime.current?.play("order");

    setToasts((current) => [...fresh, ...current].slice(0, MAX_TOASTS));

    for (const item of fresh) {
      escalation.current?.arm(item.id);
      showOsNotification(item);
    }
  }, []);

  const refresh = useCallback(
    async (initial: boolean) => {
      if (!businessId) return;
      try {
        const since = initial ? "" : `?since=${cursor.current}`;
        const res = await api.get<{
          items: FeedItem[];
          unread: number;
          cursor: number;
          channel: string;
          pushPublicKey: string;
        }>(`/businesses/${businessId}/notifications${since}`);

        setPushPublicKey(res.pushPublicKey);
        cursor.current = Math.max(cursor.current, res.cursor);

        setFeed((current) => {
          const { feed: next, fresh } = mergeFeed(current, res.items, {
            cursor: res.cursor,
            initial,
          });
          // Outside the reducer's control flow: announcing during an update
          // would fire twice under StrictMode's double-invoke.
          queueMicrotask(() => announce(fresh));
          return next;
        });

        return res.channel;
      } catch {
        // A failed read is not an error state worth showing. The next ping,
        // tab focus or fallback tick tries again, and the board itself has
        // its own loading and error handling.
        return undefined;
      }
    },
    [businessId, announce],
  );

  // ── Bootstrap, socket, fallback ─────────────────────────────────────────

  useEffect(() => {
    if (!businessId) return;

    booted.current = false;
    cursor.current = 0;
    setFeed(emptyFeed);

    let channel: LiveChannel | null = null;
    let cancelled = false;

    void (async () => {
      const topic = await refresh(true);
      if (cancelled) return;
      booted.current = true;

      const config = realtimeConfig();
      if (!topic || !config) return;

      channel = openChannel({
        ...config,
        topic,
        onPing: () => void refresh(false),
        onConnectedChange: setConnected,
      });
    })();

    return () => {
      cancelled = true;
      channel?.close();
      setConnected(false);
    };
  }, [businessId, refresh]);

  useEffect(() => {
    // Only while the socket is down. When it is up this interval does not
    // exist, which is the whole saving over the previous 5s poll.
    if (connected || !businessId) return;
    const id = setInterval(() => void refresh(false), FALLBACK_POLL_MS);
    return () => clearInterval(id);
  }, [connected, businessId, refresh]);

  useEffect(() => {
    // A tablet that slept through a delivery wakes with a stale feed and,
    // depending on the browser, a socket that thinks it is still connected.
    // Catching up on focus covers both.
    const onVisible = () => {
      if (document.visibilityState === "visible" && booted.current) void refresh(false);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [refresh]);

  // ── Permission ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (!notificationsSupported()) return;
    setAlertsEnabled(Notification.permission === "granted");
    setOfferAlerts(
      shouldOfferAlerts({
        supported: true,
        permission: Notification.permission,
        store: browserPromptStore(),
      }),
    );
  }, []);

  const enableAlerts = useCallback(async () => {
    // Called from a click, never on load: the browser requires a gesture for
    // push subscription, and an unprompted dialog is the reliable way to get
    // a permanent denial.
    recordPromptAnswered(browserPromptStore());
    setOfferAlerts(false);

    const permission = await Notification.requestPermission();
    setAlertsEnabled(permission === "granted");
    if (permission !== "granted" || !businessId) return;

    await subscribeToPush(businessId, pushPublicKey);
  }, [businessId, pushPublicKey]);

  const disableAlerts = useCallback(async () => {
    if (!businessId) return;
    await unsubscribeFromPush(businessId);
    setAlertsEnabled(false);
  }, [businessId]);

  // ── Actions ─────────────────────────────────────────────────────────────

  const markRead = useCallback(
    (ids: number[]) => {
      // Locally first: a round trip to a database ~400ms away is long
      // enough that tapping the badge reads as having done nothing.
      setFeed((current) => markReadLocally(current, ids));
      for (const id of ids) escalation.current?.acknowledge(id);
      if (businessId) void api.post(`/businesses/${businessId}/notifications/read`, { ids });
    },
    [businessId],
  );

  const markAllRead = useCallback(() => {
    setFeed((current) => markReadLocally(current, []));
    escalation.current?.acknowledgeAll();
    setToasts([]);
    if (businessId) void api.post(`/businesses/${businessId}/notifications/read`, {});
  }, [businessId]);

  const value = useMemo<NotificationsValue>(
    () => ({
      feed,
      connected,
      muted,
      setMuted: (next) => {
        setMutedState(next);
        chime.current?.setMuted(next);
      },
      offerAlerts,
      enableAlerts,
      dismissAlertsOffer: () => {
        // Dismissal is an answer. Recording it is what makes "asked once"
        // true rather than "asked once per reload".
        recordPromptAnswered(browserPromptStore());
        setOfferAlerts(false);
      },
      resetAlertsOffer: () => {
        clearPromptRecord(browserPromptStore());
        setOfferAlerts(
          shouldOfferAlerts({
            supported: notificationsSupported(),
            permission: notificationsSupported() ? Notification.permission : "denied",
            store: browserPromptStore(),
          }),
        );
      },
      alertsEnabled,
      disableAlerts,
      markRead,
      markAllRead,
      toasts,
      dismissToast: (id) => setToasts((current) => current.filter((t) => t.id !== id)),
      acknowledgeAll: () => escalation.current?.acknowledgeAll(),
    }),
    [
      feed,
      connected,
      muted,
      offerAlerts,
      enableAlerts,
      alertsEnabled,
      disableAlerts,
      markRead,
      markAllRead,
      toasts,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * The OS-level notification, for when the dashboard is behind another
 * window. Only when the tab is actually hidden — a banner duplicating a
 * toast already on screen is noise.
 */
function showOsNotification(item: FeedItem): void {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  if (document.visibilityState === "visible") return;

  try {
    const notification = new Notification(item.title, {
      body: item.body,
      // Tagged per notification so two orders stack, rather than the second
      // silently replacing the first.
      tag: `order-${item.id}`,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    // Some browsers throw when constructing one outside a service worker.
    // Push covers those; the toast already covers the visible case.
  }
}
