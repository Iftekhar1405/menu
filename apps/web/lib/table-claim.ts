/**
 * After a QR scan, the diner must stay on the host they actually opened.
 *
 * Next.js `request.url` on Vercel is often `http://localhost:3000` because
 * that is where the function listens. Building a redirect from that — or
 * from a missing `PUBLIC_MENU_BASE_URL` that defaults the same way — sends
 * the phone to the diner's own machine instead of `/order` on this site.
 */
export function requestOrigin(request: Request): string {
  const forwardedHost = firstHeader(request.headers.get("x-forwarded-host"));
  const host = forwardedHost ?? firstHeader(request.headers.get("host"));
  if (host) {
    const proto =
      firstHeader(request.headers.get("x-forwarded-proto")) ??
      (isLoopbackHost(host) ? "http" : "https");
    return `${proto}://${host}`;
  }

  const configured = process.env.PUBLIC_MENU_BASE_URL?.replace(/\/$/, "");
  if (configured) return configured;

  return new URL(request.url).origin;
}

/** Printed cards encode an absolute URL; in-app scan must not follow that host. */
export function tableClaimPath(raw: string): string | null {
  const text = raw.trim();
  try {
    const url = hasScheme(text) ? new URL(text) : new URL(text, "http://local.invalid");
    const match = url.pathname.match(/\/t\/([^/]+)/);
    return match ? `/t/${match[1]}` : null;
  } catch {
    return null;
  }
}

function firstHeader(value: string | null): string | undefined {
  const part = value?.split(",")[0]?.trim();
  return part || undefined;
}

function isLoopbackHost(host: string): boolean {
  return host.startsWith("localhost") || host.startsWith("127.");
}

function hasScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}
