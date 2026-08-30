"use client";

import { useEffect } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Counts one view per page load, fired after render so it never delays the
 * menu appearing. Deliberately a counter, not analytics — the dashboard needs
 * "is anyone scanning this", and nothing about the diner is recorded.
 */
export function ViewBeacon({ code }: { code: string }) {
  useEffect(() => {
    const url = `${API}/public/menus/${code}/view`;
    // keepalive so the count survives the diner immediately switching apps.
    void fetch(url, { method: "POST", keepalive: true }).catch(() => undefined);
  }, [code]);

  return null;
}
