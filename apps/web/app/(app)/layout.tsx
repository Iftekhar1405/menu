"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { SessionProvider, useSession } from "@/components/session";
import { logout } from "@/lib/api-client";
import { Button, cx, Sheet, SheetGrabber } from "@/components/ui";
import { Wordmark } from "@/components/brand";
import { ConfirmProvider, useConfirm } from "@/components/confirm";
import { NotificationsProvider } from "@/components/notifications/provider";
import { NotificationBell } from "@/components/notifications/bell";
import { NotificationToasts } from "@/components/notifications/toasts";

/**
 * The first four are what an owner touches during a service; the rest are
 * things you set up once and rarely return to. That split is what decides
 * which sections get a tab on a phone and which live behind More — not the
 * order they happen to appear in on a desktop sidebar, which is the same
 * list either way.
 */
const NAV = [
  { href: "/dashboard",   label: "Overview",       icon: OverviewIcon },
  { href: "/orders",      label: "Orders",          icon: OrdersIcon },
  { href: "/menu",        label: "Menu",            icon: MenuIcon },
  { href: "/tables",      label: "Tables",          icon: TablesIcon },
  { href: "/billing",     label: "Billing",         icon: BillingIcon },
  { href: "/appearance",  label: "Appearance",      icon: AppearanceIcon },
  { href: "/qr",          label: "QR code",         icon: QrIcon },
  { href: "/merch",       label: "Printed cards",   icon: CardsIcon },
  { href: "/settings",    label: "Settings",        icon: SettingsIcon },
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
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 rounded-full border-2 border-line border-t-[var(--accent)] animate-spin" />
          <p className="text-[13px] text-faint">Loading…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center px-6">
        <div className="text-center animate-float-up">
          <div className="mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5M12 16h.01" strokeLinecap="round" />
            </svg>
          </div>
          <p className="text-[16px] font-semibold text-ink">{error}</p>
          <p className="mt-1.5 text-[13.5px] text-muted">
            Your work is safe. Check the connection and try again.
          </p>
          <Button variant="primary" className="mt-5" onClick={retry}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <NotificationsProvider key={current?.id ?? "none"} businessId={current?.id ?? null}>
      <div className="min-w-0 lg:grid lg:min-h-[100dvh] lg:grid-cols-[240px_minmax(0,1fr)]">

        {/* ── Mobile header ──────────────────────────────────────────────── */}
        <header className="chrome-blur pt-safe px-edge sticky top-0 z-30 flex h-14 items-center justify-between gap-3 lg:hidden">
          <Link href="/dashboard" className="flex items-center">
            <Wordmark size={18} markClassName="text-[#B45309]" />
          </Link>
          <div className="flex min-w-0 items-center gap-1.5">
            {current && (
              <span className="min-w-0 truncate text-[13px] text-muted">{current.name}</span>
            )}
            <NotificationBell className="-mr-1.5" />
          </div>
        </header>

        {/* ── Desktop sidebar ────────────────────────────────────────────── */}
        <aside className="sidebar-surface hidden min-w-0 lg:flex lg:flex-col">
          <div className="flex h-full min-w-0 flex-col px-4 py-5">

            {/* Logo + bell */}
            <div className="mb-6 flex items-center justify-between gap-2 px-2">
              <Link href="/dashboard" className="block">
                <Wordmark size={19} markClassName="text-[#B45309]" />
              </Link>
              <NotificationBell />
            </div>

            {/* Business switcher */}
            {businesses.length > 1 && (
              <select
                aria-label="Choose a business"
                value={current?.id ?? ""}
                onChange={(e) => setCurrentId(e.target.value)}
                className="spring mb-4 h-10 w-full min-w-0 rounded-xl border border-line bg-raised px-2.5 text-[13px] text-ink"
              >
                {businesses.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            )}

            {/* Nav */}
            <nav aria-label="Sections" className="flex min-w-0 flex-col gap-0.5">
              {items.map((item) => {
                const active = pathname === item.href;
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cx(
                      "spring group flex h-10 shrink-0 items-center gap-3 whitespace-nowrap rounded-xl px-3 text-[13.5px] font-medium",
                      active
                        ? "nav-active-pip bg-[var(--accent-soft)] text-[var(--accent-strong)]"
                        : "text-muted hover:bg-[rgba(var(--accent-rgb),0.06)] hover:text-ink",
                    )}
                  >
                    <span className={cx(
                      "spring shrink-0",
                      active ? "text-[var(--accent)]" : "text-faint group-hover:text-muted",
                    )}>
                      <Icon />
                    </span>
                    {item.label}
                  </Link>
                );
              })}
            </nav>

            {/* Bottom area */}
            <div className="mt-auto min-w-0 pt-6">
              {/* Business name + sign out */}
              <div className="px-2">
                <p className="truncate text-[13px] font-medium text-ink">
                  {current?.name}
                </p>
                <button
                  onClick={() => void signOut()}
                  className="spring mt-0.5 text-[12.5px] text-faint hover:text-[var(--accent)]"
                >
                  Sign out
                </button>
              </div>
            </div>
          </div>
        </aside>

        {/* ── Page content ──────────────────────────────────────────────── */}
        <main className="pb-tabs min-w-0 lg:pb-0">{children}</main>

        {/* ── Mobile tab bar ─────────────────────────────────────────────── */}
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
                ? "text-[var(--accent)]"
                : "text-faint",
            )}
          >
            <MoreIcon />
            <span className="text-[10.5px] font-medium leading-none">More</span>
          </button>
        </nav>

        {/* ── More sheet ─────────────────────────────────────────────────── */}
        {moreOpen && (
          <Sheet label="More sections" onClose={() => setMoreOpen(false)}>
            <SheetGrabber />
            <header className="flex items-center justify-between px-5 py-3.5">
              <h2 className="font-display text-[17px] font-semibold">More</h2>
              <button
                onClick={() => setMoreOpen(false)}
                className="spring h-11 px-2 text-[14px] text-muted hover:text-ink"
              >
                Done
              </button>
            </header>

            <div className="scroll-quiet overscroll-contain-y flex-1 overflow-y-auto px-5 pb-5 space-y-4">
              {businesses.length > 1 && (
                <label className="block">
                  <span className="mb-1.5 block text-[13px] font-medium text-ink">Business</span>
                  <select
                    aria-label="Choose a business"
                    value={current?.id ?? ""}
                    onChange={(e) => setCurrentId(e.target.value)}
                    className="h-11 w-full min-w-0 rounded-xl border border-line bg-raised px-3 text-[16px]"
                  >
                    {businesses.map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
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
                        <span className={cx(active ? "text-[var(--accent)]" : "text-faint")}>
                          <Icon />
                        </span>
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>

              <button
                onClick={() => { setMoreOpen(false); void signOut(); }}
                className="spring w-full h-12 rounded-2xl border border-line bg-surface text-[15px] text-muted hover:text-[var(--accent)] hover:border-[var(--accent-soft)]"
              >
                Sign out
              </button>
            </div>
          </Sheet>
        )}

        <NotificationToasts />
      </div>
    </NotificationsProvider>
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
        active ? "text-[var(--accent)]" : "text-faint",
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
 * Line drawings at a single weight, sized to the tab bar.
 */

function icon(path: React.ReactNode) {
  return (
    <svg
      width="20"
      height="20"
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

function AppearanceIcon() {
  return icon(
    <>
      <path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.6 0 2.7-.8 2.7-1.9 0-.9-.7-1.6-.7-2.5 0-1.1.9-2 2-2h1.8A2.7 2.7 0 0 0 20.5 11 7.5 7.5 0 0 0 12 3.5Z" />
      <circle cx="7.8" cy="11" r="1" fill="currentColor" stroke="none" />
      <circle cx="10.5" cy="7.8" r="1" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="8.2" r="1" fill="currentColor" stroke="none" />
      <circle cx="7.8" cy="15" r="1" fill="currentColor" stroke="none" />
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

