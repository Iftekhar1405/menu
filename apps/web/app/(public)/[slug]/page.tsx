import { notFound, redirect } from "next/navigation";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Vanity addresses resolve to the permanent code and redirect there.
 *
 * The redirect matters: a printed card encodes the permanent code, and an
 * owner can rename their vanity slug freely. Serving the menu at both would
 * split the view counts and give the same menu two addresses.
 */
export default async function VanityPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const res = await fetch(`${API}/public/slugs/${encodeURIComponent(slug)}`, {
    next: { revalidate: 300 },
  }).catch(() => null);

  if (!res || !res.ok) notFound();

  const { publicCode } = (await res.json()) as { publicCode: string };
  redirect(`/m/${publicCode}`);
}
