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
import { columnsFor, nextActionFor, showsMoney, statusLabel } from "@/lib/board-actions";
import type { Order, OrderRound } from "@/lib/types";

type Status = OrderStatus;

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
   * `me` is still null for a beat while the session loads, and `current`
   * (gating the fetch and the early return below) resolves from the same
   * request — so by the time there is anything on screen to gate, `me` is
   * normally already set. Defaulting the gap to "owner" is the safe choice
   * because this is cosmetic, not the access boundary: the API independently
   * refuses any write the real role cannot make and never sends a kitchen
   * caller a price, so a button or total that briefly over-shows during
   * load corrects itself and never under-shows a genuine owner. It also
   * matches what the nav sidebar already assumes while loading (lib/nav.ts).
   * `platform_admin` has no distinct board permissions of its own, so it
   * falls into the same "owner" bucket.
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
    for (const column of columns) map.set(column.status, []);
    for (const order of orders) map.get(order.status)?.push(order);
    return map;
  }, [orders, columns]);

  if (!current) return null;

  /**
   * Closes the table.
   *
   * The order-level endpoint has stopped being a step in the lifecycle —
   * accepting, starting and plating all happen to a round now, because a
   * table that adds a chai at nine has not un-cooked its biryani. What is
   * left to the whole order is the whole-table act: finish everything still
   * live on it, or cancel the lot. The API does exactly that, moving every
   * live round, so a single round left behind can no longer hold the table
   * open through the derivation.
   *
   * Marking an order served also bills it. Two separate taps would leave
   * unbilled completed orders lying around, and the diner's 30-minute
   * download window starts the moment the order closes.
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

    // Optimistic: a member of staff tapping "Served" should see the table
    // clear now, not after a round trip through a busy kitchen's wifi.
    setOrders((prev) => prev.filter((o) => o.id !== order.id));

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

  /**
   * Moves one round along, leaving its siblings where they are.
   *
   * The order's own status is not sent: the database derives it from every
   * round. The browser computes the same answer with the same function, which
   * is what lets the card jump to its new column on the tap rather than a
   * poll interval later.
   */
  async function advanceRound(order: Order, round: OrderRound, status: Status) {
    if (!current) return;

    setBusy(busyKey(order.id, round.id));
    const written = fresh.current.mutating();

    const rounds = order.rounds.map((r) =>
      r.id === round.id ? { ...r, status } : r,
    );
    const derived = deriveOrderStatus(rounds.map((r) => r.status));

    // Serving the last live round closes the table, and a closed table owes a
    // bill — same reasoning as closeOrder, which is the other way to get here.
    if (derived === "completed") {
      await api
        .post(`/businesses/${current.id}/orders/${order.id}/bill`)
        .catch(() => undefined);
    }

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
    } catch {
      // Swallowed on purpose, as above: a move the server refused — a
      // transition it will not make, or a role it will not make it for — is
      // corrected by the reload rather than by a second opinion here.
    } finally {
      written();
      setBusy(null);
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
           * A phone cannot show four columns side by side, and stacking them
           * puts Ready — the one staff reach for most — below everything
           * being made. So on a phone the board becomes one column at a time,
           * chosen from a segmented control that keeps all four counts in
           * view. From `sm:` up the real board returns.
           */}
          <div className="mb-4 sm:hidden">
            <Segmented
              label="Order status"
              value={lane}
              onChange={setLane}
              options={columns.map((c) => ({
                value: c.status,
                // Shortened labels for the phone segmented control — four
                // options at full width clips at 360px.
                label: c.status === "placed" ? "New"
                  : c.status === "accepted" ? "Taken"
                  : c.status === "preparing" ? "Making"
                  : "Ready",
                badge: (grouped.get(c.status) ?? []).length,
              }))}
            />
          </div>

          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {columns.map((column) => {
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
                        busy={busy}
                        businessId={current.id}
                        role={role}
                        showMoney={showsMoney(role)}
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
 * reachable, because reprinting a bill, or answering what table six had, is a
 * normal thing to need a few minutes later.
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

function OrderCard({
  order,
  now,
  currency,
  busy,
  businessId,
  role,
  showMoney,
  onAdvanceRound,
  onClose,
  onCancel,
  onBill,
}: {
  order: Order;
  now: number;
  currency: string;
  /** Whatever this board is mid-write on — see busyKey. */
  busy: string | null;
  businessId: string;
  role: AccessRole;
  showMoney: boolean;
  onAdvanceRound: (round: OrderRound, status: Status) => void;
  onClose: () => void;
  onCancel: () => void;
  onBill: (format: "bill" | "receipt") => void;
}) {
  const [openTimeline, setOpenTimeline] = useState(false);
  const [events, setEvents] = useState<OrderEvent[] | null>(null);

  // Fetched on expand rather than embedded in the board's response: this
  // screen polls two scopes every five seconds, and carrying six rows per
  // order in both — forever, for a panel that is usually shut — is a poor
  // trade. Refetched when the order advances so an open panel stays true.
  useEffect(() => {
    if (!openTimeline) return;
    let live = true;
    void api
      .get<OrderEvent[]>(`/businesses/${businessId}/orders/${order.id}/events`)
      .then((rows) => live && setEvents(rows))
      // Left null on failure: a timeline that will not load is worth less
      // than the card it is attached to, and the card still works.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [openTimeline, businessId, order.id, order.status]);

  const minutes = Math.max(0, Math.floor((now - new Date(order.placedAt).getTime()) / 60000));

  // Anything this card has in flight — a round of its own, or the whole
  // table. Enough to lock the card's other buttons while it settles.
  const working = busy !== null && busy.startsWith(order.id);

  /*
   * A single-round order is the common case and gets the card it always had:
   * no round heading, no chip, one button in the footer. "Round 1" stamped on
   * every card during a quiet service is noise, and the chip would only
   * repeat the column the card is sitting in.
   *
   * Its one button is still a round action — the round is what moves, and the
   * order's status follows by derivation — so it is the same action the
   * multi-round cards show, just placed where staff already reach for it.
   */
  const solo = order.rounds.length === 1 ? order.rounds[0]! : null;
  const soloAction = solo ? nextActionFor(role, solo.status) : null;

  const total = order.items.reduce(
    (sum, i) => sum + Number(i.unitPrice ?? 0) * i.quantity,
    0,
  );

  return (
    <article
      className={cx(
        "rounded-2xl border bg-surface p-4 shadow-card",
        // Running orders get an accent ring so they visually pop to the top
        // of their column without requiring the owner to read every label.
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
                // Staff know what comes next — the button says so. What they
                // are reading for is how long each stage actually took.
                showUpcoming: false,
              })}
              tone="staff"
              showGaps
            />
          )}
        </div>
      )}

      {order.rounds.map((round) => {
        const action = solo ? null : nextActionFor(role, round.status);
        return (
          <section
            key={round.id}
            // A labelled section is a landmark, which is how a screen reader
            // reaches one round's items without reading the whole card. Only
            // worth being a landmark when there is more than one of them.
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
                <span className={chipClass(round.status)}>{statusLabel(round.status)}</span>
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

      <footer className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        {showMoney && (
          <span className="tnum text-[14px] font-semibold">
            {formatMoney(String(total), currency)}
          </span>
        )}
        <span className="flex flex-1 justify-end gap-1.5">
          {canRoleSetStatus(role, order.status, "cancelled") && (
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={working}>
              Cancel
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => onBill("bill")} disabled={working}>
            Bill
          </Button>
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
          {/*
           * Settling a table is a whole-order act: the API finishes every
           * round still live on it, so a forgotten round cannot hold the
           * table open and bring it back onto the board. Only shown where it
           * says something the round buttons do not — on one round it would
           * be a second button doing the same thing.
           */}
          {!solo && canRoleSetStatus(role, order.status, "completed") && (
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
    </article>
  );
}
