"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { SessionProvider, useSession } from "@/components/session";
import { logout } from "@/lib/api-client";
import { Button, cx, Sheet, SheetGrabber } from "@/components/ui";
import { Wordmark } from "@/components/brand";
import { ConfirmProvider, useConfirm } from "@/components/confirm";

/**
 * The first four are what an owner touches during a service; the rest are
 * things you set up once and rarely return to. That split is what decides
 * which sections get a tab on a phone and which live behind More — not the
 * order they happen to appear in on a desktop sidebar, which is the same
 * list either way.
 */
const NAV = [
  { href: "/dashboard", label: "Overview", icon: OverviewIcon },
  { href: "/orders", label: "Orders", icon: OrdersIcon },
  { href: "/menu", label: "Menu", icon: MenuIcon },
  { href: "/tables", label: "Tables", icon: TablesIcon },
  { href: "/billing", label: "Billing", icon: BillingIcon },
  { href: "/templates", label: "Design", icon: DesignIcon },
  { href: "/qr", label: "QR code", icon: QrIcon },
  { href: "/merch", label: "Printed cards", icon: CardsIcon },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
];

/** How many of those get their own tab. The rest go behind More. */
const TABS = 4;

/** Ours. Hidden from owners, and refused by the API even if they find it. */
const ADMIN_NAV = [{ href: "/admin", label: "Card orders", icon: CardsIcon }];

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
  const { current, businesses, setCurrentId, loading, error, retry, me } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const confirm = useConfirm();
  const [moreOpen, setMoreOpen] = useState(false);

  const items = [...NAV, ...(me?.role === "platform_admin" ? ADMIN_NAV : [])];
  const tabs = items.slice(0, TABS);
  const rest = items.slice(TABS);

  async function signOut() {
    const ok = await confirm({
      title: "Sign out?",
      body: "You'll need your 6-digit PIN to get back in.",
      confirmLabel: "Sign out",
      tone: "normal",
    });
    if (!ok) return;
    await logout();
    router.replace("/login");
  }

  if (loading) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center">
        <p className="text-[14px] text-faint">Loading…</p>
      </div>
    );
  }

  /* A dead end otherwise: the shell has no business to render and nothing
     on screen would say so or offer a way forward. */
  if (error) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center px-6">
        <div className="text-center">
          <p className="text-[15px] text-ink">{error}</p>
          <p className="mt-1 text-[13.5px] text-muted">
            Your work is safe. Check the connection and try again.
          </p>
          <Button variant="primary" className="mt-5" onClick={retry}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  /*
   * One <nav aria-label="Sections"> for both layouts, because it is one
   * navigation — which shape it takes is a property of the screen, not of the
   * information. The sidebar's markup is hidden below `lg`, the tab bar's
   * above it, so exactly one is ever in the accessibility tree.
   */
  return (
    <div className="min-w-0 lg:grid lg:min-h-[100dvh] lg:grid-cols-[232px_minmax(0,1fr)]">
      {/* Phone: a slim bar that says where you are and whose menu you are
          editing, and nothing else. Everything actionable is at the bottom,
          in reach of a thumb. */}
      <header className="chrome-blur pt-safe px-edge sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-line lg:hidden">
        <Link href="/dashboard" className="flex h-14 items-center">
          <Wordmark size={18} />
        </Link>
        {current && (
          <span className="min-w-0 truncate text-[13px] text-muted">{current.name}</span>
        )}
      </header>

      <aside className="hidden min-w-0 border-line bg-surface lg:block lg:border-r">
        <div className="flex h-full min-w-0 flex-col p-5">
          <div className="mb-6">
            <Link href="/dashboard" className="block px-2">
              <Wordmark size={19} />
            </Link>
          </div>

          {/* Only shown when it is a real choice. A single-restaurant owner
              should not have to look at a switcher with one option in it. */}
          {businesses.length > 1 && (
            <select
              aria-label="Choose a business"
              value={current?.id ?? ""}
              onChange={(e) => setCurrentId(e.target.value)}
              className="mb-4 h-10 w-full min-w-0 rounded-xl border border-line bg-raised px-2.5 text-[13.5px]"
            >
              {businesses.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}

          <nav aria-label="Sections" className="flex min-w-0 flex-col gap-1">
            {items.map((item) => {
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cx(
                    "spring flex h-10 shrink-0 items-center whitespace-nowrap rounded-xl px-3 text-[14px]",
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

          <div className="mt-auto hidden min-w-0 pt-6 lg:block">
            <p className="truncate px-3 text-[13px] font-medium text-ink">
              {current?.name}
            </p>
            <button
              onClick={() => void signOut()}
              className="mt-1 px-3 text-[13px] text-faint hover:text-ink"
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>

      {/* pb-tabs keeps the last row of every page clear of the tab bar. It is
          zero from `lg` up, where there is no bar. */}
      <main className="pb-tabs min-w-0 lg:pb-0">{children}</main>

      <nav
        aria-label="Sections"
        data-testid="tab-bar"
        className="chrome-blur pb-safe px-safe fixed inset-x-0 bottom-0 z-30 flex border-t border-line lg:hidden"
      >
        {tabs.map((item) => (
          <Tab key={item.href} item={item} active={pathname === item.href} />
        ))}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          className={cx(
            "spring flex min-w-0 flex-1 flex-col items-center justify-center gap-1 py-2",
            rest.some((i) => i.href === pathname)
              ? "text-[var(--accent-strong)]"
              : "text-faint",
          )}
        >
          <MoreIcon />
          <span className="text-[10.5px] font-medium leading-none">More</span>
        </button>
      </nav>

      {moreOpen && (
        <Sheet label="More sections" onClose={() => setMoreOpen(false)}>
          <SheetGrabber />
          <header className="flex items-center justify-between px-5 py-3.5">
            <h2 className="font-display text-[17px] font-semibold">More</h2>
            <button
              onClick={() => setMoreOpen(false)}
              className="h-11 px-2 text-[14px] text-muted hover:text-ink"
            >
              Done
            </button>
          </header>

          <div className="scroll-quiet overscroll-contain-y flex-1 overflow-y-auto px-5 pb-5">
            {businesses.length > 1 && (
              <label className="mb-4 block">
                <span className="mb-1.5 block text-[13px] font-medium text-ink">
                  Business
                </span>
                <select
                  aria-label="Choose a business"
                  value={current?.id ?? ""}
                  onChange={(e) => setCurrentId(e.target.value)}
                  className="h-11 w-full min-w-0 rounded-xl border border-line bg-raised px-3 text-[16px]"
                >
                  {businesses.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <ul className="overflow-hidden rounded-2xl border border-line">
              {rest.map((item, i) => {
                const active = pathname === item.href;
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={() => setMoreOpen(false)}
                      aria-current={active ? "page" : undefined}
                      className={cx(
                        "spring flex h-[52px] items-center gap-3 px-4 text-[15px]",
                        i > 0 && "border-t border-line",
                        active
                          ? "bg-[var(--accent-soft)] font-medium text-[var(--accent-strong)]"
                          : "bg-surface text-ink",
                      )}
                    >
                      <Icon />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>

            <button
              onClick={() => {
                setMoreOpen(false);
                void signOut();
              }}
              className="mt-4 h-12 w-full rounded-2xl border border-line bg-surface text-[15px] text-muted hover:text-ink"
            >
              Sign out
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

function Tab({
  item,
  active,
}: {
  item: { href: string; label: string; icon: () => React.ReactElement };
  active: boolean;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cx(
        "spring flex min-w-0 flex-1 flex-col items-center justify-center gap-1 py-2",
        active ? "text-[var(--accent-strong)]" : "text-faint",
      )}
    >
      <Icon />
      <span className="w-full truncate px-1 text-center text-[10.5px] font-medium leading-none">
        {item.label}
      </span>
    </Link>
  );
}

/* ── Icons ─────────────────────────────────────────────────────────────────
 * Line drawings at a single weight, sized to the tab bar. They exist because
 * five text labels at a readable size do not fit across a phone; the label
 * stays underneath, so the icon never has to carry the meaning alone.
 */

function icon(path: React.ReactNode) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {path}
    </svg>
  );
}

function OverviewIcon() {
  return icon(
    <>
      <rect x="3" y="3" width="7" height="8" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="11" width="7" height="10" rx="1.5" />
    </>,
  );
}

function OrdersIcon() {
  return icon(
    <>
      <path d="M4 7h16l-1.2 12.1a2 2 0 0 1-2 1.9H7.2a2 2 0 0 1-2-1.9Z" />
      <path d="M8.5 7V5.5a3.5 3.5 0 0 1 7 0V7" />
    </>,
  );
}

function MenuIcon() {
  return icon(
    <>
      <path d="M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </>,
  );
}

function TablesIcon() {
  return icon(
    <>
      <circle cx="12" cy="9" r="5" />
      <path d="M12 14v7M8 21h8" />
    </>,
  );
}

function BillingIcon() {
  return icon(
    <>
      <path d="M6 3h12v18l-3-1.8L12 21l-3-1.8L6 21Z" />
      <path d="M9.5 8h5M9.5 12h5" />
    </>,
  );
}

function DesignIcon() {
  return icon(
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3v5.8M12 15.2V21M3 12h5.8M15.2 12H21" />
    </>,
  );
}

function QrIcon() {
  return icon(
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <path d="M14 14h3v3h-3zM20 20h1M14 20h1M20 14h1" />
    </>,
  );
}

function CardsIcon() {
  return icon(
    <>
      <rect x="2.5" y="6" width="19" height="13" rx="2.5" />
      <path d="M2.5 10.5h19M6.5 15h4" />
    </>,
  );
}

function SettingsIcon() {
  return icon(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2 5.5 5.5" />
    </>,
  );
}

function MoreIcon() {
  return icon(
    <>
      <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>,
  );
}
