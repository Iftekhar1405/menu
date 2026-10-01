"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatMoney } from "@menu/shared";
import { ApiError, api } from "@/lib/api-client";
import { useSession } from "@/components/session";
import { Banner, Button, Empty, Field, Input, Textarea, cx } from "@/components/ui";

interface Product {
  id: string;
  sku: string;
  name: string;
  blurb: string;
  unitPrice: string;
  minQuantity: number;
  leadTimeDays: number;
  perTable: boolean;
}

interface TableRow {
  id: string;
  label: string;
  isActive: boolean;
}

interface MerchOrder {
  id: string;
  orderNumber: number;
  status: string;
  estimatedTotal: string;
  quotedTotal: string | null;
  createdAt: string;
  items: {
    id: string;
    quantity: number;
    unitPrice: string;
    tableIds: string[];
    product: { name: string; perTable: boolean };
  }[];
}

const STATUS_COPY: Record<string, string> = {
  requested: "Request received",
  quoted: "Quoted — check your email",
  confirmed: "Confirmed",
  in_production: "Being printed",
  shipped: "Shipped",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

export default function MerchPage() {
  const { current } = useSession();
  const [products, setProducts] = useState<Product[]>([]);
  const [tables, setTables] = useState<TableRow[]>([]);
  const [orders, setOrders] = useState<MerchOrder[]>([]);

  const [productId, setProductId] = useState<string | null>(null);
  const [selectedTables, setSelectedTables] = useState<string[]>([]);
  const [quantity, setQuantity] = useState("1");
  const [form, setForm] = useState({
    contactName: "",
    contactPhone: "",
    contactEmail: "",
    addressLine1: "",
    addressLine2: "",
    city: "",
    state: "",
    postalCode: "",
    notes: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const load = useCallback(async () => {
    if (!current) return;
    const [p, t, o] = await Promise.all([
      api.get<Product[]>("/merch/products"),
      api.get<TableRow[]>(`/businesses/${current.id}/tables`),
      api.get<MerchOrder[]>(`/businesses/${current.id}/merch-orders`),
    ]);
    setProducts(p);
    setTables(t);
    setOrders(o);
    setProductId((prev) => prev ?? p[0]?.id ?? null);
    setForm((prev) => ({
      ...prev,
      addressLine1: prev.addressLine1 || current.addressLine1 || "",
      city: prev.city || current.city || "",
      state: prev.state || current.state || "",
      postalCode: prev.postalCode || current.postalCode || "",
    }));
  }, [current]);

  useEffect(() => {
    void load();
  }, [load]);

  const product = useMemo(
    () => products.find((p) => p.id === productId) ?? null,
    [products, productId],
  );

  if (!current) return null;

  // For a per-table product the count IS the number of tables chosen. Letting
  // the two disagree produces an order we cannot print.
  const count = product?.perTable ? selectedTables.length : Number(quantity) || 0;
  const estimate = product ? Number(product.unitPrice) * count : 0;
  const belowMinimum = product ? count < product.minQuantity : true;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!current || !product) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/businesses/${current.id}/merch-orders`, {
        ...form,
        contactEmail: form.contactEmail || null,
        addressLine2: form.addressLine2 || null,
        notes: form.notes || null,
        country: current.country || "IN",
        items: [
          {
            productId: product.id,
            quantity: product.perTable ? 0 : count,
            tableIds: product.perTable ? selectedTables : [],
          },
        ],
      });
      setSent(true);
      setSelectedTables([]);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send that request.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-5 py-8 sm:px-6 sm:py-10 lg:px-10 lg:py-12">
      <header className="mb-8">
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight sm:text-[30px]">
          Printed QR cards
        </h1>
        <p className="mt-1 text-[14.5px] leading-relaxed text-muted">
          We print and post them. Tell us what you need and we&apos;ll come back with a
          price — nothing is charged here.
        </p>
      </header>

      {sent && (
        <div className="mb-6">
          <Banner tone="info">
            Request sent. We&apos;ll be in touch with a quote — usually within a working
            day.
          </Banner>
        </div>
      )}

      {orders.length > 0 && (
        <section className="mb-9">
          <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.12em] text-faint">
            Your requests
          </h2>
          <ul className="overflow-hidden rounded-2xl border border-line bg-surface">
            {orders.map((order) => (
              <li
                key={order.id}
                className="flex flex-wrap items-baseline justify-between gap-3 border-t border-line px-4 py-3 first:border-t-0"
              >
                <span className="text-[14px]">
                  <span className="tnum text-faint">#{order.orderNumber}</span>{" "}
                  {order.items
                    .map((i) => `${i.quantity} × ${i.product.name}`)
                    .join(", ")}
                </span>
                <span className="flex items-baseline gap-3">
                  <span className="tnum text-[14px] font-medium">
                    {formatMoney(
                      order.quotedTotal ?? order.estimatedTotal,
                      current.currency,
                    )}
                    {!order.quotedTotal && (
                      <span className="ml-1 text-[11px] font-normal text-faint">est.</span>
                    )}
                  </span>
                  <span className="rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-[12px] font-medium text-[var(--accent-strong)]">
                    {STATUS_COPY[order.status] ?? order.status}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <form onSubmit={submit} className="space-y-8">
        {error && <Banner>{error}</Banner>}

        <section>
          <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.12em] text-faint">
            What to print
          </h2>
          <div className="space-y-2">
            {products.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setProductId(p.id)}
                aria-pressed={productId === p.id}
                className={cx(
                  "spring block w-full rounded-2xl border p-4 text-left",
                  productId === p.id
                    ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                    : "border-line bg-surface hover:border-[var(--accent-soft)] hover:bg-raised",
                )}
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="font-display text-[15px] font-semibold">{p.name}</span>
                  <span className="tnum shrink-0 text-[14px] font-medium">
                    {formatMoney(p.unitPrice, current.currency)}
                    <span className="text-[12px] font-normal text-muted"> each</span>
                  </span>
                </span>
                <span className="mt-1 block text-[13.5px] leading-relaxed text-muted">
                  {p.blurb}
                </span>
                <span className="mt-1.5 block text-[12px] text-faint">
                  Minimum {p.minQuantity} · about {p.leadTimeDays} days to deliver
                </span>
              </button>
            ))}
          </div>
        </section>

        {product?.perTable ? (
          <section>
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-faint">
                Which tables
              </h2>
              <button
                type="button"
                onClick={() =>
                  setSelectedTables(
                    selectedTables.length === tables.length ? [] : tables.map((t) => t.id),
                  )
                }
                className="text-[12.5px] text-muted hover:text-ink"
              >
                {selectedTables.length === tables.length ? "Clear all" : "Select all"}
              </button>
            </div>

            {tables.length === 0 ? (
              <Empty
                title="No tables yet"
                body="Each card carries a different code, so we need to know which tables to print for. Add your tables first."
              />
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  {tables.map((table) => {
                    const on = selectedTables.includes(table.id);
                    return (
                      <button
                        key={table.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() =>
                          setSelectedTables((prev) =>
                            on ? prev.filter((id) => id !== table.id) : [...prev, table.id],
                          )
                        }
                        className={cx(
                          "spring h-11 min-w-[52px] rounded-xl border px-3 text-[14px] font-medium",
                          on
                            ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                            : "border-line bg-surface text-muted hover:border-[var(--accent-soft)] hover:bg-raised",
                        )}
                      >
                        {table.label}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-2.5 text-[12.5px] text-faint">
                  One card per table — each carries that table&apos;s own code.
                </p>
              </>
            )}
          </section>
        ) : (
          <section className="w-full sm:w-40">
            <Field label="How many">
              <Input
                value={quantity}
                onChange={(e) => setQuantity(e.target.value.replace(/\D/g, ""))}
                inputMode="numeric"
                className="tnum"
              />
            </Field>
          </section>
        )}

        <section>
          <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.12em] text-faint">
            Where to send them
          </h2>
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Contact name">
                <Input
                  value={form.contactName}
                  onChange={(e) => setForm({ ...form, contactName: e.target.value })}
                  required
                />
              </Field>
              <Field label="Phone">
                <Input
                  value={form.contactPhone}
                  onChange={(e) => setForm({ ...form, contactPhone: e.target.value })}
                  inputMode="tel"
                  className="tnum"
                  required
                />
              </Field>
            </div>
            <Field label="Email" optional hint="We'll send the quote here if you add it.">
              <Input
                value={form.contactEmail}
                onChange={(e) => setForm({ ...form, contactEmail: e.target.value })}
                inputMode="email"
              />
            </Field>
            <Field label="Address">
              <Input
                value={form.addressLine1}
                onChange={(e) => setForm({ ...form, addressLine1: e.target.value })}
                placeholder="12 Residency Road"
                required
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="City">
                <Input
                  value={form.city}
                  onChange={(e) => setForm({ ...form, city: e.target.value })}
                  required
                />
              </Field>
              <Field label="State">
                <Input
                  value={form.state}
                  onChange={(e) => setForm({ ...form, state: e.target.value })}
                  required
                />
              </Field>
              <Field label="PIN code">
                <Input
                  value={form.postalCode}
                  onChange={(e) =>
                    setForm({ ...form, postalCode: e.target.value.replace(/\D/g, "") })
                  }
                  inputMode="numeric"
                  className="tnum"
                  required
                />
              </Field>
            </div>
            <Field label="Anything else" optional>
              <Textarea
                rows={2}
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="Needed before the weekend, if possible."
              />
            </Field>
          </div>
        </section>

        <div className="flex flex-wrap items-center gap-4 border-t border-line pt-6">
          <Button
            type="submit"
            variant="primary"
            className="w-full sm:w-auto"
            loading={busy}
            disabled={belowMinimum}
          >
            Send request
          </Button>
          <span className="text-[13.5px] text-muted">
            {belowMinimum && product ? (
              <>
                {product.perTable
                  ? `Choose at least ${product.minQuantity} tables`
                  : `Minimum order is ${product.minQuantity}`}
              </>
            ) : (
              <>
                <span className="tnum font-medium text-ink">
                  {formatMoney(String(estimate), current.currency)}
                </span>{" "}
                estimated for {count} · we&apos;ll confirm the price
              </>
            )}
          </span>
        </div>
      </form>
    </div>
  );
}

