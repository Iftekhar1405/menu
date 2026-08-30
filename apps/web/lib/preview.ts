import type { PublicMenu, ThemeLayout } from "@menu/shared";
import { apiOrigin } from "./api-client";
import type { Business, Category } from "./types";

/**
 * Turns builder state into the exact payload the public page renders.
 *
 * The preview goes through the same type and the same components as the live
 * menu, so what an owner sees while typing is not an approximation of the
 * result — it is the result, with unsaved edits in it. Hidden categories and
 * unavailable dishes are filtered here the same way the SQL function filters
 * them, so "unavailable" visibly disappears from the phone.
 */
export function toPreviewMenu(
  business: Business,
  categories: Category[],
  themeOverride?: Partial<PublicMenu["theme"]>,
): PublicMenu {
  return {
    business: {
      id: business.id,
      name: business.name,
      type: business.type,
      logoUrl: business.logoPath ? mediaUrl(business.logoPath) : null,
      address:
        business.addressLine1 || business.city
          ? {
              line1: business.addressLine1,
              line2: business.addressLine2,
              city: business.city,
              state: business.state,
              postalCode: business.postalCode,
              country: business.country,
            }
          : null,
      currency: business.currency,
      publicCode: business.publicCode,
    },
    theme: {
      layout: business.themeLayout as ThemeLayout,
      accent: business.themeAccent,
      fontPairing: business.themeFont,
      ...themeOverride,
    },
    updatedAt: new Date().toISOString(),
    categories: categories
      .filter((c) => c.isVisible)
      .map((c) => ({
        id: c.id,
        name: c.name,
        items: c.items
          .filter((i) => i.isAvailable)
          .map((i) => ({
            id: i.id,
            name: i.name,
            price: i.price,
            description: i.description,
            dietTag: i.dietTag,
            spiceLevel: i.spiceLevel,
            prepTimeMins: i.prepTimeMins,
            ingredients: i.ingredients,
            allergens: i.allergens,
            nutrition: (i.nutrition ?? null) as PublicMenu["categories"][number]["items"][number]["nutrition"],
            variants: i.variants.map((v) => ({
              id: v.id,
              name: v.name,
              price: v.price,
            })),
            photos: i.photos.map((p) => ({
              id: p.id,
              url: mediaUrl(p.storagePath),
              alt: p.alt,
            })),
          })),
      }))
      .filter((c) => c.items.length > 0),
  };
}

/**
 * Turns a stored path into something an <img> can load.
 *
 * The API does this too, for the public menu payload. This copy exists for the
 * dashboard, which renders photos the owner just uploaded without a round trip
 * — so it has to know the same rules.
 */
export function mediaUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;

  const cloud = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME;
  if (cloud) {
    // f_auto,q_auto lets Cloudinary pick format and quality per request.
    return `https://res.cloudinary.com/${cloud}/image/upload/f_auto,q_auto/${path}`;
  }

  const supabase = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const bucket = process.env.NEXT_PUBLIC_SUPABASE_BUCKET ?? "business-assets";
  if (supabase) {
    return `${supabase}/storage/v1/object/public/${bucket}/${path}`;
  }

  return `${apiOrigin()}/media/local/${path}`;
}
