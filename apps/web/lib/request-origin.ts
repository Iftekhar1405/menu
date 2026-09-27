/**
 * The origin the diner actually reached us on.
 *
 * Every redirect issued from a scan has to point back at the host in the
 * diner's address bar, not at a configured one. The scan response also sets
 * the table-session cookie, and a cookie is scoped to the host that set it —
 * redirect to a different host and the session is simply gone, which looks
 * from the diner's side like the QR did nothing.
 *
 * Behind Vercel the function sees an internal host, so the forwarded headers
 * are the authority when present; locally there are none and the request URL
 * is already correct.
 */
export function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = firstHop(request.headers.get("x-forwarded-host")) ?? url.host;
  const proto =
    firstHop(request.headers.get("x-forwarded-proto")) ??
    url.protocol.replace(":", "");
  return `${proto}://${host}`;
}

/** Chained proxies append to these headers; the first hop is the public one. */
function firstHop(header: string | null): string | null {
  const value = header?.split(",")[0]?.trim();
  return value ? value : null;
}
