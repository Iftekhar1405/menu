import { createHmac } from "node:crypto";

/**
 * The Realtime topic a client is allowed to listen on.
 *
 * Derived rather than taken literally, because the ids involved are not
 * secrets: a business id appears in every `/businesses/:bid/...` URL, and so
 * in browser history, server logs and referrer headers. Naming the topic
 * after it would let anyone who ever saw one of those URLs subscribe to that
 * restaurant's activity.
 *
 * Under an HMAC the topic becomes an unguessable capability that a leaked id
 * does not yield. The API hands each client its own name; nothing derives one
 * client-side, which is also why the secret can stay server-side.
 *
 * 128 bits is kept — the same strength as a printed table token — and the
 * rest discarded, so topics stay short enough to read in a dashboard.
 */
function derive(kind: "business" | "table", id: string, secret: string): string {
  const digest = createHmac("sha256", secret).update(`${kind}:${id}`).digest("hex");
  return `${kind}:${digest.slice(0, 32)}`;
}

export function businessChannel(businessId: string, secret: string): string {
  return derive("business", businessId, secret);
}

export function tableChannel(tableId: string, secret: string): string {
  return derive("table", tableId, secret);
}
