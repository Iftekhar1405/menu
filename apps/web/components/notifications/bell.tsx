"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Sheet, SheetGrabber, cx } from "@/components/ui";
import { relativeTime } from "@/lib/notifications/relative-time";
import { needsHomeScreenInstall } from "@/lib/notifications/permission";
import type { FeedItem } from "@/lib/notifications/feed";
import { useNotifications } from "./provider";

/**
 * The bell, and the panel behind it.
 *
 * The product chrome here is achromatic by design — the only colour in the
 * interface belongs to the restaurant's own accent — so an unread state is
 * marked by a single accent dot rather than a coloured pill or a filled
 * badge. The count itself is on the row, where it is read, not on the icon,
 * where it would compete with the nav.
 */
export function NotificationBell({ className }: { className?: string }) {
  const { feed } = useNotifications();
  const [open, setOpen] = useState(false);

  const unread = feed.unread;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        className={cx(
          "spring relative grid h-9 w-9 shrink-0 place-items-center rounded-xl text-muted",
          "hover:bg-[rgba(17,17,19,0.04)] hover:text-ink",
          className,
        )}
      >
        <BellIcon />
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-[var(--accent)] ring-2 ring-[var(--surface)]"
          />
        )}
      </button>

      {open && <NotificationPanel onClose={() => setOpen(false)} />}
    </>
  );
}

function NotificationPanel({ onClose }: { onClose: () => void }) {
  const {
    feed,
    connected,
    muted,
    setMuted,
    offerAlerts,
    enableAlerts,
    dismissAlertsOffer,
    alertsEnabled,
    markRead,
    markAllRead,
  } = useNotifications();
  const router = useRouter();

  // Re-render on a slow tick so "4 min" does not sit at "Just now" while the
  // panel is open. A minute is the resolution the labels have.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  function openOrder(item: FeedItem) {
    markRead([item.id]);
    onClose();
    router.push("/orders");
  }

  return (
    <Sheet label="Notifications" side="side" onClose={onClose} className="sm:h-full sm:max-h-full sm:rounded-none max-h-[92dvh] rounded-t-[20px] sm:max-w-[460px]">
      <SheetGrabber />
      <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
        <h2 className="text-[15px] font-medium">Notifications</h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setMuted(!muted)}
            aria-pressed={muted}
            aria-label={muted ? "Turn the order sound on" : "Turn the order sound off"}
            className="spring grid h-9 w-9 place-items-center rounded-xl text-muted hover:bg-[rgba(17,17,19,0.04)] hover:text-ink"
          >
            {muted ? <MutedIcon /> : <SoundIcon />}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="spring h-9 rounded-xl px-3 text-[13.5px] text-muted hover:bg-[rgba(17,17,19,0.04)] hover:text-ink"
          >
            Done
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {offerAlerts && (
          <EnableAlertsCard onEnable={() => void enableAlerts()} onDismiss={dismissAlertsOffer} />
        )}
        {!offerAlerts && !alertsEnabled && needsHomeScreenInstall() && <HomeScreenHint />}

        {feed.items.length === 0 ? (
          <p className="px-5 py-10 text-center text-[13.5px] text-faint">
            No orders yet. New ones appear here the moment a table sends them.
          </p>
        ) : (
          <ul>
            {feed.items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => openOrder(item)}
                  className="spring flex w-full items-start gap-3 border-b border-line px-5 py-3.5 text-left hover:bg-[var(--raised)]"
                >
                  <TableChip label={tableLabelOf(item)} />

                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span
                        className={cx(
                          "truncate text-[14px]",
                          item.readAt === null ? "font-medium text-ink" : "text-muted",
                        )}
                      >
                        {item.title}
                      </span>
                      <span className="tnum shrink-0 text-[12px] text-faint">
                        {relativeTime(item.createdAt)}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-[13px] text-muted">
                      {item.body}
                    </span>
                  </span>

                  {item.readAt === null && (
                    <span
                      aria-hidden="true"
                      className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]"
                    />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="flex items-center justify-between gap-3 border-t border-line px-5 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]">
        {/* Only ever shown when it is true. A permanent "Live" badge would
            be decoration; this is the one state worth reporting, because it
            is the one where an order can arrive up to 25s late. */}
        <span className="text-[12.5px] text-faint">
          {connected ? "" : "Reconnecting — orders may take a moment"}
        </span>
        <button
          type="button"
          onClick={markAllRead}
          disabled={feed.unread === 0}
          className="spring shrink-0 text-[13px] text-muted hover:text-ink disabled:opacity-40 disabled:hover:text-muted"
        >
          Mark all read
        </button>
      </footer>
    </Sheet>
  );
}

/**
 * The signature of this feature, and the reason it is a square with tabular
 * digits rather than an icon: the thing staff are looking for across the
 * room is the numbered card printed for that table. The notification echoes
 * the object, so the jump from screen to floor needs no translation.
 */
function TableChip({ label }: { label: string }) {
  return (
    <span
      aria-hidden="true"
      className="tnum mt-0.5 grid h-8 min-w-8 shrink-0 place-items-center rounded-lg border border-line bg-[var(--raised)] px-1.5 text-[13px] font-medium text-muted"
    >
      {label}
    </span>
  );
}

/**
 * The chip shows the table's own label, which arrives as data rather than
 * being recovered from the title — a regex over display copy breaks the
 * moment the wording changes, and silently.
 *
 * Long labels like "Screen 2 Row F" cannot fit a chip. The title alongside
 * still says it in full.
 */
function tableLabelOf(item: FeedItem): string {
  const label = item.data.tableLabel?.trim() ?? "";
  return label.length > 0 && label.length <= 4 ? label : "#";
}

function EnableAlertsCard({
  onEnable,
  onDismiss,
}: {
  onEnable: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="border-b border-line bg-[var(--accent-soft)] px-5 py-4">
      <p className="text-[14px] font-medium text-[var(--accent-strong)]">
        Get alerted when an order arrives
      </p>
      <p className="mt-1 text-[13px] text-[var(--accent-strong)] opacity-80">
        Your device will sound and show the order even when this tab is in the
        background or closed.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={onEnable}
          className="spring h-9 rounded-xl bg-[var(--accent)] px-3.5 text-[13.5px] font-medium text-white hover:bg-[var(--accent-strong)] active:scale-[0.985]"
        >
          Turn on alerts
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="spring h-9 rounded-xl px-3 text-[13.5px] text-[var(--accent-strong)] hover:bg-[rgba(17,17,19,0.05)]"
        >
          Not now
        </button>
      </div>
    </div>
  );
}

/**
 * iPhones deliver Web Push only to a site added to the Home Screen, and
 * report that by not exposing the API at all. Saying so beats a feature
 * that silently is not there.
 */
function HomeScreenHint() {
  return (
    <p className="border-b border-line px-5 py-3.5 text-[13px] text-muted">
      To get alerts on this iPhone, add the dashboard to your Home Screen from
      the Share menu, then open it from there.
    </p>
  );
}

function BellIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M18 8.5a6 6 0 1 0-12 0c0 4.5-1.5 6-1.5 6h15S18 13 18 8.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M10.3 18.5a2 2 0 0 0 3.4 0"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SoundIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 9.5h3l4-3v11l-4-3H5a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M16 9.2a4 4 0 0 1 0 5.6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MutedIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 9.5h3l4-3v11l-4-3H5a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="m16 9.5 4 5m0-5-4 5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
