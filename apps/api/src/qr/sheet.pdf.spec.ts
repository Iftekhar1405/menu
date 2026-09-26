import { planSheet } from "@menu/shared";
import { describe, expect, it } from "vitest";
import { buildCompactCellSvg } from "./compact.svg";
import { MM_TO_PT, cellScale, renderSheetPdf } from "./sheet.pdf";

async function cells(n: number): Promise<string[]> {
  return Promise.all(
    Array.from({ length: n }, (_, i) =>
      buildCompactCellSvg({
        url: `http://localhost:3000/t/token${i}`,
        tableLabel: `Table ${i + 1}`,
      }),
    ),
  );
}

/** pdfkit writes the page tree uncompressed, so /Count is readable. */
function pageCount(pdf: Buffer): number {
  const m = /\/Count (\d+)/.exec(pdf.toString("latin1"));
  if (!m) throw new Error("no page tree in the PDF");
  return Number(m[1]);
}

function mediaBox(pdf: Buffer): { w: number; h: number } {
  const m = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(pdf.toString("latin1"));
  if (!m) throw new Error("no MediaBox in the PDF");
  return { w: Number(m[1]), h: Number(m[2]) };
}

const A4_MEDIUM = {
  paper: "a4",
  orientation: "portrait",
  size: "medium",
  style: "compact",
} as const;

describe("renderSheetPdf", () => {
  it("writes a PDF", async () => {
    const plan = planSheet(A4_MEDIUM, 1);
    const pdf = await renderSheetPdf(await cells(1), plan);

    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("fits a full page of cells onto one page", async () => {
    const plan = planSheet(A4_MEDIUM, 6);

    expect(plan.perPage).toBe(6);
    expect(pageCount(await renderSheetPdf(await cells(6), plan))).toBe(1);
  });

  it("starts a new page once the current one is full", async () => {
    const plan = planSheet(A4_MEDIUM, 7);

    expect(pageCount(await renderSheetPdf(await cells(7), plan))).toBe(2);
  });

  it("does not leave a trailing blank page on an exact fit", async () => {
    const plan = planSheet(A4_MEDIUM, 12);

    expect(pageCount(await renderSheetPdf(await cells(12), plan))).toBe(2);
  });

  it("sizes the page to the chosen paper, in points", async () => {
    const plan = planSheet(A4_MEDIUM, 1);
    const box = mediaBox(await renderSheetPdf(await cells(1), plan));

    expect(box.w).toBeCloseTo(210 * MM_TO_PT, 1);
    expect(box.h).toBeCloseTo(297 * MM_TO_PT, 1);
  });

  it("turns the page over for landscape", async () => {
    const plan = planSheet({ ...A4_MEDIUM, orientation: "landscape" }, 1);
    const box = mediaBox(await renderSheetPdf(await cells(1), plan));

    expect(box.w).toBeCloseTo(297 * MM_TO_PT, 1);
    expect(box.h).toBeCloseTo(210 * MM_TO_PT, 1);
  });

  it("produces no pages at all for an empty selection", async () => {
    const plan = planSheet(A4_MEDIUM, 0);

    await expect(renderSheetPdf([], plan)).rejects.toThrow(/no tables/i);
  });
});

/**
 * The scale is the whole reason a sheet is not just nine overlapping cards.
 * svg-to-pdfkit renders a cell at its declared 105mm whatever width option
 * it is handed, so this factor is what actually makes it fit.
 */
describe("cellScale", () => {
  const card105 = '<svg xmlns="http://www.w3.org/2000/svg" width="105mm" height="148mm" viewBox="0 0 105 148">';

  it("halves a 105mm card to fill a 52.5mm cell", () => {
    expect(cellScale(card105, 52.5 * MM_TO_PT)).toBeCloseTo(0.5, 6);
  });

  it("leaves a card alone when the cell is its natural size", () => {
    expect(cellScale(card105, 105 * MM_TO_PT)).toBeCloseTo(1, 6);
  });

  it("scales a compact cell by its own width, not the card's", async () => {
    const compact = await buildCompactCellSvg({ url: "http://x/t/a", tableLabel: "1" });

    expect(cellScale(compact, 52.5 * MM_TO_PT)).toBeCloseTo(0.5, 6);
  });

  it("refuses an SVG that does not declare a width it can scale from", () => {
    expect(() => cellScale('<svg viewBox="0 0 105 148">', 100)).toThrow(/millimetres/i);
  });
});
