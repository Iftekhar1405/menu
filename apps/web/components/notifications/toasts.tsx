"use client";

import { useRouter } from "next/navigation";
import { cx } from "@/components/ui";
import type { FeedItem } from "@/lib/notifications/feed";
import { useNotifications } from "./provider";

/**
 * Orders arriving, on screen.
 *
 * These do not auto-dismiss. Every other toast in a product should — but an
 * order that scrolled away unread is an order nobody cooked, and a timer is
 * a worse judge of "has someone seen this" than a person tapping it. They
 * clear when the order is opened, when everything is marked read, or when
 * they are dismissed one at a time.
 *
 * Below the header on a phone and bottom-right on a desktop, because on a
 * phone the thumb is at the bottom and a toast there covers the tab bar.
 */
export function NotificationToasts() {
  const { toasts } = useNotifications();

  if (toasts.length === 0) return null;

  return (
    <div
      // Not a live region: the OS notification and the chime already
      // announce this, and a screen reader reading all three is worse than
      // any of them alone.
      className={cx(
        "pointer-events-none fixed z-50 flex flex-col gap-2",
        "left-0 right-0 top-[calc(3.5rem+env(safe-area-inset-top,0px))] px-edge",
        "lg:bottom-6 lg:left-auto lg:right-6 lg:top-auto lg:w-[360px] lg:flex-col-reverse lg:px-0",
      )}
    >
      {toasts.map((toast) => (
        <Toast key={toast.id} item={toast} />
      ))}
    </div>
  );
}

function Toast({ item }: { item: FeedItem }) {
  const { dismissToast, markRead } = useNotifications();
  const router = useRouter();

  function open() {
    markRead([item.id]);
    dismissToast(item.id);
    router.push("/orders");
  }

  return (
    <div className="animate-toast-in pointer-events-auto flex items-start gap-3 rounded-2xl border border-line bg-surface px-4 py-3.5 shadow-lift">
      <span
        aria-hidden="true"
        className="tnum mt-0.5 grid h-8 min-w-8 shrink-0 place-items-center rounded-lg bg-[var(--accent-soft)] px-1.5 text-[13px] font-medium text-[var(--accent-strong)]"
      >
        {chipLabel(item)}
      </span>

      <button type="button" onClick={open} className="min-w-0 flex-1 text-left">
        <span className="block truncate text-[14px] font-medium text-ink">{item.title}</span>
        <span className="mt-0.5 block truncate text-[13px] text-muted">{item.body}</span>
      </button>

      <button
        type="button"
        onClick={() => dismissToast(item.id)}
        aria-label={`Dismiss ${item.title}`}
        className="spring -mr-1 -mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-faint hover:bg-[rgba(17,17,19,0.04)] hover:text-ink"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="m6 6 12 12M18 6 6 18"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}

function chipLabel(item: FeedItem): string {
  const label = item.data.tableLabel?.trim() ?? "";
  return label.length > 0 && label.length <= 4 ? label : "#";
}
