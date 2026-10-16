"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api-client";
import { useSession } from "@/components/session";
import { Banner, Button, Empty, Input, Toggle, cx } from "@/components/ui";
import { mediaUrl } from "@/lib/preview";

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
interface Photo {
  id: string;
  storagePath: string;
  alt: string | null;
}

interface Item {
  id: string;
  name: string;
  isAvailable: boolean;
  /** First one is the thumbnail. Empty for a dish nobody photographed. */
  photos: Photo[];
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
  const [query, setQuery] = useState("");

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

  /*
   * Search matches the dish name only. A kitchen hunting for "dosa" mid-service
   * wants the dish, not every category that happens to mention it — and an
   * empty category is dropped rather than left as a heading with nothing under
   * it. The whole menu is already in memory, so this stays a local filter: a
   * round trip per keystroke on restaurant wifi is how a search box becomes
   * slower than scrolling.
   */
  const needle = query.trim().toLowerCase();
  const shown = (categories ?? [])
    .map((c) => ({
      ...c,
      items: needle
        ? c.items.filter((i) => i.name.toLowerCase().includes(needle))
        : c.items,
    }))
    .filter((c) => c.items.length > 0 || !needle);

  const matches = shown.reduce((n, c) => n + c.items.length, 0);

  const searchBox = (
    <div className="mb-5">
      <Input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search dishes"
        aria-label="Search dishes"
        autoComplete="off"
      />
    </div>
  );

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
      ) : matches === 0 && needle ? (
        <>
          {searchBox}
          <Empty
            title={`Nothing matches “${query.trim()}”`}
            body="Check the spelling, or clear the search to see the whole menu."
          />
        </>
      ) : (
        <>
        {searchBox}
        {shown.map((category) => (
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
                      "flex items-center gap-3 px-3.5",
                      pending.has(item.id) && "pointer-events-none opacity-60",
                    )}
                  >
                    {/*
                      * The photo is the fastest way to find a dish on a tablet
                      * mid-service — you recognise it before you finish reading
                      * the name. Dishes with no photo keep their place in the
                      * row with a neutral tile, so the column stays aligned
                      * rather than ragging left wherever one is missing.
                      */}
                    {item.photos[0] ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={mediaUrl(item.photos[0].storagePath)}
                        alt=""
                        className={cx(
                          "h-11 w-11 shrink-0 rounded-xl object-cover",
                          !item.isAvailable && "opacity-40 grayscale",
                        )}
                      />
                    ) : (
                      <span
                        aria-hidden="true"
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-raised text-[15px] font-semibold text-faint"
                      >
                        {item.name.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <Toggle
                        checked={item.isAvailable}
                        onChange={(next) => void toggleItem(item, next)}
                        label={item.name}
                      />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
        </>
      )}
    </div>
  );
}
