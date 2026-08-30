import QRCode from "qrcode";

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
}

const W = 105;
const H = 148;
const WATERMARK = "menu.irad.solutions";

export async function buildCardSvg(opts: CardOptions): Promise<string> {
  const accent = opts.accent ?? "#1D6F5C";
  const caption = opts.caption ?? "Scan for menu";

  // Error-correction level H tolerates roughly 30% damage, which is what
  // makes the card survive a centre logo, a scuffed table, and cheap printing.
  const qr = QRCode.create(opts.url, { errorCorrectionLevel: "H" });
  const modules = qr.modules;
  const count = modules.size;

  const qrSize = 62;
  const qrX = (W - qrSize) / 2;
  const qrY = 52;
  const module = qrSize / count;

  // One path for every dark module beats thousands of <rect> elements: far
  // smaller output and much faster to rasterise.
  let d = "";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (!modules.get(row, col)) continue;
      const x = qrX + col * module;
      const y = qrY + row * module;
      d += `M${round(x)} ${round(y)}h${round(module)}v${round(module)}h-${round(module)}z`;
    }
  }

  const logoBlock = opts.logoDataUri
    ? `<clipPath id="logoClip"><circle cx="${W / 2}" cy="24" r="11"/></clipPath>
     <image href="${opts.logoDataUri}" x="${W / 2 - 11}" y="13" width="22" height="22"
            preserveAspectRatio="xMidYMid slice" clip-path="url(#logoClip)"/>`
    : "";

  const nameY = opts.logoDataUri ? 45 : 34;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm"
     viewBox="0 0 ${W} ${H}" role="img" aria-label="QR code for ${escapeXml(opts.businessName)}">
  <rect width="${W}" height="${H}" fill="#FFFFFF"/>
  <rect x="3" y="3" width="${W - 6}" height="${H - 6}" rx="4"
        fill="none" stroke="${accent}" stroke-width="0.4" opacity="0.35"/>

  ${logoBlock}

  <text x="${W / 2}" y="${nameY}" text-anchor="middle"
        font-family="Helvetica, Arial, sans-serif" font-size="7" font-weight="600"
        fill="#1C1C1E">${escapeXml(truncate(opts.businessName, 26))}</text>

  <path d="${d}" fill="#111111" shape-rendering="crispEdges"/>

  <text x="${W / 2}" y="${qrY + qrSize + 12}" text-anchor="middle"
        font-family="Helvetica, Arial, sans-serif" font-size="5" font-weight="500"
        letter-spacing="0.3" fill="${accent}">${escapeXml(caption)}</text>

  <text x="${W / 2}" y="${qrY + qrSize + 19}" text-anchor="middle"
        font-family="Helvetica, Arial, sans-serif" font-size="3.1"
        letter-spacing="0.2" fill="#1C1C1E" opacity="0.45">${WATERMARK}</text>
</svg>`;
}

function round(n: number): string {
  return n.toFixed(3).replace(/\.?0+$/, "");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
    };
    return map[c] ?? c;
  });
}
