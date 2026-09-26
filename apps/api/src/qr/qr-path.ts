import QRCode from "qrcode";

/**
 * The dark modules of a QR code as a single SVG path.
 *
 * One path beats thousands of <rect> elements: far smaller output and much
 * faster to rasterise. Shared by the full card and the compact cell so the
 * two can never disagree about error correction or module geometry.
 *
 * Error-correction level H tolerates roughly 30% damage, which is what makes
 * a printed card survive a centre logo, a scuffed table, and cheap printing.
 */
export async function qrPath(
  url: string,
  box: { x: number; y: number; size: number },
): Promise<string> {
  const qr = QRCode.create(url, { errorCorrectionLevel: "H" });
  const modules = qr.modules;
  const count = modules.size;
  const module = box.size / count;

  let d = "";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (!modules.get(row, col)) continue;
      const x = box.x + col * module;
      const y = box.y + row * module;
      d += `M${round(x)} ${round(y)}h${round(module)}v${round(module)}h-${round(module)}z`;
    }
  }
  return d;
}

export function round(n: number): string {
  return n.toFixed(3).replace(/\.?0+$/, "");
}

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
    };
    return map[c] ?? c;
  });
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
