/**
 * The product's name and address, in one place.
 *
 * The product was called "menu" at menu.irad.solutions. It is now supermenu.
 * The old host stays in LEGACY_SITE_HOSTS because QR codes already printed
 * on tables and cards point at it forever — it must keep resolving.
 */
export const BRAND_NAME = "supermenu";
export const SITE_HOST = "supermenu.irad.solutions";
export const SITE_URL = `https://${SITE_HOST}`;
export const LEGACY_SITE_HOSTS = ["menu.irad.solutions"] as const;
