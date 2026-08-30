import type { BusinessType, DietTag } from "./enums";
import type { ThemeLayout } from "./theme-tokens";

/**
 * The contract between `get_public_menu(code)` and the three templates.
 *
 * This is the entire diner-facing payload: one request, one render. Anything
 * a template needs must appear here, because the public page makes no further
 * calls. Hidden categories and unavailable items are filtered out server-side
 * and never reach this type.
 */

export interface PublicVariant {
  id: string;
  name: string;
  /** Minor-unit-free decimal string, e.g. "249.00". Formatted client-side. */
  price: string;
}

export interface PublicPhoto {
  id: string;
  url: string;
  alt: string | null;
}

export interface PublicItem {
  id: string;
  name: string;
  /** Null when the item is priced by variant instead. */
  price: string | null;
  description: string | null;
  dietTag: DietTag | null;
  spiceLevel: number | null;
  prepTimeMins: number | null;
  ingredients: string | null;
  allergens: string[];
  nutrition: NutritionFacts | null;
  variants: PublicVariant[];
  photos: PublicPhoto[];
}

export interface NutritionFacts {
  calories?: number;
  proteinG?: number;
  carbsG?: number;
  fatG?: number;
  fibreG?: number;
  sugarG?: number;
  sodiumMg?: number;
  servingSize?: string;
}

export interface PublicCategory {
  id: string;
  name: string;
  items: PublicItem[];
}

export interface PublicMenu {
  business: {
    id: string;
    name: string;
    type: BusinessType;
    logoUrl: string | null;
    address: PublicAddress | null;
    currency: string;
    publicCode: string;
  };
  theme: {
    layout: ThemeLayout;
    accent: string;
    fontPairing: string;
  };
  categories: PublicCategory[];
  /** ISO timestamp of the most recent menu mutation. Drives cache busting. */
  updatedAt: string;
}

export interface PublicAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string;
}

/**
 * The price a card should show. Items priced by variant display the cheapest
 * variant prefixed with "from", which is why this returns a shape rather than
 * a string — templates render the prefix differently.
 */
export function displayPrice(item: PublicItem): { from: boolean; amount: string } | null {
  if (item.price !== null) return { from: false, amount: item.price };
  if (item.variants.length === 0) return null;
  const cheapest = item.variants.reduce((min, v) =>
    Number(v.price) < Number(min.price) ? v : min,
  );
  return { from: true, amount: cheapest.price };
}

export function formatMoney(amount: string, currency: string, locale = "en-IN"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: Number(amount) % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(Number(amount));
}

/** True when the item carries anything worth showing behind "More details". */
export function hasAdvancedDetails(item: PublicItem): boolean {
  return Boolean(
    item.ingredients ||
      item.allergens.length > 0 ||
      item.nutrition ||
      item.prepTimeMins !== null ||
      (item.spiceLevel !== null && item.spiceLevel > 0),
  );
}
