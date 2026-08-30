import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { TABLE_COOKIE } from "@/lib/table-session";

/** Lets a diner drop their table binding — "I'm at a different table now". */
export async function POST() {
  const jar = await cookies();
  jar.delete(TABLE_COOKIE);
  return NextResponse.json({ ok: true });
}
