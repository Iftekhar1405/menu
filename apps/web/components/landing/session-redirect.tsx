"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { restoreSession } from "@/lib/api-client";

/**
 * Someone who is already signed in has no use for the pitch: send them to
 * their dashboard.
 *
 * This can only be decided in the browser. The session is an httpOnly
 * refresh cookie traded for an in-memory token, and there is no middleware,
 * so the server renders the landing page for everyone and this corrects it
 * a moment later. The access token it obtains stays in memory, so the
 * dashboard does not have to trade the cookie again.
 *
 * Any failure — not signed in, API down — leaves the visitor on the page.
 */
export function SessionRedirect() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    restoreSession()
      .then((ok) => {
        if (ok && !cancelled) router.replace("/dashboard");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [router]);

  return null;
}
