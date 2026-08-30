import type { Metadata } from "next";
import type { PublicMenu } from "@menu/shared";
import { Ordering } from "@/components/order/ordering";
import { Scanner } from "@/components/order/scanner";
import { getTableToken } from "@/lib/table-session";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Order",
  robots: { index: false, follow: false },
};

interface SessionInfo {
  table: { id: string; label: string };
  business: { name: string; publicCode: string; currency: string };
}

/**
 * One address for every table at every business.
 *
 * Which table this is comes from an httpOnly cookie, never the URL — so there
 * is nothing here for a diner to edit their way into someone else's order. No
 * cookie means no table, and no table means the scanner, which is the state a
 * diner is in when they have just sat down.
 */
export default async function OrderPage({
  searchParams,
}: {
  searchParams: Promise<{ bad?: string }>;
}) {
  const { bad } = await searchParams;
  const token = await getTableToken();

  if (!token) return <Scanner hadBadCard={bad === "1"} />;

  const headers = { Authorization: `Bearer ${token}` };

  const [sessionRes, menuRes] = await Promise.all([
    fetch(`${API}/public/table/session`, { headers, cache: "no-store" }).catch(() => null),
    fetch(`${API}/public/table/menu`, { headers, cache: "no-store" }).catch(() => null),
  ]);

  // An expired session, a retired table, or an unreachable API all land the
  // diner in the same place: the scanner, with the card still in their hand.
  if (!sessionRes?.ok || !menuRes?.ok) {
    return <Scanner hadBadCard={sessionRes?.status === 410} />;
  }

  const session = (await sessionRes.json()) as SessionInfo;
  const menu = (await menuRes.json()) as PublicMenu;

  return (
    <Ordering
      table={session.table}
      business={{ name: session.business.name, currency: session.business.currency }}
      menu={menu}
    />
  );
}
