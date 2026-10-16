"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  canRoleSetStatus,
  deriveOrderStatus,
  formatMoney,
  type AccessRole,
  type OrderStatus,
} from "@menu/shared";
import { api, downloadFile } from "@/lib/api-client";
import { createFreshness } from "@/lib/freshness";
import { useSession } from "@/components/session";
import { useConfirm } from "@/components/confirm";
import { Button, Empty, Segmented, cx } from "@/components/ui";
import { buildTimeline, type OrderEvent } from "@/lib/order-timeline";
import { OrderTimeline } from "@/components/order/timeline";
import {
  columnFor,
  columnsFor,
  nextActionFor,
  showsMoney,
  statusLabel,
} from "@/lib/board-actions";
import type { Order, OrderRound } from "@/lib/types";

type Status = OrderStatus;

/** One board row = one order (one table). Cells hold that order's rounds per column. */
type BoardRow = {
  order: Order;
  cells: Map<Status, OrderRound[]>;
  /** The leftmost column this order has a card in. Whole-table actions live there only. */
  primary: Status;
};

/**
 * The key identifying what is mid-write: an order on its own for a whole
 * -table action, an order and a round for a single round's. Prefixed with the
 * order id either way, so a card can tell at a glance that something of its
 * own is in flight.
 */
function busyKey(orderId: string, roundId?: string): string {
  return roundId ? `${orderId}:${roundId}` : orderId;
}

/**
 * A round's status chip.
 *
 * Tinted only where the tint earns its keep: a plated round so the pass can
 * see what is waiting to go out, and a cancelled one so nobody cooks it. The
 * rest are quiet, because on a card with three rounds the items are what
 * staff are reading.
 */
function chipClass(status: Status): string {
  const base =
    "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-[0.02em]";
  if (status === "cancelled") return `${base} bg-[#FDF3F2] text-[#8C1D18]`;
  if (status === "ready") return `${base} bg-[var(--accent-soft)] text-[var(--accent-strong)]`;
  return `${base} bg-[var(--raised)] text-muted`;
}

/**
 * The kitchen board.
 *
 * Polled every five seconds rather than pushed over a socket: a kitchen does
 * not need sub-second latency, and polling survives restaurant wifi dropping
 * out without any reconnection logic to get wrong. Worth revisiting only if a
 * business runs enough tables to make the request volume matter.
 *
 * Layout: one ROW per order (table), one COLUMN per status. Each round sits in
 * the column of its OWN status, so a table's rounds can be in different
 * columns at once, and advancing one round moves only that round's card.
 * Rounds of the same order that share a status are merged into one card.
 * Rows are ordered by when the order was placed (newest on top) and never by
 * activity, so a new round or a status change does not reshuffle the board.
 */
export default function OrdersPage() {
  const { current, me } = useSession();
  const confirm = useConfirm();
  const [orders, setOrders] = useState<Order[]>([]);
  const [past, setPast] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** Which column the phone is showing. Ignored from `sm:` up. */
  const [lane, setLane] = useState<Status>("placed");

  /*
   * `me` is still null for a beat while the session loads. Defaulting the gap
   * to "owner" is cosmetic, not the access boundary: the API independently
   * refuses any write the real role cannot make and never sends a kitchen
   * caller a price. `platform_admin` falls into the same "owner" bucket.
   */
  const role: AccessRole = me?.role === "kitchen" ? "kitchen" : "owner";
  const columns = useMemo(() => columnsFor(role), [role]);

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
      // below shows what has already gone out.
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

  /*
   * Rows: newest order first, ordered by placedAt only (never updatedAt) so a
   * round arriving or moving never moves the row.
   *
   * Each ROUND is placed by columnFor(role, [round.status]) — the same rule
   * the board always used, now applied per round instead of to the whole
   * order. Null means "this board has no column for it": for the kitchen
   * that is a round nobody has accepted yet, which is deliberately not
   * theirs to see (this is what stops an unaccepted round 2 leaking onto the
   * kitchen board next to an accepted round 1).
   */
  const rows = useMemo<BoardRow[]>(() => {
    const sorted = [...orders].sort(
      (a, b) =>
        new Date(b.placedAt).getTime() - new Date(a.placedAt).getTime() ||
        b.dailyNumber - a.dailyNumber,
    );
    const out: BoardRow[] = [];
    for (const order of sorted) {
      const cells = new Map<Status, OrderRound[]>();
      const bySeq = [...order.rounds].sort((a, b) => a.seq - b.seq);
      for (const round of bySeq) {
        const col = columnFor(role, [round.status]);
        if (col === null) continue;
        const list = cells.get(col);
        if (list) list.push(round);
        else cells.set(col, [round]);
      }
      if (cells.size === 0) continue;
      const primary = columns.find((c) => cells.has(c.status))?.status;
      if (!primary) continue;
      out.push({ order, cells, primary });
    }
    return out;
  }, [orders, columns, role]);

  const counts = useMemo(() => {
    const map = new Map<Status, number>();
    for (const c of columns) map.set(c.status, 0);
    for (const row of rows) {
      for (const status of row.cells.keys()) {
        map.set(status, (map.get(status) ?? 0) + 1);
      }
    }
    return map;
  }, [rows, columns]);

  if (!current) return null;

  /**
   * Bills a table that the write before it has just closed.
   *
   * Strictly after that write, and only if it succeeded. A bill posted first
   * is a silent money bug in both directions: if the status write then fails
   * the table stays open with a bill frozen against it, and `generate_bill`
   * hands that same bill back unchanged forever.
   *
   * Posted after, the worst case is a closed table whose bill has not been
   * generated yet, and generating is idempotent. That is why a failure here
   * is swallowed rather than surfaced.
   */
  async function billIfClosed(order: Order, status: Status) {
    if (!current || status !== "completed") return;
    await api
      .post(`/businesses/${current.id}/orders/${order.id}/bill`)
      .catch(() => undefined);
  }

  /**
   * Closes the table: finish everything still live on it, or cancel the lot.
   * The API moves every live round, so a round left behind can no longer hold
   * the table open through the derivation.
   *
   * Marking an order served also bills it — after the write that closes it,
   * never before; see billIfClosed.
   */
  async function closeOrder(order: Order, status: "completed" | "cancelled") {
    if (!current) return;

    // Only cancelling asks. Serving is tapped constantly during a service,
    // and a dialog on it would be an obstacle rather than a safeguard.
    if (status === "cancelled") {
      const ok = await confirm({
        title: `Cancel table ${order.table.label}'s order?`,
        body: "The kitchen stops work on it and the diner is told it was cancelled. This cannot be undone.",
        confirmLabel: "Cancel order",
        cancelLabel: "Keep it",
      });
      if (!ok) return;
    }

    setBusy(busyKey(order.id));

    // From here until the write settles, no polled answer is trusted — see
    // lib/freshness.ts.
    const written = fresh.current.mutating();

    // Optimistic: "Served" should clear the table now, not after a round trip.
    setOrders((prev) => prev.filter((o) => o.id !== order.id));

    try {
      await api.patch(`/businesses/${current.id}/orders/${order.id}/status`, { status });
      await billIfClosed(order, status);
    } catch {
      // Swallowed on purpose: the reload below corrects an optimistic move
      // the server refused.
    } finally {
      written();
      setBusy(null);
      await load();
    }
  }

  /**
   * Moves one round along, leaving its siblings where they are.
   *
   * The order's own status is not sent: the database derives it from every
   * round. The browser computes the same answer with the same function, so
   * only THIS round's card jumps column on the tap; the other rounds' cards
   * stay exactly where they are.
   */
  async function advanceRound(order: Order, round: OrderRound, status: Status) {
    if (!current) return;

    setBusy(busyKey(order.id, round.id));
    const written = fresh.current.mutating();

    const rounds = order.rounds.map((r) =>
      r.id === round.id ? { ...r, status } : r,
    );
    const derived = deriveOrderStatus(rounds.map((r) => r.status));

    setOrders((prev) =>
      derived === "completed" || derived === "cancelled"
        ? prev.filter((o) => o.id !== order.id)
        : prev.map((o) => (o.id === order.id ? { ...o, rounds, status: derived } : o)),
    );

    try {
      await api.patch(
        `/businesses/${current.id}/orders/${order.id}/rounds/${round.id}/status`,
        { status },
      );
      // Serving the last live round closes the table, so this is the same
      // billing moment closeOrder has — strictly after the write.
      await billIfClosed(order, derived);
    } catch {
      // Swallowed on purpose: a refused move is corrected by the reload.
    } finally {
      written();
      setBusy(null);
      await load();
    }
  }

  const gridCols =
    "sm:grid sm:[grid-template-columns:repeat(var(--cols),minmax(0,1fr))] sm:gap-4 lg:gap-5";

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
      ) : rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line px-4 py-8 text-center text-[13.5px] text-faint">
          Nothing cooking right now.
        </p>
      ) : (
        <>
          {/* Phone: one column at a time, chosen from a segmented control. */}
          <div className="mb-4 sm:hidden">
            <Segmented
              label="Order status"
              value={lane}
              onChange={setLane}
              options={columns.map((c) => ({
                value: c.status,
                label:
                  c.status === "placed" ? "New"
                  : c.status === "accepted" ? "Taken"
                  : c.status === "preparing" ? "Making"
                  : "Ready",
                badge: counts.get(c.status) ?? 0,
              }))}
            />
          </div>

          <div style={{ "--cols": columns.length } as React.CSSProperties}>
            {/* Column headings, once, above all rows. */}
            <div className={cx("mb-2.5 hidden", gridCols)}>
              {columns.map((column) => (
                <h2
                  key={column.status}
                  className="flex items-baseline gap-2 text-[13px] font-semibold uppercase tracking-[0.12em] text-faint"
                >
                  {column.title}
                  <span className="tnum text-ink">{counts.get(column.status) ?? 0}</span>
                </h2>
              ))}
            </div>

            <div className="space-y-3 sm:space-y-4">
              {rows.map(({ order, cells, primary }) => (
                <div
                  key={order.id}
                  // Phone: only rows with something in the active lane.
                  className={cx(gridCols, cells.has(lane) ? "grid" : "hidden sm:grid")}
                >
                  {columns.map((column) => {
                    const rounds = cells.get(column.status);
                    if (!rounds) {
                      return <div key={column.status} className="hidden sm:block" />;
                    }
                    return (
                      <div
                        key={column.status}
                        className={column.status === lane ? "block" : "hidden sm:block"}
                      >
                        <OrderCard
                          order={order}
                          rounds={rounds}
                          now={now}
                          currency={current.currency}
                          busy={busy}
                          businessId={current.id}
                          role={role}
                          showMoney={showsMoney(role)}
                          primary={column.status === primary}
                          onAdvanceRound={(round, status) =>
                            void advanceRound(order, round, status)
                          }
                          onClose={() => void closeOrder(order, "completed")}
                          onCancel={() => void closeOrder(order, "cancelled")}
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
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {past.length > 0 && (
        <ServedToday
          orders={past}
          businessId={current.id}
          currency={current.currency}
          showMoney={showsMoney(role)}
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
 * reachable, because reprinting a bill is a normal thing to need later.
 */
function ServedToday({
  orders,
  businessId,
  currency,
  showMoney,
}: {
  orders: Order[];
  businessId: string;
  currency: string;
  showMoney: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  async function download(order: Order, format: "bill" | "receipt") {
    setBusy(`${order.id}:${format}`);
    try {
      // Generating is idempotent.
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
              (sum, i) => sum + Number(i.unitPrice ?? 0) * i.quantity,
              0,
            );
            return (
              <ServedOrderRow
                key={order.id}
                order={order}
                total={total}
                currency={currency}
                businessId={businessId}
                busy={busy}
                showMoney={showMoney}
                onDownload={download}
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ServedOrderRow({
  order,
  total,
  currency,
  businessId,
  busy,
  showMoney,
  onDownload,
}: {
  order: Order;
  total: number;
  currency: string;
  businessId: string;
  busy: string | null;
  showMoney: boolean;
  onDownload: (order: Order, format: "bill" | "receipt") => void;
}) {
  const [openTimeline, setOpenTimeline] = useState(false);
  const [events, setEvents] = useState<OrderEvent[] | null>(null);

  useEffect(() => {
    if (!openTimeline) return;
    let live = true;
    void api
      .get<OrderEvent[]>(`/businesses/${businessId}/orders/${order.id}/events`)
      .then((rows) => live && setEvents(rows))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [openTimeline, businessId, order.id]);

  return (
    <li className="rounded-2xl border border-line bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="button"
          onClick={() => setOpenTimeline((o) => !o)}
          aria-expanded={openTimeline}
          className="flex min-w-0 flex-1 items-center gap-4 text-left"
        >
          <span className="text-[14px] font-medium">Table {order.table.label}</span>
          <span className="tnum text-[13px] text-faint">#{order.dailyNumber}</span>
          {order.status === "cancelled" ? (
            <span className="rounded-full bg-[#FDF3F2] px-2 py-0.5 text-[12px] font-medium text-[#8C1D18]">
              Cancelled
            </span>
          ) : (
            <span className="text-[13px] text-muted">
              {order.items.reduce((n, i) => n + i.quantity, 0)} items
            </span>
          )}
          <span className="ml-auto text-[13px] text-muted">{openTimeline ? "▴" : "▾"}</span>
        </button>
        {showMoney && (
          <span className="tnum text-[14px] font-semibold">
            {formatMoney(String(total), currency)}
          </span>
        )}
        {order.status === "completed" && (
          <span className="flex gap-1.5">
            <Button
              size="sm"
              loading={busy === `${order.id}:bill`}
              onClick={() => onDownload(order, "bill")}
            >
              Bill
            </Button>
            <Button
              size="sm"
              variant="ghost"
              loading={busy === `${order.id}:receipt`}
              onClick={() => onDownload(order, "receipt")}
            >
              Receipt
            </Button>
          </span>
        )}
      </div>

      {openTimeline && (
        <div className="mt-3 border-t border-line pt-3">
          {events === null ? (
            <p className="text-[12.5px] text-faint">Loading…</p>
          ) : (
            <OrderTimeline
              steps={buildTimeline(events, {
                status: order.status,
                showUpcoming: false,
              })}
              tone="staff"
              showGaps
            />
          )}
        </div>
      )}
    </li>
  );
}

/**
 * One card = one order's rounds that currently share a column.
 *
 * `rounds` is only the subset sitting in this card's column; the rest of the
 * order's rounds are drawn as their own cards in their own columns. Rounds
 * that collide in a status are merged here, in seq order.
 *
 * Whole-table acts (Cancel, Serve all, Bill) live on the order's `primary`
 * card only — the leftmost one — so they are not repeated on every card.
 */
function OrderCard({
  order,
  rounds,
  now,
  currency,
  busy,
  businessId,
  role,
  showMoney,
  primary,
  onAdvanceRound,
  onClose,
  onCancel,
  onBill,
}: {
  order: Order;
  rounds: OrderRound[];
  now: number;
  currency: string;
  /** Whatever this board is mid-write on — see busyKey. */
  busy: string | null;
  businessId: string;
  role: AccessRole;
  showMoney: boolean;
  primary: boolean;
  onAdvanceRound: (round: OrderRound, status: Status) => void;
  onClose: () => void;
  onCancel: () => void;
  onBill: (format: "bill" | "receipt") => void;
}) {
  const [openTimeline, setOpenTimeline] = useState(false);
  const [events, setEvents] = useState<OrderEvent[] | null>(null);

  // Fetched on expand rather than embedded in the board's response: this
  // screen polls two scopes every five seconds.
  useEffect(() => {
    if (!openTimeline) return;
    let live = true;
    void api
      .get<OrderEvent[]>(`/businesses/${businessId}/orders/${order.id}/events`)
      .then((rows) => live && setEvents(rows))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [openTimeline, businessId, order.id, order.status]);

  const minutes = Math.max(0, Math.floor((now - new Date(order.placedAt).getTime()) / 60000));

  // Anything this order has in flight — enough to lock its buttons while it settles.
  const working = busy !== null && busy.startsWith(order.id);

  /*
   * A single-round ORDER keeps the card it always had: no round heading, no
   * chip, one button in the footer. Once an order has more than one round,
   * every card shows its round numbers — even when it holds just one — so a
   * lone "Round 2" card is labelled as such.
   */
  const solo = order.rounds.length === 1 ? order.rounds[0]! : null;
  const soloAction = solo ? nextActionFor(role, solo.status) : null;

  const total = rounds
    .flatMap((r) => r.items)
    .reduce((sum, i) => sum + Number(i.unitPrice ?? 0) * i.quantity, 0);

  return (
    <article
      className={cx(
        "rounded-2xl border bg-surface p-4 shadow-card",
        order.isRunning ? "border-[color:var(--accent)] ring-1 ring-[color:var(--accent)]" : "border-line",
      )}
    >
      <header className="flex items-baseline justify-between gap-3">
        <button
          type="button"
          onClick={() => setOpenTimeline((o) => !o)}
          aria-expanded={openTimeline}
          className="flex min-w-0 flex-1 items-baseline justify-between gap-3 text-left"
        >
          <span className="flex min-w-0 items-baseline gap-2">
            <h3 className="font-display text-[16px] font-semibold">
              Table {order.table.label}
            </h3>
            {order.isRunning && (
              <span className="shrink-0 rounded-full bg-[color:var(--accent)] px-2 py-0.5 text-[11px] font-semibold text-white">
                Running order
              </span>
            )}
          </span>
          <span className="tnum shrink-0 text-[13px] text-faint">
            #{order.dailyNumber} · {minutes === 0 ? "just now" : `${minutes}m`}
            <span aria-hidden className="ml-1.5">{openTimeline ? "▴" : "▾"}</span>
          </span>
        </button>
      </header>

      {openTimeline && (
        <div className="mt-3 border-t border-line pt-3">
          {events === null ? (
            <p className="text-[12.5px] text-faint">Loading…</p>
          ) : (
            <OrderTimeline
              steps={buildTimeline(events, {
                status: order.status,
                showUpcoming: false,
              })}
              tone="staff"
              showGaps
            />
          )}
        </div>
      )}

      {rounds.map((round) => {
        const action = solo ? null : nextActionFor(role, round.status);
        return (
          <section
            key={round.id}
            aria-label={solo ? undefined : `Round ${round.seq}`}
            className="mt-3"
          >
            {!solo && (
              <div className="mb-1.5 flex items-baseline justify-between gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--accent)]">
                  Round {round.seq}
                  <span className="tnum ml-1.5 font-medium normal-case tracking-normal text-faint">
                    KOT #{round.kotNumber}
                  </span>
                </p>
                <span data-testid={`round-${round.seq}-status`} className={chipClass(round.status)}>
                  {statusLabel(round.status)}
                </span>
              </div>
            )}
            <ul className="space-y-1">
              {round.items.map((item) => (
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
            {action && (
              <div className="mt-2 flex justify-end">
                <Button
                  variant="primary"
                  size="sm"
                  loading={busy === busyKey(order.id, round.id)}
                  disabled={working}
                  onClick={() => onAdvanceRound(round, action.status)}
                >
                  {action.label}
                </Button>
              </div>
            )}
          </section>
        );
      })}

      {(showMoney || primary || (solo && soloAction)) && (
        <footer className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          {showMoney && (
            <span className="tnum text-[14px] font-semibold">
              {formatMoney(String(total), currency)}
            </span>
          )}
          <span className="flex flex-1 justify-end gap-1.5">
            {primary && canRoleSetStatus(role, order.status, "cancelled") && (
              <Button variant="ghost" size="sm" onClick={onCancel} disabled={working}>
                Cancel
              </Button>
            )}
            {primary && (
              <Button variant="ghost" size="sm" onClick={() => onBill("bill")} disabled={working}>
                Bill
              </Button>
            )}
            {solo && soloAction && (
              <Button
                variant="primary"
                size="sm"
                loading={busy === busyKey(order.id, solo.id)}
                disabled={working}
                onClick={() => onAdvanceRound(solo, soloAction.status)}
              >
                {soloAction.label}
              </Button>
            )}
            {/* Whole-table act: only where it says more than the round buttons. */}
            {primary && !solo && canRoleSetStatus(role, order.status, "completed") && (
              <Button
                variant="primary"
                size="sm"
                loading={busy === busyKey(order.id)}
                disabled={working}
                onClick={onClose}
              >
                Serve all
              </Button>
            )}
          </span>
        </footer>
      )}
    </article>
  );
}