import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import webpush from "web-push";
import { loadEnv, usesWebPush } from "../config/env";

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** What the service worker receives. Small: push payloads are size-capped. */
export interface PushPayload {
  id: string;
  title: string;
  body: string;
  url?: string;
}

/** Injected so the fan-out logic can be tested without a push service. */
export type PushDelivery = (sub: PushTarget, payload: PushPayload) => Promise<void>;

/**
 * Token for overriding delivery.
 *
 * Nest resolves constructor parameters by their emitted design type, and a
 * function type alias emits `Function` — so an un-annotated `deliver?:
 * PushDelivery` sends it looking for a `Function` provider and the whole
 * application fails to boot. TypeScript's `?` says nothing to the injector.
 * Nothing provides this today; it exists so the parameter is optional in
 * Nest's terms as well as TypeScript's.
 */
export const PUSH_DELIVERY = Symbol("PUSH_DELIVERY");

export interface PushResult {
  delivered: number;
  /** Endpoints the push service says no longer exist. Prune these. */
  dead: string[];
}

/**
 * Status codes that mean the subscription is gone for good.
 *
 * Only these. A 500 or a timeout says nothing about whether the device still
 * exists, and pruning on one would quietly unsubscribe an owner because
 * their push provider had a bad minute — the kind of failure nobody notices
 * until an order is missed weeks later.
 */
const GONE = new Set([404, 410]);

@Injectable()
export class WebPushSender {
  private readonly logger = new Logger(WebPushSender.name);
  private readonly deliver: PushDelivery;

  constructor(
    @Optional()
    @Inject(PUSH_DELIVERY)
    deliver?: PushDelivery,
  ) {
    this.deliver = deliver ?? defaultDelivery();
  }

  async send(subs: PushTarget[], payload: PushPayload): Promise<PushResult> {
    if (subs.length === 0) return { delivered: 0, dead: [] };

    const settled = await Promise.allSettled(
      subs.map((sub) => this.deliver(sub, payload)),
    );

    const dead: string[] = [];
    let delivered = 0;

    settled.forEach((result, i) => {
      const endpoint = subs[i]!.endpoint;
      if (result.status === "fulfilled") {
        delivered++;
        return;
      }
      const status = statusOf(result.reason);
      if (status !== null && GONE.has(status)) {
        dead.push(endpoint);
        return;
      }
      this.logger.warn(`Push to ${hostOf(endpoint)} failed: ${describe(result.reason)}`);
    });

    return { delivered, dead };
  }
}

function defaultDelivery(): PushDelivery {
  const env = loadEnv();
  if (!usesWebPush(env)) {
    // Not an error: an install without VAPID keys simply has no closed-tab
    // delivery, and everything else about notifications still works.
    return async () => {};
  }
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);

  return async (sub, payload) => {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      // Urgency high: a kitchen ticket is the case push urgency exists for.
      // TTL short for the same reason — an order announced twenty minutes
      // late is worse than one never announced.
      { urgency: "high", TTL: 600 },
    );
  };
}

function statusOf(reason: unknown): number | null {
  if (typeof reason === "object" && reason !== null && "statusCode" in reason) {
    const code = (reason as { statusCode: unknown }).statusCode;
    if (typeof code === "number") return code;
  }
  return null;
}

function describe(reason: unknown): string {
  const status = statusOf(reason);
  if (status !== null) return `status ${status}`;
  return reason instanceof Error ? reason.message : String(reason);
}

/** Endpoints are long and per-device; the host is the useful part in a log. */
function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "<unparseable endpoint>";
  }
}
