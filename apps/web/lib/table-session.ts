import { cookies } from "next/headers";

export const TABLE_COOKIE = "menu_table";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * httpOnly is the important one.
 *
 * The alternative — handing the session to client JavaScript so the browser
 * can call the API directly — would put it within reach of any script on the
 * page, where it could be lifted and replayed against the table it names. The
 * cost of keeping it here is a thin proxy handler per endpoint, which is a
 * good trade.
 *
 * Twelve hours: long enough for a meal and a slow evening, short enough that
 * someone who scanned at lunch is not still bound to that table at dinner.
 */
export function tableCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 12 * 60 * 60,
  };
}

export async function getTableToken(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(TABLE_COOKIE)?.value ?? null;
}

/**
 * Forwards a diner request to the API with the session attached.
 *
 * Returns the API's status untouched so the caller can distinguish an expired
 * session (401), a retired table (410), and a real failure — each of which the
 * diner sees differently.
 */
export async function proxyTableRequest(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  const token = await getTableToken();
  if (!token) {
    return Response.json({ message: "No table session" }, { status: 401 });
  }

  const res = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body !== undefined && { "Content-Type": "application/json" }),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  }).catch(() => null);

  if (!res) {
    return Response.json({ message: "Could not reach the kitchen" }, { status: 502 });
  }

  const text = await res.text();
  return new Response(text || "null", {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
