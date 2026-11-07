import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/*
 * The landing pages and restaurants' public menus are meant to be found.
 * The dashboard, a table's private ordering link and the API are not.
 */
const PRIVATE = [
  "/order", "/dashboard", "/orders", "/menu", "/tables", "/billing", "/appearance",
  "/templates", "/qr", "/merch", "/settings", "/station", "/dishes", "/admin",
  "/tutorial", "/change-pin", "/login", "/signup", "/forgot-pin",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/api/",
        "/t/",
        // Dashboard screens, matched exactly (`$`) and with anything under
        // them, so a restaurant whose public slug merely starts with the
        // same letters ("/menu-house", "/orderly-cafe") stays indexable.
        ...PRIVATE.flatMap((p) => [`${p}$`, `${p}/`]),
      ],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
