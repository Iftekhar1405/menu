import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Renders the raster icons from public/mark.svg.
 *
 * They are generated rather than drawn separately so the favicon, the Apple
 * touch icon and the mark can never drift apart — a favicon that no longer
 * matches the logo is the kind of thing nobody notices for a year.
 *
 * Run with: pnpm --filter @menu/web icons
 */
const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..");
const svg = readFileSync(join(web, "public/mark.svg"));

const OUTPUTS = [
  // Apple touch icon: no transparency, so the rounded corners are baked in by
  // the SVG itself rather than left to iOS.
  { path: "app/apple-icon.png", size: 180 },
  { path: "public/icon-192.png", size: 192 },
  { path: "public/icon-512.png", size: 512 },
  // A 32px raster fallback for anything that will not take an SVG favicon.
  { path: "public/favicon-32.png", size: 32 },
];

for (const { path, size } of OUTPUTS) {
  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: size },
    background: "transparent",
  })
    .render()
    .asPng();

  writeFileSync(join(web, path), png);
  console.log(`${path.padEnd(24)} ${size}×${size}  ${(png.length / 1024).toFixed(1)}kB`);
}
