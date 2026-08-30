import { config } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// One .env at the repo root, shared with the API, so the two can never drift
// onto different secrets or origins.
const rootEnv = resolve(process.cwd(), "../../.env");
if (existsSync(rootEnv)) config({ path: rootEnv });

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @menu/shared ships TypeScript-built CJS from the workspace.
  transpilePackages: ["@menu/shared"],
  images: {
    remotePatterns: [
      { protocol: "http", hostname: "localhost" },
      { protocol: "https", hostname: "**.supabase.co" },
    ],
  },
};
export default nextConfig;
