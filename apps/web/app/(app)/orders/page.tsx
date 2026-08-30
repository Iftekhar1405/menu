"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatMoney } from "@menu/shared";
import { api, downloadFile } from "@/lib/api-client";
import { useSession } from "@/components/session";
import { Button, Empty, cx } from "@/components/ui";

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
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    if (!current) return;
    try {
      const data = await api.get<Order[]>(`/businesses/${current.id}/orders?scope=open`);
      setOrders(data);
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
    setBusy(order.id);

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
      await load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="px-6 py-10 lg:px-10 lg:py-12">
      <header className="mb-8 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-[30px] font-semibold leading-tight tracking-tight">Orders</h1>
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
      ) : orders.length === 0 ? (
        <Empty
          title="No open orders"
          body="When someone scans a table card and orders, it appears here straight away."
        />
      ) : (
        <div className="grid gap-5 lg:grid-cols-3">
          {COLUMNS.map((column) => {
            const list = grouped.get(column.status) ?? [];
            return (
              <section key={column.status}>
                <h2 className="mb-2.5 flex items-baseline gap-2 text-[13px] font-semibold uppercase tracking-[0.12em] text-faint">
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
                      onBill={async () => {
                        await api
                          .post(`/businesses/${current.id}/orders/${order.id}/bill`)
                          .catch(() => undefined);
                        await downloadFile(
                          `/businesses/${current.id}/orders/${order.id}/bill/pdf`,
                          `bill-table-${order.table.label}.pdf`,
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
      )}
    </div>
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
  onBill: () => void;
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

      <footer className="mt-4 flex items-center justify-between gap-2 border-t border-line pt-3">
        <span className="tnum text-[14px] font-semibold">
          {formatMoney(String(total), currency)}
        </span>
        <span className="flex gap-1.5">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="ghost" size="sm" onClick={onBill} disabled={busy}>
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
