import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { TABLE_COOKIE, tableCookieOptions } from "@/lib/table-session";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * The scan target, and the only place a table is ever named in a URL.
 *
 * The brief's requirement was that the ordering URL must not differ per table,
 * or a diner could edit it and read another table's order. A QR on table 5
 * still has to encode something distinct from table 6, so the two roles that
 * URL was playing get separated: this address is a *claim*, not a location.
 *
 * It resolves the printed token, stores the resulting session in an httpOnly
 * cookie, and redirects to `/order` — the same address for every table at
 * every business. After this redirect there is nothing in the address bar to
 * tamper with, and the session is somewhere client script cannot reach.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  const res = await fetch(`${API}/public/tables/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
    cache: "no-store",
  }).catch(() => null);

  if (!res || !res.ok) {
    // An unknown or retired card sends them to the scanner rather than an
    // error page — they are holding a physical card and can try again.
    return NextResponse.redirect(new URL("/order?bad=1", getOrigin()));
  }

  const data = (await res.json()) as { sessionToken: string };

  const response = NextResponse.redirect(new URL("/order", getOrigin()));
  response.cookies.set(TABLE_COOKIE, data.sessionToken, tableCookieOptions());
  return response;

  function getOrigin() {
    return process.env.PUBLIC_MENU_BASE_URL ?? "http://localhost:3000";
  }
}

export async function POST() {
  // Only here so a stray form post does not 405 into a confusing error.
  const jar = await cookies();
  jar.delete(TABLE_COOKIE);
  return NextResponse.json({ ok: true });
}
