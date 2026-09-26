import type { SheetPlan } from "@menu/shared";
import { BadRequestException } from "@nestjs/common";
import PDFDocument from "pdfkit";
import SVGtoPDF from "svg-to-pdfkit";

/** PostScript points per millimetre. Everything above this file is in mm. */
export const MM_TO_PT = 72 / 25.4;

/** Light enough not to compete with the cards, dark enough to cut along. */
const GUIDE_COLOUR = "#D4D4D4";
const GUIDE_WIDTH_PT = 0.25;

/**
 * Lay prepared cell SVGs onto printable pages.
 *
 * Vector throughout — the same reason the single card is a real PDF rather
 * than a PNG in a wrapper. An owner printing at home and a vendor running
 * these on a press both get geometry rather than pixels, and a QR that was
 * never resampled is a QR that always scans.
 *
 * Takes a plan rather than options so the page count an owner was shown
 * before clicking download is the page count they get.
 */
export async function renderSheetPdf(cells: string[], plan: SheetPlan): Promise<Buffer> {
  if (cells.length === 0) {
    throw new BadRequestException("Select at least one table to print — no tables were given.");
  }

  const size: [number, number] = [plan.pageW * MM_TO_PT, plan.pageH * MM_TO_PT];

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size, margin: 0, autoFirstPage: false });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      cells.forEach((svg, index) => {
        // A page is opened by the cell that lands in its first slot, so an
        // exact fit cannot leave a blank page hanging off the end.
        if (index % plan.perPage === 0) doc.addPage({ size, margin: 0 });

        const { x, y } = plan.cellAt(index);
        const left = x * MM_TO_PT;
        const top = y * MM_TO_PT;
        const w = plan.cellW * MM_TO_PT;
        const h = plan.cellH * MM_TO_PT;

        doc
          .save()
          .lineWidth(GUIDE_WIDTH_PT)
          .strokeColor(GUIDE_COLOUR)
          .rect(left, top, w, h)
          .stroke()
          .restore();

        // svg-to-pdfkit ignores its width/height options for an SVG that
        // declares its own size: a cell renders at its natural 105mm and
        // spills across its neighbours. Scaling the canvas underneath is the
        // part we can control — so work out what fraction of its natural
        // width this cell is, and shrink to that.
        doc.save().translate(left, top).scale(cellScale(svg, w));
        SVGtoPDF(doc, svg, 0, 0, { assumePt: false });
        doc.restore();
      });
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * How far to shrink a cell SVG so it fills a cell `cellWidthPt` points wide.
 *
 * Both cell builders lay out in millimetres and say so on the root element.
 * Reading it back rather than assuming 105 means the sheet keeps working if
 * either canvas is ever redrawn at a different size.
 */
export function cellScale(svg: string, cellWidthPt: number): number {
  const m = /<svg[^>]*\swidth="([\d.]+)mm"/.exec(svg);
  const naturalMm = m ? Number(m[1]) : NaN;
  if (!Number.isFinite(naturalMm) || naturalMm <= 0) {
    throw new Error("A cell SVG must declare its width in millimetres");
  }
  return cellWidthPt / (naturalMm * MM_TO_PT);
}
