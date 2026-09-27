import { RealtimeClient, REALTIME_SUBSCRIBE_STATES } from "@supabase/realtime-js";

/**
 * A subscription to one Realtime topic.
 *
 * What arrives is deliberately content-free — a ping saying "there is
 * something newer", never what. The caller answers it by fetching from the
 * authenticated API, which is why no order detail is ever on a pub/sub
 * channel and why a dropped message degrades to arriving late rather than
 * arriving wrong.
 *
 * `onConnectedChange` is the other half of that bargain: while it reports
 * false, the caller runs its fallback poll. The socket is an optimisation
 * over a polling system that already works, not a thing correctness rests
 * on.
 */
export interface LiveChannel {
  close(): void;
}

export interface LiveChannelOptions {
  supabaseUrl: string;
  anonKey: string;
  /** The HMAC topic the API handed us. Never derived here. */
  topic: string;
  onPing: () => void;
  onConnectedChange?: (connected: boolean) => void;
}

export function openChannel({
  supabaseUrl,
  anonKey,
  topic,
  onPing,
  onConnectedChange,
}: LiveChannelOptions): LiveChannel {
  const client = new RealtimeClient(`${supabaseUrl.replace(/\/$/, "")}/realtime/v1`, {
    params: { apikey: anonKey },
    // The library reconnects on its own; this only shapes how fast. Capped
    // well under a minute so a tablet that lost wifi during a rush is not
    // sitting on a five-minute backoff when it comes back.
    reconnectAfterMs: (tries) => [1_000, 2_000, 5_000, 10_000][tries - 1] ?? 15_000,
  });

  const channel = client.channel(topic, { config: { broadcast: { self: false } } });

  channel.on("broadcast", { event: "ping" }, () => onPing());

  channel.subscribe((status) => {
    // Anything that is not SUBSCRIBED means the caller should be polling:
    // CHANNEL_ERROR and TIMED_OUT are recoverable, CLOSED is not, and none
    // of them deliver pings.
    onConnectedChange?.(status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED);
  });

  return {
    close() {
      onConnectedChange?.(false);
      void channel.unsubscribe();
      void client.disconnect();
    },
  };
}

/** Whether Realtime is configured for this deployment at all. */
export function realtimeConfig(): { supabaseUrl: string; anonKey: string } | null {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return null;
  return { supabaseUrl, anonKey };
}
