import { Resvg } from "@resvg/resvg-js";
import jsQR from "jsqr";
import { PNG } from "pngjs";

/**
 * Rasterise an SVG card and read the QR back out of the pixels.
 *
 * Asserting on the markup would only prove we wrote the path we meant to
 * write. The thing that matters is whether a phone camera pointed at the
 * print gets the right URL, and the only honest way to check that is to
 * decode it.
 */
export function decodeQrFromSvg(svg: string, widthPx = 900): string | null {
  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: widthPx },
    background: "#FFFFFF",
  })
    .render()
    .asPng();

  const { width, height, data } = PNG.sync.read(Buffer.from(png));
  return jsQR(new Uint8ClampedArray(data), width, height)?.data ?? null;
}
