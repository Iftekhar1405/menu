"use client";

import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "@menu/shared";
import { ApiError, api, downloadFile } from "@/lib/api-client";
import { useSession } from "@/components/session";
import { Banner, Button, Empty, Input, Textarea, cx } from "@/components/ui";

type Status =
  | "requested"
  | "quoted"
  | "confirmed"
  | "in_production"
  | "shipped"
  | "delivered"
  | "cancelled";

interface AdminOrder {
  id: string;
  orderNumber: number;
  status: Status;
  contactName: string;
  contactPhone: string;
  contactEmail: string | null;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  notes: string | null;
  adminNotes: string | null;
  estimatedTotal: string;
  quotedTotal: string | null;
  createdAt: string;
  business: { id: string; name: string; publicCode: string };
  items: {
    id: string;
    quantity: number;
    unitPrice: string;
    tableIds: string[];
    product: { name: string; sku: string; perTable: boolean };
  }[];
}

/** What each status can move to. Mirrors the API, which is authoritative. */
const NEXT: Record<Status, Status[]> = {
  requested: ["quoted", "cancelled"],
  quoted: ["confirmed", "cancelled"],
  confirmed: ["in_production", "cancelled"],
  in_production: ["shipped", "cancelled"],
  shipped: ["delivered", "cancelled"],
  delivered: [],
  cancelled: [],
};

const LABEL: Record<Status, string> = {
  requested: "Requested",
  quoted: "Quoted",
  confirmed: "Confirmed",
  in_production: "In production",
  shipped: "Shipped",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

const FILTERS: (Status | "all")[] = [
  "all",
  "requested",
  "quoted",
  "confirmed",
  "in_production",
  "shipped",
];

/**
 * Ours. The only screen in the product that reads across businesses.
 *
 * The API refuses it to anyone without the platform_admin role, so this page
 * showing an error rather than data is the correct outcome for an owner who
 * finds the URL.
 */
export default function AdminPage() {
  const { me } = useSession();
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [filter, setFilter] = useState<Status | "all">("all");
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const query = filter === "all" ? "" : `?status=${filter}`;
      setOrders(await api.get<AdminOrder[]>(`/admin/merch/orders${query}`));
      setDenied(false);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        setDenied(true);
      }
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  if (denied || (me && me.role !== "platform_admin")) {
    return (
      <div className="mx-auto max-w-lg px-6 py-20 text-center">
        <h1 className="font-display text-[20px] font-semibold">Not found</h1>
        <p className="mt-2 text-[14.5px] leading-relaxed text-muted">
          There&apos;s nothing here for this account.
        </p>
      </div>
    );
  }

  async function update(order: AdminOrder, patch: Record<string, unknown>) {
    setBusy(order.id);
    try {
      const updated = await api.patch<AdminOrder>(`/admin/merch/orders/${order.id}`, patch);
      setOrders((prev) => prev.map((o) => (o.id === order.id ? updated : o)));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-10 lg:px-10 lg:py-12">
      <header className="mb-8">
        <h1 className="text-[30px] font-semibold leading-tight tracking-tight">
          Card orders
        </h1>
        <p className="mt-1 text-[14.5px] text-muted">
          Every printed-card request across the platform.
        </p>
      </header>

      <div className="mb-6 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            aria-pressed={filter === f}
            className={cx(
              "spring h-9 rounded-full px-3.5 text-[13px] font-medium",
              filter === f
                ? "bg-[var(--accent)] text-white"
                : "bg-surface text-muted hover:bg-raised",
            )}
          >
            {f === "all" ? "All" : LABEL[f]}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-[14px] text-faint">Loading…</p>
      ) : orders.length === 0 ? (
        <Empty
          title="Nothing here"
          body={
            filter === "all"
              ? "No card requests yet."
              : `No requests are ${LABEL[filter as Status].toLowerCase()}.`
          }
        />
      ) : (
        <ul className="space-y-4">
          {orders.map((order) => (
            <AdminOrderCard
              key={order.id}
              order={order}
              busy={busy === order.id}
              onUpdate={(patch) => void update(order, patch)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function AdminOrderCard({
  order,
  busy,
  onUpdate,
}: {
  order: AdminOrder;
  busy: boolean;
  onUpdate: (patch: Record<string, unknown>) => void;
}) {
  const [notes, setNotes] = useState(order.adminNotes ?? "");
  const [quote, setQuote] = useState(order.quotedTotal ?? "");
  const [downloading, setDownloading] = useState(false);

  const tableCount = order.items.reduce((sum, i) => sum + i.tableIds.length, 0);

  return (
    <li className="rounded-2xl border border-line bg-surface p-5 shadow-card">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="font-display text-[17px] font-semibold">
            {order.business.name}
          </h2>
          <p className="tnum mt-0.5 text-[12.5px] text-faint">
            #{order.orderNumber} ·{" "}
            {new Date(order.createdAt).toLocaleDateString("en-IN", {
              day: "numeric",
              month: "short",
            })}
          </p>
        </div>
        <span className="rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-[12px] font-medium text-[var(--accent-strong)]">
          {LABEL[order.status]}
        </span>
      </header>

      <div className="mt-4 grid gap-5 sm:grid-cols-2">
        <div>
          <h3 className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.1em] text-faint">
            Order
          </h3>
          <ul className="space-y-1 text-[13.5px]">
            {order.items.map((item) => (
              <li key={item.id}>
                <span className="tnum font-medium">{item.quantity}×</span>{" "}
                {item.product.name}
                <span className="tnum text-muted">
                  {" "}
                  @ {formatMoney(item.unitPrice, "INR")}
                </span>
              </li>
            ))}
          </ul>
          <p className="tnum mt-2 text-[13.5px]">
            <span className="text-muted">Estimate</span>{" "}
            <span className="font-medium">
              {formatMoney(order.estimatedTotal, "INR")}
            </span>
          </p>
          {order.notes && (
            <p className="mt-2 rounded-lg bg-raised px-2.5 py-2 text-[13px] leading-relaxed text-muted">
              “{order.notes}”
            </p>
          )}
        </div>

        <div>
          <h3 className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.1em] text-faint">
            Ship to
          </h3>
          <address className="text-[13.5px] not-italic leading-relaxed text-muted">
            <span className="text-ink">{order.contactName}</span>
            <br />
            <span className="tnum">{order.contactPhone}</span>
            {order.contactEmail && (
              <>
                <br />
                {order.contactEmail}
              </>
            )}
            <br />
            {order.addressLine1}
            {order.addressLine2 && (
              <>
                <br />
                {order.addressLine2}
              </>
            )}
            <br />
            {order.city}, {order.state} <span className="tnum">{order.postalCode}</span>
          </address>
        </div>
      </div>

      <div className="mt-5 space-y-3 border-t border-line pt-4">
        <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-ink">
              Quoted total
            </span>
            <Input
              value={String(quote)}
              onChange={(e) => setQuote(e.target.value.replace(/[^\d.]/g, ""))}
              onBlur={() =>
                onUpdate({ quotedTotal: quote === "" ? null : Number(quote) })
              }
              inputMode="decimal"
              placeholder="—"
              className="tnum h-10"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-ink">
              Internal notes
            </span>
            <Textarea
              rows={1}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={() => onUpdate({ adminNotes: notes || null })}
              placeholder="Never shown to the business."
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {tableCount > 0 && (
            <Button
              size="sm"
              loading={downloading}
              onClick={async () => {
                setDownloading(true);
                try {
                  await downloadFile(
                    `/admin/merch/orders/${order.id}/artwork`,
                    `merch-${order.orderNumber}-artwork.pdf`,
                  );
                } finally {
                  setDownloading(false);
                }
              }}
            >
              Print artwork · {tableCount} card{tableCount === 1 ? "" : "s"}
            </Button>
          )}

          {NEXT[order.status].map((next) => (
            <Button
              key={next}
              size="sm"
              variant={next === "cancelled" ? "ghost" : "primary"}
              disabled={busy}
              onClick={() => onUpdate({ status: next })}
            >
              {next === "cancelled" ? "Cancel" : `Mark ${LABEL[next].toLowerCase()}`}
            </Button>
          ))}
        </div>
      </div>
    </li>
  );
}
