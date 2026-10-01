import { CELL_ASPECT } from "@menu/shared";
import { escapeXml, qrPath, round, truncate } from "./qr-path";

/**
 * The dense cell for a printed sheet: a QR and the table's name, nothing else.
 *
 * The full card carries the business name, logo, caption and watermark, all
 * of which are worth the space on a table tent and none of which are worth
 * it when an owner is cutting forty stickers out of one sheet of A4. What
 * survives is the only part that has to: the code, and enough label to tell
 * table 7 from table 17 while sorting the pile.
 *
 * Drawn on a 105-unit-wide canvas at the proportion `planSheet` reserves for
 * it, so the sheet can scale it into a cell without distortion.
 */

export interface CompactCellOptions {
  /** The permanent /t/<token> URL this table's code resolves to. */
  url: string;
  tableLabel: string;
  accent?: string;
}

const W = 105;
const H = W * CELL_ASPECT.compact;

export async function buildCompactCellSvg(opts: CompactCellOptions): Promise<string> {
  const accent = opts.accent ?? "#9A6700";

  const qrSize = 84;
  const qrX = (W - qrSize) / 2;
  const qrY = 8;
  const d = await qrPath(opts.url, { x: qrX, y: qrY, size: qrSize });

  const label = escapeXml(truncate(opts.tableLabel, 18));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${round(H)}mm"
     viewBox="0 0 ${W} ${round(H)}" role="img" aria-label="QR code for ${label}">
  <rect width="${W}" height="${round(H)}" fill="#FFFFFF"/>

  <path d="${d}" fill="#111111" shape-rendering="crispEdges"/>

  <text x="${W / 2}" y="${round(qrY + qrSize + 14)}" text-anchor="middle"
        font-family="Helvetica, Arial, sans-serif" font-size="8.5" font-weight="600"
        fill="${accent}">${label}</text>
</svg>`;
}
