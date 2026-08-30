"use client";

import { useState } from "react";
import {
  DIET_TAG_LABEL,
  SPICE_LEVEL_LABEL,
  displayPrice,
  formatMoney,
  hasAdvancedDetails,
  type PublicItem,
  type PublicMenu,
} from "@menu/shared";
import { cx } from "../ui";

/* Pieces every layout shares, so a change to how a price or a diet mark reads
 * lands in all three at once. */

export function Price({ item, currency }: { item: PublicItem; currency: string }) {
  const price = displayPrice(item);
  if (!price) return null;
  return (
    <span className="tnum whitespace-nowrap text-[15px] font-semibold text-[color:var(--menu-ink)]">
      {price.from && (
        <span className="mr-1 text-[11px] font-normal uppercase tracking-wide opacity-55">
          from
        </span>
      )}
      {formatMoney(price.amount, currency)}
    </span>
  );
}

/**
 * The veg/non-veg mark is the square-in-a-square used on Indian packaging and
 * menus. It is legally mandated there and diners read it instantly — a
 * coloured dot or a word would be slower and less familiar.
 */
export function DietMark({ tag }: { tag: PublicItem["dietTag"] }) {
  if (!tag) return null;
  const colour =
    tag === "non_veg" ? "#B3261E" : tag === "egg" ? "#B8860B" : "#1B7A3D";
  return (
    <span
      className="inline-flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-[2px] border-[1.5px]"
      style={{ borderColor: colour }}
      title={DIET_TAG_LABEL[tag]}
      aria-label={DIET_TAG_LABEL[tag]}
    >
      <span
        className={cx("h-[6px] w-[6px]", tag === "non_veg" ? "" : "rounded-full")}
        style={{
          background: colour,
          clipPath: tag === "non_veg" ? "polygon(50% 0%, 0% 100%, 100% 100%)" : undefined,
        }}
      />
    </span>
  );
}

export function VariantRow({
  item,
  currency,
}: {
  item: PublicItem;
  currency: string;
}) {
  if (item.variants.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
      {item.variants.map((v) => (
        <li key={v.id} className="text-[13px] text-[color:var(--menu-muted)]">
          {v.name}{" "}
          <span className="tnum font-medium text-[color:var(--menu-ink)]">
            {formatMoney(v.price, currency)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Advanced details stay collapsed. Most diners want a name and a price. */
export function Details({ item }: { item: PublicItem }) {
  const [open, setOpen] = useState(false);
  if (!hasAdvancedDetails(item)) return null;

  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="text-[12.5px] font-medium text-[color:var(--accent)] underline-offset-2 hover:underline"
      >
        {open ? "Hide details" : "More details"}
      </button>

      {open && (
        <dl className="mt-2 space-y-1.5 border-l-2 border-[color:var(--menu-line)] pl-3 text-[12.5px] text-[color:var(--menu-muted)]">
          {item.ingredients && (
            <div>
              <dt className="font-medium text-[color:var(--menu-ink)]">Ingredients</dt>
              <dd>{item.ingredients}</dd>
            </div>
          )}
          {item.allergens.length > 0 && (
            <div>
              <dt className="font-medium text-[color:var(--menu-ink)]">Allergens</dt>
              <dd>{item.allergens.join(", ")}</dd>
            </div>
          )}
          {item.spiceLevel != null && item.spiceLevel > 0 && (
            <div>
              <dt className="font-medium text-[color:var(--menu-ink)]">Spice</dt>
              <dd>{SPICE_LEVEL_LABEL[item.spiceLevel]}</dd>
            </div>
          )}
          {item.prepTimeMins != null && (
            <div>
              <dt className="font-medium text-[color:var(--menu-ink)]">Prepared in</dt>
              <dd className="tnum">about {item.prepTimeMins} min</dd>
            </div>
          )}
          {item.nutrition && (
            <div>
              <dt className="font-medium text-[color:var(--menu-ink)]">Nutrition</dt>
              <dd className="tnum">
                {Object.entries(item.nutrition)
                  .filter(([, v]) => v !== undefined && v !== null && v !== "")
                  .map(([k, v]) => `${nutritionLabel(k)} ${v}`)
                  .join(" · ")}
              </dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}

function nutritionLabel(key: string): string {
  const map: Record<string, string> = {
    calories: "Calories",
    proteinG: "Protein (g)",
    carbsG: "Carbs (g)",
    fatG: "Fat (g)",
    fibreG: "Fibre (g)",
    sugarG: "Sugar (g)",
    sodiumMg: "Sodium (mg)",
    servingSize: "Serving",
  };
  return map[key] ?? key;
}

export function MenuHeader({ menu }: { menu: PublicMenu }) {
  const { business } = menu;
  return (
    <header className="px-5 pb-5 pt-8 text-center">
      {business.logoUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={business.logoUrl}
          alt=""
          className="mx-auto mb-3 h-16 w-16 rounded-full object-cover"
        />
      )}
      <h1
        className="text-[26px] font-semibold leading-tight text-[color:var(--menu-ink)]"
        style={{ fontFamily: "var(--font-display)" }}
      >
        {business.name}
      </h1>
      {business.address?.city && (
        <p className="mt-1 text-[13px] text-[color:var(--menu-muted)]">
          {[business.address.line1, business.address.city].filter(Boolean).join(", ")}
        </p>
      )}
    </header>
  );
}

export function EmptyMenu() {
  return (
    <div className="px-6 py-20 text-center">
      <p className="text-[15px] text-[color:var(--menu-muted)]">
        This menu is still being written.
      </p>
    </div>
  );
}

export function MenuFooter() {
  return (
    <footer className="px-5 pb-10 pt-8 text-center">
      <p className="text-[11px] tracking-wide text-[color:var(--menu-muted)] opacity-60">
        menu.irad.solutions
      </p>
    </footer>
  );
}
