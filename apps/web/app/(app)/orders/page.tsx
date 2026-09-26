"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatMoney } from "@menu/shared";
import { api, downloadFile } from "@/lib/api-client";
import { createFreshness } from "@/lib/freshness";
import { useSession } from "@/components/session";
import { useConfirm } from "@/components/confirm";
import { Button, Empty, Segmented, cx } from "@/components/ui";

type Status = "placed" | "preparing" | "ready" | "completed" | "cancelled";

interface Order {
  id: string;
  status: Status;
  dailyNumber: number;
  placedAt: string;
  table: { id: string; label: string };
  items: {
    id: string;
    nameSnapshot: string;
    variantSnapshot: string | null;
    unitPrice: string;
    quantity: number;
    batch: number;
  }[];
}

const COLUMNS: { status: Status; title: string; next?: Status; nextLabel?: string }[] = [
  { status: "placed", title: "New", next: "preparing", nextLabel: "Start" },
  { status: "preparing", title: "Being made", next: "ready", nextLabel: "Ready" },
  { status: "ready", title: "Ready", next: "completed", nextLabel: "Served" },
];

/**
 * The kitchen board.
 *
 * Polled every five seconds rather than pushed over a socket: a kitchen does
 * not need sub-second latency, and polling survives restaurant wifi dropping
 * out without any reconnection logic to get wrong. Worth revisiting only if a
 * business runs enough tables to make the request volume matter.
 */
export default function OrdersPage() {
  const { current } = useSession();
  const confirm = useConfirm();
  const [orders, setOrders] = useState<Order[]>([]);
  const [past, setPast] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** Which column the phone is showing. Ignored from `sm:` up. */
  const [lane, setLane] = useState<Status>("placed");

  /*
   * The board polls and also moves cards optimistically, which is several
   * ways for an old answer to arrive after a new one. Every read is stamped
   * and every write is announced, so a response the world has moved past is
   * dropped rather than applied — see lib/freshness.ts.
   */
  const fresh = useRef(createFreshness());

  const load = useCallback(async () => {
    if (!current) return;
    const token = fresh.current.begin();
    try {
      // Both scopes: the board shows what is still cooking, and the list
      // below shows what has already gone out. A served order used to vanish
      // from this screen entirely, which is no use to anyone reprinting a
      // bill five minutes later.
      const [open, today] = await Promise.all([
        api.get<Order[]>(`/businesses/${current.id}/orders?scope=open`),
        api.get<Order[]>(`/businesses/${current.id}/orders?scope=today`),
      ]);
      if (!fresh.current.accepts(token)) return;
      setOrders(open);
      setPast(
        today
          .filter((o) => o.status === "completed" || o.status === "cancelled")
          .sort((a, b) => b.dailyNumber - a.dailyNumber),
      );
    } finally {
      setLoading(false);
    }
  }, [current]);

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), 5000);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load]);

  const grouped = useMemo(() => {
    const map = new Map<Status, Order[]>();
    for (const column of COLUMNS) map.set(column.status, []);
    for (const order of orders) map.get(order.status)?.push(order);
    return map;
  }, [orders]);

  if (!current) return null;

  /**
   * Marking an order served also bills it. Two separate taps would leave
   * unbilled completed orders lying around, and the diner's 30-minute
   * download window starts the moment the order closes.
   */
  async function advance(order: Order, status: Status) {
    if (!current) return;

    // Only cancelling asks. Start / Ready / Served are tapped constantly
    // during a service, and a dialog on those would be an obstacle rather
    // than a safeguard.
    if (status === "cancelled") {
      const ok = await confirm({
        title: `Cancel table ${order.table.label}'s order?`,
        body: "The kitchen stops work on it and the diner is told it was cancelled. This cannot be undone.",
        confirmLabel: "Cancel order",
        cancelLabel: "Keep it",
      });
      if (!ok) return;
    }

    setBusy(order.id);

    // From here until the write settles, no polled answer is trusted: a read
    // already in flight describes the order before this tap, and one issued
    // during the write may be answered before it commits. Either would put
    // the card back where it was for a poll interval — which is the flicker
    // staff were seeing on every Start.
    const written = fresh.current.mutating();

    if (status === "completed") {
      await api
        .post(`/businesses/${current.id}/orders/${order.id}/bill`)
        .catch(() => undefined);
    }

    // Optimistic: a member of staff tapping "Ready" should see it move now,
    // not after a round trip through a busy kitchen's wifi.
    setOrders((prev) =>
      status === "completed" || status === "cancelled"
        ? prev.filter((o) => o.id !== order.id)
        : prev.map((o) => (o.id === order.id ? { ...o, status } : o)),
    );

    try {
      await api.patch(`/businesses/${current.id}/orders/${order.id}/status`, { status });
    } catch {
      // Swallowed on purpose: the reload below is what corrects an optimistic
      // move the server refused.
    } finally {
      written();
      setBusy(null);
      // Reconcile now rather than waiting out the poll interval. A served
      // order also has to reach the list below, and another device may have
      // touched the board meanwhile.
      await load();
    }
  }

  return (
    <div className="px-5 py-8 sm:px-6 sm:py-10 lg:px-10 lg:py-12">
      <header className="mb-6 flex items-baseline justify-between gap-4 sm:mb-8">
        <div>
          <h1 className="text-[26px] font-semibold leading-tight tracking-tight sm:text-[30px]">
            Orders
          </h1>
          <p className="mt-1 text-[14.5px] text-muted">
            Updates every few seconds. Leave this open during service.
          </p>
        </div>
        <span className="tnum shrink-0 text-[13px] text-faint">
          {orders.length} open
        </span>
      </header>

      {loading ? (
        <p className="text-[14px] text-faint">Loading…</p>
      ) : orders.length === 0 && past.length === 0 ? (
        <Empty
          title="No orders today"
          body="When someone scans a table card and orders, it appears here straight away."
        />
      ) : orders.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line px-4 py-8 text-center text-[13.5px] text-faint">
          Nothing cooking right now.
        </p>
      ) : (
        <>
          {/*
           * A phone cannot show three columns side by side, and stacking them
           * puts Ready — the one staff reach for most — below everything
           * being made. So on a phone the board becomes one column at a time,
           * chosen from a segmented control that keeps all three counts in
           * view. From `sm:` up the real board returns.
           */}
          <div className="mb-4 sm:hidden">
            <Segmented
              label="Order status"
              value={lane}
              onChange={setLane}
              options={COLUMNS.map((c) => ({
                value: c.status,
                label: c.title,
                badge: (grouped.get(c.status) ?? []).length,
              }))}
            />
          </div>

          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {COLUMNS.map((column) => {
              const list = grouped.get(column.status) ?? [];
              const shown = column.status === lane;
              return (
                <section
                  key={column.status}
                  // The two roles are for the phone's segmented control. From
                  // `sm:` up every column is on screen at once and the tab
                  // relationship stops being true, so it is dropped.
                  role={shown ? "tabpanel" : undefined}
                  id={`segpanel-${column.status}`}
                  aria-labelledby={shown ? `seg-${column.status}` : undefined}
                  className={cx(shown ? "block" : "hidden", "sm:block")}
                >
                  <h2 className="mb-2.5 hidden items-baseline gap-2 text-[13px] font-semibold uppercase tracking-[0.12em] text-faint sm:flex">
                    {column.title}
                    <span className="tnum text-ink">{list.length}</span>
                  </h2>
                  <div className="space-y-3">
                    {list.map((order) => (
                      <OrderCard
                        key={order.id}
                        order={order}
                        now={now}
                        currency={current.currency}
                        busy={busy === order.id}
                        nextLabel={column.nextLabel}
                        onAdvance={() => column.next && void advance(order, column.next)}
                        onCancel={() => void advance(order, "cancelled")}
                        onBill={async (format) => {
                          await api
                            .post(`/businesses/${current.id}/orders/${order.id}/bill`)
                            .catch(() => undefined);
                          await downloadFile(
                            `/businesses/${current.id}/orders/${order.id}/bill/pdf?format=${format}`,
                            `${format}-table-${order.table.label}.pdf`,
                          );
                        }}
                      />
                    ))}
                    {list.length === 0 && (
                      <p className="rounded-2xl border border-dashed border-line px-4 py-6 text-center text-[13px] text-faint">
                        Nothing here
                      </p>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        </>
      )}

      {past.length > 0 && (
        <ServedToday
          orders={past}
          businessId={current.id}
          currency={current.currency}
        />
      )}
    </div>
  );
}

/**
 * What has already gone out today.
 *
 * Kept out of the board on purpose — a served order is not work in progress
 * and would only crowd the columns staff are watching. But it has to be
 * reachable, because reprinting a bill, or answering what table six had, is a
 * normal thing to need a few minutes later.
 */
function ServedToday({
  orders,
  businessId,
  currency,
}: {
  orders: Order[];
  businessId: string;
  currency: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  async function download(order: Order, format: "bill" | "receipt") {
    setBusy(`${order.id}:${format}`);
    try {
      // Generating is idempotent: an order served before billing was set up
      // still needs a document, and one already billed returns the same one.
      await api
        .post(`/businesses/${businessId}/orders/${order.id}/bill`)
        .catch(() => undefined);
      await downloadFile(
        `/businesses/${businessId}/orders/${order.id}/bill/pdf?format=${format}`,
        `${format}-table-${order.table.label}.pdf`,
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mt-10">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-baseline justify-between gap-3 border-t border-line pt-5 text-left"
      >
        <span className="text-[13px] font-semibold uppercase tracking-[0.12em] text-faint">
          Earlier today
          <span className="tnum ml-2 text-ink">{orders.length}</span>
        </span>
        <span className="text-[13px] text-muted">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <ul className="mt-4 space-y-2">
          {orders.map((order) => {
            const total = order.items.reduce(
              (sum, i) => sum + Number(i.unitPrice) * i.quantity,
              0,
            );
            return (
              <li
                key={order.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-line bg-surface px-4 py-3"
              >
                <span className="text-[14px] font-medium">
                  Table {order.table.label}
                </span>
                <span className="tnum text-[13px] text-faint">
                  #{order.dailyNumber}
                </span>
                {order.status === "cancelled" ? (
                  <span className="rounded-full bg-[#FDF3F2] px-2 py-0.5 text-[12px] font-medium text-[#8C1D18]">
                    Cancelled
                  </span>
                ) : (
                  <span className="text-[13px] text-muted">
                    {order.items.reduce((n, i) => n + i.quantity, 0)} items
                  </span>
                )}
                <span className="tnum ml-auto text-[14px] font-semibold">
                  {formatMoney(String(total), currency)}
                </span>
                {order.status === "completed" && (
                  <span className="flex gap-1.5">
                    <Button
                      size="sm"
                      loading={busy === `${order.id}:bill`}
                      onClick={() => void download(order, "bill")}
                    >
                      Bill
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={busy === `${order.id}:receipt`}
                      onClick={() => void download(order, "receipt")}
                    >
                      Receipt
                    </Button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function OrderCard({
  order,
  now,
  currency,
  busy,
  nextLabel,
  onAdvance,
  onCancel,
  onBill,
}: {
  order: Order;
  now: number;
  currency: string;
  busy: boolean;
  nextLabel?: string;
  onAdvance: () => void;
  onCancel: () => void;
  onBill: (format: "bill" | "receipt") => void;
}) {
  const minutes = Math.max(0, Math.floor((now - new Date(order.placedAt).getTime()) / 60000));

  const batches = useMemo(() => {
    const map = new Map<number, Order["items"]>();
    for (const item of order.items) {
      map.set(item.batch, [...(map.get(item.batch) ?? []), item]);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [order.items]);

  const total = order.items.reduce(
    (sum, i) => sum + Number(i.unitPrice) * i.quantity,
    0,
  );

  return (
    <article className="rounded-2xl border border-line bg-surface p-4 shadow-card">
      <header className="flex items-baseline justify-between gap-3">
        <h3 className="font-display text-[16px] font-semibold">
          Table {order.table.label}
        </h3>
        <span className="tnum text-[13px] text-faint">
          #{order.dailyNumber} · {minutes === 0 ? "just now" : `${minutes}m`}
        </span>
      </header>

      {batches.map(([batch, items]) => (
        <div key={batch} className="mt-3">
          {batches.length > 1 && (
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--accent)]">
              Round {batch}
            </p>
          )}
          <ul className="space-y-1">
            {items.map((item) => (
              <li key={item.id} className="flex items-baseline gap-2 text-[14px]">
                <span className="tnum shrink-0 font-semibold">{item.quantity}×</span>
                <span className="min-w-0 flex-1">
                  {item.nameSnapshot}
                  {item.variantSnapshot && (
                    <span className="text-muted"> · {item.variantSnapshot}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}

      <footer className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        <span className="tnum text-[14px] font-semibold">
          {formatMoney(String(total), currency)}
        </span>
        <span className="flex flex-1 justify-end gap-1.5">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onBill("bill")} disabled={busy}>
            Bill
          </Button>
          {nextLabel && (
            <Button variant="primary" size="sm" onClick={onAdvance} loading={busy}>
              {nextLabel}
            </Button>
          )}
        </span>
      </footer>
    </article>
  );
}
