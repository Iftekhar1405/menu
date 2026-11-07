import { config } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// One .env at the repo root, shared with the API, so the two can never drift
// onto different secrets or origins.
const rootEnv = resolve(process.cwd(), "../../.env");
if (existsSync(rootEnv)) config({ path: rootEnv });

/**
 * The product was "menu" at menu.irad.solutions before it became supermenu.
 * QR codes already printed on tables and cards point at the old host for
 * good, so it stays attached to this deployment and every page on it
 * permanently redirects to the same path on the new one (query kept).
 *
 * /api is left alone: a 308 to another origin turns a same-origin fetch from
 * a tab opened before the rename into a CORS failure. Those routes answer on
 * either host. Mirrors LEGACY_SITE_HOSTS / SITE_HOST in @menu/shared, which
 * this .mjs cannot import before that package is built.
 */
const SITE_HOST = "supermenu.irad.solutions";
const LEGACY_SITE_HOSTS = ["menu.irad.solutions"];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async redirects() {
    return LEGACY_SITE_HOSTS.map((host) => ({
      source: "/:path((?!api/).*)",
      has: [{ type: "host", value: host }],
      destination: `https://${SITE_HOST}/:path`,
      permanent: true,
    }));
  },
  // @menu/shared ships TypeScript-built CJS from the workspace.
  transpilePackages: ["@menu/shared"],
  images: {
    remotePatterns: [
      { protocol: "http", hostname: "localhost" },
      { protocol: "https", hostname: "**.supabase.co" },
      { protocol: "https", hostname: "res.cloudinary.com" },
    ],
  },
};
export default nextConfig;
