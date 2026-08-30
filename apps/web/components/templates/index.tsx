"use client";

import { useMemo, useState } from "react";
import {
  googleFontsHref,
  themeCssVars,
  type PublicItem,
  type PublicMenu,
} from "@menu/shared";
import { cx } from "../ui";
import {
  Details,
  DietMark,
  EmptyMenu,
  MenuFooter,
  MenuHeader,
  Price,
  VariantRow,
} from "./shared";

/**
 * Three layouts, one payload.
 *
 * They differ in how much room photography gets and how dense the rows are,
 * because a cinema concession queue and a tasting-menu restaurant are not the
 * same reading situation. Everything else — the theme tokens, the diet marks,
 * the price logic — is shared, so a menu looks like the same product whichever
 * layout the owner picked.
 */

export interface MenuViewProps {
  menu: PublicMenu;
  /** Preview mode drops the sticky rail and search, which need real viewport. */
  compactChrome?: boolean;
}

export function MenuView({ menu, compactChrome }: MenuViewProps) {
  const [query, setQuery] = useState("");
  const [vegOnly, setVegOnly] = useState(false);

  const vars = useMemo(
    () => themeCssVars(menu.theme.accent, menu.theme.fontPairing),
    [menu.theme.accent, menu.theme.fontPairing],
  );

  // Filtering happens on the already-loaded payload, so it costs nothing and
  // works offline once the page is open.
  const categories = useMemo(() => {
    const q = query.trim().toLowerCase();
    return menu.categories
      .map((c) => ({
        ...c,
        items: c.items.filter((i) => {
          if (vegOnly && i.dietTag !== "veg" && i.dietTag !== "vegan") return false;
          if (!q) return true;
          return (
            i.name.toLowerCase().includes(q) ||
            (i.description ?? "").toLowerCase().includes(q)
          );
        }),
      }))
      .filter((c) => c.items.length > 0);
  }, [menu.categories, query, vegOnly]);

  const Layout =
    menu.theme.layout === "compact"
      ? CompactLayout
      : menu.theme.layout === "grid"
        ? GridLayout
        : EditorialLayout;

  const hasAnyItems = menu.categories.some((c) => c.items.length > 0);

  return (
    <div
      style={
        {
          ...vars,
          "--menu-ink": "#17171a",
          "--menu-muted": "#6b6f78",
          "--menu-line": "#e8e9ec",
          fontFamily: "var(--font-body)",
        } as React.CSSProperties
      }
      className="min-h-full bg-white"
    >
      <link rel="stylesheet" href={googleFontsHref(menu.theme.fontPairing)} />

      <MenuHeader menu={menu} />

      {hasAnyItems && !compactChrome && (
        <FilterBar
          query={query}
          onQuery={setQuery}
          vegOnly={vegOnly}
          onVegOnly={setVegOnly}
          categories={menu.categories.map((c) => ({ id: c.id, name: c.name }))}
        />
      )}

      {!hasAnyItems ? (
        <EmptyMenu />
      ) : categories.length === 0 ? (
        <p className="px-6 py-16 text-center text-[14px] text-[color:var(--menu-muted)]">
          Nothing matches that. Try a different word.
        </p>
      ) : (
        <Layout categories={categories} currency={menu.business.currency} />
      )}

      <MenuFooter />
    </div>
  );
}

/* ── Chrome ────────────────────────────────────────────────────────────────
 * The one place translucency is used. It sits above content and needs to stay
 * legible over whatever scrolls under it. */
function FilterBar({
  query,
  onQuery,
  vegOnly,
  onVegOnly,
  categories,
}: {
  query: string;
  onQuery: (v: string) => void;
  vegOnly: boolean;
  onVegOnly: (v: boolean) => void;
  categories: { id: string; name: string }[];
}) {
  return (
    <div className="sticky top-0 z-10 border-b border-[color:var(--menu-line)] bg-white/85 backdrop-blur-md">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search the menu"
          aria-label="Search the menu"
          className="h-10 min-w-0 flex-1 rounded-full border border-[color:var(--menu-line)] bg-white px-4 text-[14px] outline-none focus:border-[color:var(--accent)]"
        />
        <button
          onClick={() => onVegOnly(!vegOnly)}
          aria-pressed={vegOnly}
          className={cx(
            "spring h-10 shrink-0 rounded-full border px-3.5 text-[13px] font-medium",
            vegOnly
              ? "border-transparent bg-[color:var(--accent)] text-white"
              : "border-[color:var(--menu-line)] text-[color:var(--menu-muted)]",
          )}
        >
          Veg only
        </button>
      </div>

      {categories.length > 1 && (
        <nav
          aria-label="Menu sections"
          className="scroll-quiet flex gap-1 overflow-x-auto px-4 pb-2"
        >
          {categories.map((c) => (
            <a
              key={c.id}
              href={`#cat-${c.id}`}
              className="shrink-0 rounded-full px-3 py-1.5 text-[13px] text-[color:var(--menu-muted)] hover:bg-[color:var(--accent-soft)] hover:text-[color:var(--accent-strong)]"
            >
              {c.name}
            </a>
          ))}
        </nav>
      )}
    </div>
  );
}

function CategoryHeading({ id, name }: { id: string; name: string }) {
  return (
    <h2
      id={`cat-${id}`}
      className="scroll-mt-28 px-5 pb-3 pt-9 text-[12px] font-semibold uppercase tracking-[0.14em] text-[color:var(--accent)]"
    >
      {name}
    </h2>
  );
}

type LayoutProps = {
  categories: { id: string; name: string; items: PublicItem[] }[];
  currency: string;
};

/* ── Editorial ─────────────────────────────────────────────────────────── */

function EditorialLayout({ categories, currency }: LayoutProps) {
  return (
    <div>
      {categories.map((c) => (
        <section key={c.id}>
          <CategoryHeading id={c.id} name={c.name} />
          <ul>
            {c.items.map((item) => (
              <li
                key={item.id}
                className="border-t border-[color:var(--menu-line)] px-5 py-5 first:border-t-0"
              >
                {item.photos[0] && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.photos[0].url}
                    alt={item.photos[0].alt ?? ""}
                    loading="lazy"
                    className="mb-3.5 aspect-[16/10] w-full rounded-xl object-cover"
                  />
                )}
                <div className="flex items-start justify-between gap-4">
                  <h3 className="flex items-center gap-2 text-[17px] font-medium leading-snug text-[color:var(--menu-ink)]">
                    <DietMark tag={item.dietTag} />
                    {item.name}
                  </h3>
                  <Price item={item} currency={currency} />
                </div>
                {item.description && (
                  <p className="mt-1.5 max-w-prose text-[14px] leading-relaxed text-[color:var(--menu-muted)]">
                    {item.description}
                  </p>
                )}
                <VariantRow item={item} currency={currency} />
                <Details item={item} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/* ── Compact ───────────────────────────────────────────────────────────── */

function CompactLayout({ categories, currency }: LayoutProps) {
  return (
    <div>
      {categories.map((c) => (
        <section key={c.id}>
          <CategoryHeading id={c.id} name={c.name} />
          <ul className="px-5">
            {c.items.map((item) => (
              <li
                key={item.id}
                className="border-t border-[color:var(--menu-line)] py-3 first:border-t-0"
              >
                <div className="flex items-baseline justify-between gap-3">
                  {/* A heading in every layout, not just the photo-led ones,
                      so a screen reader user can jump dish to dish however
                      the owner styled the menu. */}
                  <h3 className="flex min-w-0 items-center gap-2 text-[15px] font-medium text-[color:var(--menu-ink)]">
                    <DietMark tag={item.dietTag} />
                    <span className="truncate">{item.name}</span>
                  </h3>
                  <Price item={item} currency={currency} />
                </div>
                {item.description && (
                  <p className="mt-0.5 line-clamp-1 text-[13px] text-[color:var(--menu-muted)]">
                    {item.description}
                  </p>
                )}
                <VariantRow item={item} currency={currency} />
                <Details item={item} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/* ── Grid ──────────────────────────────────────────────────────────────── */

function GridLayout({ categories, currency }: LayoutProps) {
  return (
    <div>
      {categories.map((c) => (
        <section key={c.id}>
          <CategoryHeading id={c.id} name={c.name} />
          <ul className="grid grid-cols-2 gap-3 px-5">
            {c.items.map((item) => (
              <li
                key={item.id}
                className="overflow-hidden rounded-2xl border border-[color:var(--menu-line)]"
              >
                {item.photos[0] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.photos[0].url}
                    alt={item.photos[0].alt ?? ""}
                    loading="lazy"
                    className="aspect-square w-full object-cover"
                  />
                ) : (
                  <div className="aspect-square w-full bg-[color:var(--accent-soft)]" />
                )}
                <div className="p-3">
                  <h3 className="flex items-start gap-1.5 text-[14px] font-medium leading-snug text-[color:var(--menu-ink)]">
                    <span className="mt-0.5">
                      <DietMark tag={item.dietTag} />
                    </span>
                    {item.name}
                  </h3>
                  <div className="mt-1.5">
                    <Price item={item} currency={currency} />
                  </div>
                  <VariantRow item={item} currency={currency} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
