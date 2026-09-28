/**
 * Same-origin auth proxy.
 *
 * Mobile Safari (ITP) and locked-down Android Chrome block third-party cookies
 * even with SameSite=None;Secure. Since the API is on a different domain from
 * the web app, the refresh cookie is "third-party" from the browser's point of
 * view and silently dropped — which makes every page load after a tab close
 * look like a session expiry.
 *
 * Routing /api/auth/* through a Next.js handler keeps cookies on
 * menu.irad.solutions, which is the origin the browser already trusts. The
 * route forwards the request to the real API and mirrors back whatever cookies
 * the API sets — including the new refresh token on login/refresh and the
 * clear on logout.
 */

import { type NextRequest, NextResponse } from "next/server";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Forward any method to the same path on the real API, relay the response
 * body and copy Set-Cookie headers back onto the same-origin response.
 */
async function proxy(req: NextRequest, path: string): Promise<NextResponse> {
  const url = `${API}/auth/${path}`;

  // Forward the inbound cookie header so the API sees the refresh token
  // the browser sent to this same-origin route.
  const headers: Record<string, string> = {
    "content-type": req.headers.get("content-type") ?? "application/json",
  };
  const cookieHeader = req.headers.get("cookie");
  if (cookieHeader) headers["cookie"] = cookieHeader;

  const authorization = req.headers.get("authorization");
  if (authorization) headers["authorization"] = authorization;

  const body =
    req.method !== "GET" && req.method !== "HEAD"
      ? await req.text().catch(() => undefined)
      : undefined;

  const upstream = await fetch(url, {
    method: req.method,
    headers,
    body: body || undefined,
    // Never follow redirects — let the API's own response come through.
    redirect: "manual",
  });

  // Build the response body.
  const responseBody =
    upstream.status === 204 ? null : await upstream.text().catch(() => null);

  const res = new NextResponse(responseBody, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
  });

  // Mirror every Set-Cookie the API emits. Re-write the cookie attributes so
  // it lands on this origin (menu.irad.solutions) rather than the API's
  // domain, and strip Domain= if present so the browser does not reject it.
  upstream.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") {
      // Drop Domain= — the browser will assign the cookie to the current
      // origin, which is what we want.
      const rewritten = value
        .replace(/;\s*domain=[^;]*/gi, "")
        // Force SameSite=Lax — same-origin cookies do not need None, and Lax
        // is the right default here (protects against CSRF while working on
        // every browser including Safari ITP).
        .replace(/;\s*samesite=[^;]*/gi, "; SameSite=Lax")
        // Secure is fine to keep — we are on HTTPS in prod.
        .trim();
      res.headers.append("set-cookie", rewritten);
    }
  });

  return res;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await params;
  return proxy(req, path.join("/"));
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await params;
  return proxy(req, path.join("/"));
}
