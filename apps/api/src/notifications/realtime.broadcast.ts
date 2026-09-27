import { Injectable, Logger } from "@nestjs/common";
import { loadEnv, usesRealtime } from "../config/env";

/**
 * Broadcasts a ping to a Supabase Realtime topic over HTTP.
 *
 * HTTP, not a socket, and that is the whole reason this works: the API is a
 * Vercel function with a 30s ceiling and no shared memory between instances,
 * so it has nothing to hold a WebSocket with. Supabase's broadcast endpoint
 * turns a fan-out into a single outbound POST, which a function can do.
 *
 * The payload is deliberately content-free. It says "there is something
 * newer than this cursor", never what. Clients answer it by fetching from
 * the authenticated API, so no order detail is ever on a pub/sub channel and
 * a lost message degrades to arriving late rather than arriving wrong.
 */
@Injectable()
export class RealtimeBroadcaster {
  private readonly logger = new Logger(RealtimeBroadcaster.name);
  private readonly env = loadEnv();

  /**
   * Never throws.
   *
   * A ping is an optimisation over polling that already works. Failing an
   * order because Supabase was briefly unreachable would trade a 25s delay
   * for a diner seeing an error on a meal they successfully ordered.
   */
  async ping(topic: string, payload: Record<string, unknown> = {}): Promise<void> {
    if (!usesRealtime(this.env)) return;

    try {
      const res = await fetch(`${this.env.SUPABASE_URL}/realtime/v1/api/broadcast`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: this.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({
          messages: [{ topic, event: "ping", payload, private: false }],
        }),
        // The order is already committed; nothing waits on this.
        signal: AbortSignal.timeout(5_000),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "<unreadable>");
        this.logger.warn(`Broadcast to ${topic} failed (${res.status}): ${detail}`);
      }
    } catch (err) {
      this.logger.warn(
        `Broadcast to ${topic} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
