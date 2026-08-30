"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  displayPrice,
  formatMoney,
  googleFontsHref,
  themeCssVars,
  type PublicItem,
  type PublicMenu,
} from "@menu/shared";
import { Button, cx } from "../ui";
import { DietMark } from "../templates/shared";

interface CurrentOrder {
  id: string;
  status: "placed" | "preparing" | "ready" | "completed" | "cancelled";
  dailyNumber: number;
  placedAt: string;
  total: string;
  items: {
    id: string;
    name: string;
    variant: string | null;
    unitPrice: string;
    quantity: number;
    batch: number;
  }[];
}

interface CartLine {
  key: string;
  itemId: string;
  variantId: string | null;
  name: string;
  variantName: string | null;
  unitPrice: string;
  quantity: number;
}

const STATUS_COPY: Record<CurrentOrder["status"], { label: string; hint: string }> = {
  placed: { label: "Sent to the kitchen", hint: "They've got it." },
  preparing: { label: "Being made", hint: "Won't be long." },
  ready: { label: "Ready", hint: "On its way over." },
  completed: { label: "Served", hint: "Enjoy." },
  cancelled: { label: "Cancelled", hint: "Ask a member of staff." },
};

export function Ordering({
  table,
  business,
  menu,
}: {
  table: { id: string; label: string };
  business: { name: string; currency: string };
  menu: PublicMenu;
}) {
  const [cart, setCart] = useState<CartLine[]>([]);
  const [order, setOrder] = useState<CurrentOrder | null>(null);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"menu" | "order">("menu");
  const cartKey = `menu-cart-${table.id}`;
  const restored = useRef(false);

  /* The cart survives a locked phone or a dropped connection. Nothing here has
     reached the kitchen yet, so losing it would just be rude. */
  useEffect(() => {
    try {
      const saved = localStorage.getItem(cartKey);
      if (saved) setCart(JSON.parse(saved) as CartLine[]);
    } catch {
      // Private mode or blocked storage: an empty cart is a fine fallback.
    }
    restored.current = true;
  }, [cartKey]);

  useEffect(() => {
    if (!restored.current) return;
    try {
      localStorage.setItem(cartKey, JSON.stringify(cart));
    } catch {
      // Not worth surfacing — the cart still works in memory.
    }
  }, [cart, cartKey]);

  const loadOrder = useCallback(async () => {
    const res = await fetch("/api/table/order", { cache: "no-store" }).catch(() => null);
    if (!res || !res.ok) return;
    setOrder((await res.json()) as CurrentOrder | null);
  }, []);

  useEffect(() => {
    void loadOrder();
    // Five seconds: a diner wants to see "being made" appear without thinking
    // about it, and this survives flaky restaurant wifi with no reconnection
    // logic to get wrong.
    const id = setInterval(() => void loadOrder(), 5000);
    return () => clearInterval(id);
  }, [loadOrder]);

  const vars = useMemo(
    () => themeCssVars(menu.theme.accent, menu.theme.fontPairing),
    [menu.theme.accent, menu.theme.fontPairing],
  );

  const cartTotal = cart.reduce((sum, l) => sum + Number(l.unitPrice) * l.quantity, 0);
  const cartCount = cart.reduce((sum, l) => sum + l.quantity, 0);

  function addLine(item: PublicItem, variantId: string | null) {
    const variant = item.variants.find((v) => v.id === variantId) ?? null;
    const unitPrice = variant ? variant.price : item.price;
    if (!unitPrice) return;

    const key = `${item.id}:${variantId ?? ""}`;
    setCart((prev) => {
      const found = prev.find((l) => l.key === key);
      if (found) {
        return prev.map((l) =>
          l.key === key ? { ...l, quantity: Math.min(l.quantity + 1, 99) } : l,
        );
      }
      return [
        ...prev,
        {
          key,
          itemId: item.id,
          variantId,
          name: item.name,
          variantName: variant?.name ?? null,
          unitPrice,
          quantity: 1,
        },
      ];
    });
  }

  function changeQty(key: string, delta: number) {
    setCart((prev) =>
      prev
        .map((l) => (l.key === key ? { ...l, quantity: l.quantity + delta } : l))
        .filter((l) => l.quantity > 0),
    );
  }

  async function place() {
    if (cart.length === 0) return;
    setPlacing(true);
    setError(null);

    const res = await fetch("/api/table/order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // Ids and quantities only. The price is the kitchen's to decide.
        items: cart.map((l) => ({
          itemId: l.itemId,
          variantId: l.variantId,
          quantity: l.quantity,
        })),
      }),
    }).catch(() => null);

    setPlacing(false);

    if (!res || !res.ok) {
      const detail = res ? ((await res.json().catch(() => ({}))) as { message?: string }) : {};
      setError(detail.message ?? "That didn't go through. Try again.");
      return;
    }

    setOrder((await res.json()) as CurrentOrder);
    setCart([]);
    setTab("order");
  }

  const batches = useMemo(() => {
    if (!order) return [];
    const map = new Map<number, CurrentOrder["items"]>();
    for (const item of order.items) {
      map.set(item.batch, [...(map.get(item.batch) ?? []), item]);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [order]);

  return (
    <div
      style={
        {
          ...vars,
          "--menu-ink": "#17171a",
          "--menu-muted": "#6b6f78",
          "--menu-line": "#e8e9ec",
        } as React.CSSProperties
      }
      className="mx-auto min-h-screen max-w-[560px] bg-white pb-32"
    >
      <link rel="stylesheet" href={googleFontsHref(menu.theme.fontPairing)} />

      <header className="sticky top-0 z-20 border-b border-[color:var(--menu-line)] bg-white/90 px-5 py-3 backdrop-blur-md">
        <div className="flex items-baseline justify-between gap-3">
          <h1
            className="truncate text-[17px] font-semibold text-[color:var(--menu-ink)]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {business.name}
          </h1>
          <span className="shrink-0 rounded-full bg-[color:var(--accent-soft)] px-2.5 py-1 text-[12px] font-semibold text-[color:var(--accent-strong)]">
            Table {table.label}
          </span>
        </div>

        <div className="mt-2.5 flex gap-1">
          <TabButton active={tab === "menu"} onClick={() => setTab("menu")}>
            Menu
          </TabButton>
          <TabButton active={tab === "order"} onClick={() => setTab("order")}>
            Your order
            {order ? (
              <span className="tnum ml-1 opacity-70">#{order.dailyNumber}</span>
            ) : null}
          </TabButton>
        </div>
      </header>

      {tab === "menu" ? (
        <MenuList menu={menu} currency={business.currency} onAdd={addLine} cart={cart} />
      ) : (
        <OrderPanel order={order} batches={batches} currency={business.currency} />
      )}

      {tab === "menu" && cart.length > 0 && (
        <CartBar
          cart={cart}
          count={cartCount}
          total={cartTotal}
          currency={business.currency}
          placing={placing}
          error={error}
          onChangeQty={changeQty}
          onPlace={() => void place()}
        />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        "spring h-9 rounded-full px-3.5 text-[13.5px] font-medium",
        active
          ? "bg-[color:var(--accent)] text-white"
          : "text-[color:var(--menu-muted)] hover:bg-[color:var(--accent-soft)]",
      )}
    >
      {children}
    </button>
  );
}

function MenuList({
  menu,
  currency,
  onAdd,
  cart,
}: {
  menu: PublicMenu;
  currency: string;
  onAdd: (item: PublicItem, variantId: string | null) => void;
  cart: CartLine[];
}) {
  const qtyFor = (itemId: string, variantId: string | null) =>
    cart.find((l) => l.key === `${itemId}:${variantId ?? ""}`)?.quantity ?? 0;

  return (
    <div>
      {menu.categories.map((category) => (
        <section key={category.id}>
          <h2 className="px-5 pb-2 pt-7 text-[12px] font-semibold uppercase tracking-[0.14em] text-[color:var(--accent)]">
            {category.name}
          </h2>
          <ul className="px-5">
            {category.items.map((item) => {
              const price = displayPrice(item);
              return (
                <li
                  key={item.id}
                  className="border-t border-[color:var(--menu-line)] py-3.5 first:border-t-0"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <h3 className="flex items-center gap-2 text-[15.5px] font-medium text-[color:var(--menu-ink)]">
                        <DietMark tag={item.dietTag} />
                        {item.name}
                      </h3>
                      {item.description && (
                        <p className="mt-0.5 text-[13px] leading-relaxed text-[color:var(--menu-muted)]">
                          {item.description}
                        </p>
                      )}
                    </div>
                    {item.variants.length === 0 && price && (
                      <span className="tnum shrink-0 text-[14.5px] font-semibold text-[color:var(--menu-ink)]">
                        {formatMoney(price.amount, currency)}
                      </span>
                    )}
                  </div>

                  {/* A dish priced by size has no single "add" — you pick the
                      size, which is the same decision either way. */}
                  {item.variants.length > 0 ? (
                    <ul className="mt-2.5 space-y-1.5">
                      {item.variants.map((v) => (
                        <li key={v.id} className="flex items-center justify-between gap-3">
                          <span className="text-[13.5px] text-[color:var(--menu-muted)]">
                            {v.name}{" "}
                            <span className="tnum font-medium text-[color:var(--menu-ink)]">
                              {formatMoney(v.price, currency)}
                            </span>
                          </span>
                          <Stepper
                            quantity={qtyFor(item.id, v.id)}
                            onAdd={() => onAdd(item, v.id)}
                            label={`${item.name}, ${v.name}`}
                          />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="mt-2.5 flex justify-end">
                      <Stepper
                        quantity={qtyFor(item.id, null)}
                        onAdd={() => onAdd(item, null)}
                        label={item.name}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <div className="h-8" />
    </div>
  );
}

function Stepper({
  quantity,
  onAdd,
  label,
}: {
  quantity: number;
  onAdd: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onAdd}
      aria-label={`Add ${label}`}
      className={cx(
        "spring h-9 min-w-[64px] shrink-0 rounded-full border px-3 text-[13px] font-medium",
        quantity > 0
          ? "border-transparent bg-[color:var(--accent)] text-white"
          : "border-[color:var(--menu-line)] text-[color:var(--menu-ink)]",
      )}
    >
      {quantity > 0 ? `${quantity} added` : "Add"}
    </button>
  );
}

function CartBar({
  cart,
  count,
  total,
  currency,
  placing,
  error,
  onChangeQty,
  onPlace,
}: {
  cart: CartLine[];
  count: number;
  total: number;
  currency: string;
  placing: boolean;
  error: string | null;
  onChangeQty: (key: string, delta: number) => void;
  onPlace: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 mx-auto max-w-[560px] border-t border-[color:var(--menu-line)] bg-white/95 backdrop-blur-md">
      {open && (
        <ul className="scroll-quiet max-h-[38vh] overflow-y-auto border-b border-[color:var(--menu-line)] px-5 py-3">
          {cart.map((line) => (
            <li key={line.key} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0 flex-1 text-[14px] text-[color:var(--menu-ink)]">
                {line.name}
                {line.variantName && (
                  <span className="text-[color:var(--menu-muted)]"> · {line.variantName}</span>
                )}
              </span>
              <span className="flex items-center gap-2">
                <button
                  onClick={() => onChangeQty(line.key, -1)}
                  aria-label={`One less ${line.name}`}
                  className="h-9 w-9 rounded-full border border-[color:var(--menu-line)] text-[15px]"
                >
                  −
                </button>
                <span className="tnum w-5 text-center text-[14px] font-medium">
                  {line.quantity}
                </span>
                <button
                  onClick={() => onChangeQty(line.key, 1)}
                  aria-label={`One more ${line.name}`}
                  className="h-9 w-9 rounded-full border border-[color:var(--menu-line)] text-[15px]"
                >
                  +
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p role="alert" className="px-5 pt-2.5 text-[13px] text-[#B3261E]">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3 px-5 py-3">
        <button
          onClick={() => setOpen((o) => !o)}
          className="min-w-0 flex-1 text-left"
          aria-expanded={open}
        >
          <span className="block text-[13px] text-[color:var(--menu-muted)]">
            {count} item{count === 1 ? "" : "s"} · tap to {open ? "hide" : "review"}
          </span>
          <span className="tnum block text-[17px] font-semibold text-[color:var(--menu-ink)]">
            {formatMoney(String(total), currency)}
          </span>
        </button>
        <Button variant="primary" onClick={onPlace} loading={placing}>
          Place order
        </Button>
      </div>
    </div>
  );
}

function OrderPanel({
  order,
  batches,
  currency,
}: {
  order: CurrentOrder | null;
  batches: [number, CurrentOrder["items"]][];
  currency: string;
}) {
  if (!order) {
    return (
      <div className="px-6 py-20 text-center">
        <p className="text-[15px] text-[color:var(--menu-muted)]">
          Nothing ordered yet.
        </p>
        <p className="mt-1 text-[13.5px] text-[color:var(--menu-muted)]">
          Add something from the menu and it&apos;ll show up here.
        </p>
      </div>
    );
  }

  const status = STATUS_COPY[order.status];

  return (
    <div className="px-5 py-6">
      <div className="rounded-2xl bg-[color:var(--accent-soft)] px-4 py-3.5">
        <p className="text-[15px] font-semibold text-[color:var(--accent-strong)]">
          {status.label}
        </p>
        <p className="mt-0.5 text-[13.5px] text-[color:var(--accent-strong)] opacity-80">
          {status.hint} Order #{order.dailyNumber}.
        </p>
      </div>

      {batches.map(([batch, items]) => (
        <section key={batch} className="mt-5">
          {batches.length > 1 && (
            <h3 className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.12em] text-[color:var(--menu-muted)]">
              Round {batch}
            </h3>
          )}
          <ul className="rounded-2xl border border-[color:var(--menu-line)]">
            {items.map((item) => (
              <li
                key={item.id}
                className="flex items-baseline justify-between gap-3 border-t border-[color:var(--menu-line)] px-4 py-2.5 first:border-t-0"
              >
                <span className="min-w-0 flex-1 text-[14.5px] text-[color:var(--menu-ink)]">
                  <span className="tnum mr-1.5 text-[color:var(--menu-muted)]">
                    {item.quantity}×
                  </span>
                  {item.name}
                  {item.variant && (
                    <span className="text-[color:var(--menu-muted)]"> · {item.variant}</span>
                  )}
                </span>
                <span className="tnum shrink-0 text-[14px] text-[color:var(--menu-ink)]">
                  {formatMoney(String(Number(item.unitPrice) * item.quantity), currency)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <div className="mt-5 flex items-baseline justify-between border-t border-[color:var(--menu-line)] pt-3.5">
        <span className="text-[14px] text-[color:var(--menu-muted)]">Total so far</span>
        <span className="tnum text-[19px] font-semibold text-[color:var(--menu-ink)]">
          {formatMoney(order.total, currency)}
        </span>
      </div>
      <p className="mt-2 text-[12.5px] leading-relaxed text-[color:var(--menu-muted)]">
        Taxes and charges are added to your bill at the table.
      </p>
    </div>
  );
}
