import { revalidatePath, revalidateTag } from "next/cache";
import { NextResponse } from "next/server";

/**
 * Called by the API the moment an owner saves, so the cached public page is
 * replaced within seconds rather than waiting out its TTL.
 *
 * Guarded by a shared secret: without one, anyone could force us to rebuild
 * arbitrary pages on demand.
 */
export async function POST(request: Request) {
  const secret = request.headers.get("x-revalidate-secret");
  if (!secret || secret !== process.env.REVALIDATE_SECRET) {
    return NextResponse.json({ message: "Not authorised" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { path?: string } | null;
  const path = body?.path;

  // Only public menu paths are revalidatable. Accepting an arbitrary path
  // would let a leaked secret churn the whole site.
  if (!path || !/^\/m\/[A-Z0-9]{8}$/.test(path)) {
    return NextResponse.json({ message: "Unexpected path" }, { status: 400 });
  }

  revalidatePath(path);
  revalidateTag(`menu:${path.slice(3)}`);

  return NextResponse.json({ revalidated: true, path });
}
