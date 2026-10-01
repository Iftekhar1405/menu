import { escapeXml, qrPath, round, truncate } from "./qr-path";

/**
 * The QR card an owner downloads and prints.
 *
 * Laid out in millimetres on an A6 canvas (105 x 148mm) so the vector output
 * hands a print vendor real physical dimensions rather than pixels that have
 * to be reinterpreted. The same asset serves a table tent today and the PVC
 * card sold later, which is why this is composed as SVG and rasterised from
 * it, rather than drawn as pixels and upscaled.
 *
 * Design follows the same restraint as the rest of the product: one accent,
 * hierarchy from type and space, nothing decorative competing with the thing
 * people actually need to point a camera at.
 */

export interface CardOptions {
  businessName: string;
  /** The permanent public URL the QR encodes. */
  url: string;
  /** Data URI. Omitted when the business has no logo. */
  logoDataUri?: string | null;
  accent?: string;
  /** Shown under the QR. Table tents say "Scan for menu". */
  caption?: string;
  /** Set for a per-table card. Printed large enough to sort a stack by. */
  tableLabel?: string | null;
}

const W = 105;
const H = 148;
const WATERMARK = "menu.irad.solutions";
const WM_SIZE = 3.1;
const WM_TRACK = 0.2;
const WM_MARK = 3.6;
const WM_GAP = 1.3;

export async function buildCardSvg(opts: CardOptions): Promise<string> {
  const accent = opts.accent ?? "#9A6700";
  const caption =
    opts.caption ?? (opts.tableLabel ? "Scan to order" : "Scan for menu");

  const nameY = nameYFor(opts);
  const tableY = nameY + 3;
  const qrSize = 62;
  const qrX = (W - qrSize) / 2;
  // A table label has its own line between the business name and QR. With a
  // logo, the old fixed y=52 placed the code through that line.
  const qrY = opts.tableLabel ? nameY + 18 : 52;
  const d = await qrPath(opts.url, { x: qrX, y: qrY, size: qrSize });

  const tableBlock = opts.tableLabel
    ? `<rect x="${W / 2 - 16}" y="${tableY}" width="32" height="11" rx="5.5"
             fill="${accent}" opacity="0.10"/>
       <text x="${W / 2}" y="${tableY + 7.5}" text-anchor="middle"
             font-family="Helvetica, Arial, sans-serif" font-size="6.2" font-weight="600"
             fill="${accent}">${escapeXml(truncate(opts.tableLabel, 12))}</text>`
    : "";

  const logoBlock = opts.logoDataUri
    ? `<clipPath id="logoClip"><circle cx="${W / 2}" cy="24" r="11"/></clipPath>
     <image href="${opts.logoDataUri}" x="${W / 2 - 11}" y="13" width="22" height="22"
            preserveAspectRatio="xMidYMid slice" clip-path="url(#logoClip)"/>`
    : "";

  /*
   * The watermark is a mark and a name laid out as one centred group. SVG
   * cannot measure text, so the width is estimated from the character count —
   * accurate enough that a fraction of a millimetre either way is invisible at
   * this size, and far better than centring the two independently and having
   * them overlap.
   */
  const wmWidth =
    WATERMARK.length * WM_SIZE * 0.5 + (WATERMARK.length - 1) * WM_TRACK;
  const wmGroupX = (W - (WM_MARK + WM_GAP + wmWidth)) / 2;
  const wmMarkX = wmGroupX;
  const wmTextX = wmGroupX + WM_MARK + WM_GAP;
  const wmBaseline = qrY + qrSize + 19;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm"
     viewBox="0 0 ${W} ${H}" role="img" aria-label="QR code for ${escapeXml(opts.businessName)}">
  <rect width="${W}" height="${H}" fill="#FFFFFF"/>
  <rect x="3" y="3" width="${W - 6}" height="${H - 6}" rx="4"
        fill="none" stroke="${accent}" stroke-width="0.4" opacity="0.35"/>

  ${logoBlock}

  <text x="${W / 2}" y="${nameY}" text-anchor="middle"
        font-family="Helvetica, Arial, sans-serif" font-size="7" font-weight="600"
        fill="#1C1C1E">${escapeXml(truncate(opts.businessName, 26))}</text>

  ${tableBlock}

  <path d="${d}" fill="#111111" shape-rendering="crispEdges"/>

  <text x="${W / 2}" y="${qrY + qrSize + 12}" text-anchor="middle"
        font-family="Helvetica, Arial, sans-serif" font-size="5" font-weight="500"
        letter-spacing="0.3" fill="${accent}">${escapeXml(caption)}</text>

  ${markGlyph(wmMarkX, wmBaseline - WM_MARK + 0.85, WM_MARK)}
  <text x="${round(wmTextX)}" y="${round(wmBaseline)}" text-anchor="start"
        font-family="Helvetica, Arial, sans-serif" font-size="${WM_SIZE}"
        letter-spacing="${WM_TRACK}" fill="#1C1C1E" opacity="0.45">${WATERMARK}</text>
</svg>`;
}

/**
 * The mark, drawn at an arbitrary size and position on the card.
 *
 * Redrawn here in SVG primitives rather than referenced: this file is
 * rasterised by resvg and embedded into PDFs for print vendors, and an
 * external <image> href would resolve to nothing in both. The geometry is the
 * same 32-unit grid as public/mark.svg, scaled.
 */
function markGlyph(x: number, y: number, size: number): string {
  const u = size / 32;
  const r = (n: number) => (n * u).toFixed(3);
  return `<g transform="translate(${x.toFixed(3)} ${y.toFixed(3)})" opacity="0.45">
    <rect width="${r(32)}" height="${r(32)}" rx="${r(8)}" fill="#1C1C1E"/>
    <rect x="${r(6.25)}" y="${r(6.25)}" width="${r(12.5)}" height="${r(12.5)}" rx="${r(3.75)}"
          fill="none" stroke="#FFFFFF" stroke-width="${r(2.5)}"/>
    <rect x="${r(10.5)}" y="${r(10.5)}" width="${r(4)}" height="${r(4)}" rx="${r(1.25)}" fill="#FFFFFF"/>
    <rect x="${r(20.5)}" y="${r(20.5)}" width="${r(6)}" height="${r(6)}" rx="${r(2)}" fill="#FFFFFF"/>
  </g>`;
}

function nameYFor(opts: CardOptions): number {
  return opts.logoDataUri ? 45 : 34;
}



