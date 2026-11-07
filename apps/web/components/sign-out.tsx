"use client";

import { useRouter } from "next/navigation";
import { useConfirm } from "@/components/confirm";
import { logout } from "@/lib/api-client";

/** Asks first, then ends the session and lands on the login screen. */
export function useSignOut(): () => Promise<void> {
  const router = useRouter();
  const confirm = useConfirm();

  return async function signOut() {
    const ok = await confirm({
      title: "Sign out?",
      body: "You'll need your 6-digit PIN to get back in.",
      confirmLabel: "Sign out",
      tone: "normal",
    });
    if (!ok) return;
    await logout();
    router.replace("/login");
  };
}
