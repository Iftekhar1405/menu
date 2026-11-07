/**
 * The product's public name and address, in one place.
 *
 * The marketing page, its metadata, the sitemap and the structured data all
 * read from here, so a rename is a change to this file rather than a hunt
 * through copy. `NEXT_PUBLIC_SITE_URL` overrides the origin for previews.
 */
export const BRAND_NAME = "menu.irad";
export const SITE_HOST = "menu.irad.solutions";
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
