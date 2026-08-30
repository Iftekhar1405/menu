"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { SessionProvider, useSession } from "@/components/session";
import { logout } from "@/lib/api-client";
import { cx } from "@/components/ui";
import { Wordmark } from "@/components/brand";
import { ConfirmProvider, useConfirm } from "@/components/confirm";

const NAV = [
  { href: "/dashboard", label: "Overview" },
  { href: "/orders", label: "Orders" },
  { href: "/menu", label: "Menu" },
  { href: "/tables", label: "Tables" },
  { href: "/billing", label: "Billing" },
  { href: "/templates", label: "Design" },
  { href: "/qr", label: "QR code" },
  { href: "/merch", label: "Printed cards" },
  { href: "/settings", label: "Settings" },
];

/** Ours. Hidden from owners, and refused by the API even if they find it. */
const ADMIN_NAV = [{ href: "/admin", label: "Card orders" }];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <ConfirmProvider>
        <Shell>{children}</Shell>
      </ConfirmProvider>
    </SessionProvider>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { current, businesses, setCurrentId, loading, me } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const confirm = useConfirm();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-[14px] text-faint">Loading…</p>
      </div>
    );
  }

  return (
    <div className="grid min-h-screen grid-rows-[auto_1fr] lg:grid-cols-[232px_1fr] lg:grid-rows-1">
      <aside className="border-b border-line bg-surface lg:border-b-0 lg:border-r">
        <div className="flex h-full flex-col p-4 lg:p-5">
          <Link href="/dashboard" className="mb-6 block px-2">
            <Wordmark size={19} />
          </Link>

          {/* Only shown when it is a real choice. A single-restaurant owner
              should not have to look at a switcher with one option in it. */}
          {businesses.length > 1 && (
            <select
              aria-label="Choose a business"
              value={current?.id ?? ""}
              onChange={(e) => setCurrentId(e.target.value)}
              className="mb-4 h-10 w-full rounded-xl border border-line bg-raised px-2.5 text-[13.5px]"
            >
              {businesses.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}

          <nav className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
            {[...NAV, ...(me?.role === "platform_admin" ? ADMIN_NAV : [])].map((item) => {
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cx(
                    "spring flex h-10 shrink-0 items-center rounded-xl px-3 text-[14px]",
                    active
                      ? "bg-[var(--accent-soft)] font-medium text-[var(--accent-strong)]"
                      : "text-muted hover:bg-[rgba(17,17,19,0.04)] hover:text-ink",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="mt-auto hidden pt-6 lg:block">
            <p className="truncate px-3 text-[13px] font-medium text-ink">
              {current?.name}
            </p>
            <button
              onClick={async () => {
                const ok = await confirm({
                  title: "Sign out?",
                  body: "You'll need your 6-digit PIN to get back in.",
                  confirmLabel: "Sign out",
                  tone: "normal",
                });
                if (!ok) return;
                await logout();
                router.replace("/login");
              }}
              className="mt-1 px-3 text-[13px] text-faint hover:text-ink"
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>

      <main className="min-w-0">{children}</main>
    </div>
  );
}
