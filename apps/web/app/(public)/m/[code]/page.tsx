import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { PublicMenu } from "@menu/shared";
import { MenuView } from "@/components/templates";
import { ViewBeacon } from "./view-beacon";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * The diner-facing page.
 *
 * Statically rendered and revalidated on demand when the owner saves, because
 * this gets opened on congested restaurant wifi by someone who has just sat
 * down. Serving cached HTML instead of a database round trip per scan is the
 * single biggest thing we can do for how the product feels.
 */
export const dynamicParams = true;
export const revalidate = 3600;

async function fetchMenu(code: string): Promise<PublicMenu | null> {
  try {
    const res = await fetch(`${API}/public/menus/${code}`, {
      next: { tags: [`menu:${code}`], revalidate: 3600 },
    });
    if (!res.ok) return null;
    return (await res.json()) as PublicMenu;
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ code: string }>;
}): Promise<Metadata> {
  const { code } = await params;
  const menu = await fetchMenu(code);
  if (!menu) return { title: "Menu not found" };

  return {
    title: menu.business.name,
    description: `Menu for ${menu.business.name}${
      menu.business.address?.city ? ` in ${menu.business.address.city}` : ""
    }.`,
    openGraph: {
      title: menu.business.name,
      description: "See the menu",
      type: "website",
    },
  };
}

export default async function PublicMenuPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const menu = await fetchMenu(code);
  if (!menu) notFound();

  return (
    <main className="mx-auto min-h-screen max-w-[560px] bg-white shadow-[0_0_0_1px_rgba(17,17,19,0.05)]">
      <MenuView menu={menu} />
      <ViewBeacon code={code} />
    </main>
  );
}
