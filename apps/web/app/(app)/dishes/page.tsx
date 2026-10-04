"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api-client";
import { useSession } from "@/components/session";
import { Banner, Button, Empty, Toggle, cx } from "@/components/ui";

/**
 * What the kitchen can change about the menu: whether a dish is on.
 *
 * The owner's menu builder (`/menu`) is a different screen on purpose. Its
 * job is prices, variants, photos and ordering; this one's is a single
 * switch that has to be usable with one hand, mid-service, on a tablet with
 * flour on it. Threading a `canEdit` flag through the builder instead is how
 * a price leaks back onto a kitchen screen in six months — so these types
 * only name what a kitchen caller actually receives. The API strips every
 * price field before it leaves the server (Task 7); nothing here declares
 * one it would then have to remember not to render.
 */
interface Item {
  id: string;
  name: string;
  isAvailable: boolean;
}

interface Category {
  id: string;
  name: string;
  items: Item[];
}

export default function DishesPage() {
  const { current } = useSession();
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Item ids with a PATCH in flight — blocks a second tap racing the first. */
  const [pending, setPending] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!current) return;
    setLoadError(null);
    try {
      setCategories(await api.get<Category[]>(`/businesses/${current.id}/menu`));
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "We couldn't load the menu just now.");
    }
  }, [current]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Optimistic: a switch that waits on a round trip gets tapped twice, and
   * the second tap undoes the first. The flip happens on screen immediately;
   * a failed save reverts just this item (not a full reload) so it doesn't
   * also stomp on some other dish's toggle still in flight, and says so —
   * silently reverting would look like the tap missed.
   */
  async function toggleItem(item: Item, next: boolean) {
    if (!current || pending.has(item.id)) return;

    setError(null);
    setPending((prev) => new Set(prev).add(item.id));
    setCategories((prev) =>
      (prev ?? []).map((c) => ({
        ...c,
        items: c.items.map((i) => (i.id === item.id ? { ...i, isAvailable: next } : i)),
      })),
    );

    try {
      await api.patch(`/businesses/${current.id}/menu/items/${item.id}/availability`, {
        isAvailable: next,
      });
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : `"${item.name}" didn't save. Check the connection and try again.`,
      );
      setCategories((prev) =>
        (prev ?? []).map((c) => ({
          ...c,
          items: c.items.map((i) => (i.id === item.id ? { ...i, isAvailable: !next } : i)),
        })),
      );
    } finally {
      setPending((prev) => {
        const copy = new Set(prev);
        copy.delete(item.id);
        return copy;
      });
    }
  }

  if (!current) return null;

  return (
    <div className="px-5 py-8 sm:px-6 sm:py-10 lg:px-10 lg:py-12">
      <header className="mb-6 sm:mb-8">
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight sm:text-[30px]">
          Dishes
        </h1>
        <p className="mt-1 text-[14.5px] text-muted">
          Turn a dish off when you run out. Diners stop seeing it on the menu straight
          away, and it stays listed here so you can turn it back on later.
        </p>
      </header>

      {error && (
        <div className="mb-6">
          <Banner>{error}</Banner>
        </div>
      )}

      {categories === null ? (
        loadError ? (
          <Banner>
            {loadError}{" "}
            <Button size="sm" variant="ghost" className="ml-1" onClick={() => void load()}>
              Try again
            </Button>
          </Banner>
        ) : (
          <p className="text-[14px] text-faint">Loading…</p>
        )
      ) : categories.length === 0 ? (
        <Empty
          title="No dishes yet"
          body="Dishes are added from the menu builder. Once there are some, turning them on and off during service happens here."
        />
      ) : (
        categories.map((category) => (
          <section key={category.id} className="mt-8 first:mt-0">
            <h2 className="mb-2.5 text-[13px] font-semibold uppercase tracking-[0.12em] text-faint">
              {category.name}
            </h2>

            {category.items.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-line px-4 py-6 text-center text-[13px] text-faint">
                No dishes in this category yet.
              </p>
            ) : (
              <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
                {category.items.map((item) => (
                  <li
                    key={item.id}
                    className={cx(
                      "px-3.5",
                      pending.has(item.id) && "pointer-events-none opacity-60",
                    )}
                  >
                    <Toggle
                      checked={item.isAvailable}
                      onChange={(next) => void toggleItem(item, next)}
                      label={item.name}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))
      )}
    </div>
  );
}
