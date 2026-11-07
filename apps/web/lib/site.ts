/**
 * The product's public name and address, for the landing page, its
 * metadata, the sitemap and the structured data.
 *
 * The product was "menu" at menu.irad.solutions and is now supermenu. The
 * old name stays in LEGACY_* so search engines can tie it to the new one;
 * the old host itself keeps working through the 308 redirect that the
 * rename branch (feat/supermenu-and-kitchen-account) adds to next.config.
 * Mirrors `@menu/shared` brand.ts on that branch — once both are merged
 * this file should re-export from there.
 *
 * `NEXT_PUBLIC_SITE_URL` overrides the origin for previews.
 */
export const BRAND_NAME = "supermenu";
export const SITE_HOST = "supermenu.irad.solutions";
export const LEGACY_BRAND_NAMES = ["menu.irad", "menu.irad.solutions"] as const;
export const LEGACY_SITE_HOSTS = ["menu.irad.solutions"] as const;
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? `https://${SITE_HOST}`).replace(/\/$/, "");

export const COMPANY_NAME = "irad.solutions";
export const COMPANY_URL = "https://irad.solutions";

export const TOUR = {
  src: "/media/tour-720p.mp4",
  poster: "/media/tour-poster.jpg",
  /** ISO 8601, for VideoObject structured data. */
  duration: "PT4M16S",
  label: "4:16",
  uploadDate: "2026-10-22",
} as const;
