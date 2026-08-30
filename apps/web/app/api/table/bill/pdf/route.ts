import { getTableToken } from "@/lib/table-session";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Streams the bill PDF through, rather than going via the JSON proxy.
 *
 * The session still never reaches the browser: the diner's link points here,
 * and the cookie is read server-side and swapped for a bearer token on the way
 * out. The 30-minute window is the API's to enforce, so a late request comes
 * back as a 404 with a readable message rather than a broken download.
 */
export async function GET(request: Request) {
  const token = await getTableToken();
  if (!token) {
    return new Response("No table session", { status: 401 });
  }

  // "bill" is the A5 page, "receipt" the till slip. Both are the diner's to
  // take, so the choice is passed straight through.
  const format =
    new URL(request.url).searchParams.get("format") === "receipt" ? "receipt" : "bill";

  const res = await fetch(`${API}/public/table/bill/pdf?format=${format}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  }).catch(() => null);

  if (!res || !res.ok) {
    return new Response(
      "That bill is no longer available to download. Ask a member of staff for a copy.",
      { status: res?.status ?? 502, headers: { "Content-Type": "text/plain" } },
    );
  }

  return new Response(res.body, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition":
        res.headers.get("Content-Disposition") ?? 'attachment; filename="bill.pdf"',
      "Cache-Control": "no-store",
    },
  });
}
