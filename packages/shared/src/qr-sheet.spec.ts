import { describe, expect, it } from "vitest";
import { CELL_ASPECT, PAPER_MM, SHEET_GUTTER_MM, SHEET_MARGIN_MM, planSheet } from "./qr-sheet";

const A4_CARD_MEDIUM = {
  paper: "a4",
  orientation: "portrait",
  size: "medium",
  style: "card",
} as const;

describe("planSheet", () => {
  it("fits nine small cards on a portrait A4 page", () => {
    const plan = planSheet({ ...A4_CARD_MEDIUM, size: "small" }, 9);

    expect(plan.cols).toBe(3);
    expect(plan.rows).toBe(3);
    expect(plan.perPage).toBe(9);
  });

  it("fits four medium cards on a portrait A4 page", () => {
    const plan = planSheet(A4_CARD_MEDIUM, 4);

    expect(plan.cols).toBe(2);
    expect(plan.rows).toBe(2);
    expect(plan.perPage).toBe(4);
  });

  it("fits only one large card on a portrait A4 page", () => {
    // An A6 card is a quarter of A4 on paper, but a 10mm margin leaves
    // 190mm of width — not the 214mm two 105mm cards plus a gutter need.
    const plan = planSheet({ ...A4_CARD_MEDIUM, size: "large" }, 4);

    expect(plan.perPage).toBe(1);
    expect(plan.pages).toBe(4);
  });

  it("fits two large cards per page once A4 is turned landscape", () => {
    const plan = planSheet(
      { ...A4_CARD_MEDIUM, size: "large", orientation: "landscape" },
      4,
    );

    expect(plan.cols).toBe(2);
    expect(plan.rows).toBe(1);
    expect(plan.pages).toBe(2);
  });

  it("fits twenty small cards on a portrait A3 page", () => {
    const plan = planSheet({ ...A4_CARD_MEDIUM, paper: "a3", size: "small" }, 20);

    expect(plan.cols).toBe(4);
    expect(plan.rows).toBe(5);
    expect(plan.perPage).toBe(20);
  });

  it("fits more compact cells than cards at the same width", () => {
    const cards = planSheet({ ...A4_CARD_MEDIUM, size: "small" }, 12);
    const compact = planSheet({ ...A4_CARD_MEDIUM, size: "small", style: "compact" }, 12);

    expect(compact.cols).toBe(cards.cols);
    expect(compact.rows).toBeGreaterThan(cards.rows);
    expect(compact.perPage).toBe(12);
  });

  it("keeps card cells at the A6 proportion the printed card already uses", () => {
    const plan = planSheet(A4_CARD_MEDIUM, 1);

    expect(plan.cellW).toBeCloseTo(74, 5);
    expect(plan.cellH / plan.cellW).toBeCloseTo(CELL_ASPECT.card, 5);
  });

  it("centres the grid block on the page", () => {
    const plan = planSheet(A4_CARD_MEDIUM, 4);
    const blockW = plan.cols * plan.cellW + (plan.cols - 1) * SHEET_GUTTER_MM;
    const blockH = plan.rows * plan.cellH + (plan.rows - 1) * SHEET_GUTTER_MM;

    expect(plan.originX).toBeCloseTo((PAPER_MM.a4.w - blockW) / 2, 5);
    expect(plan.originY).toBeCloseTo((PAPER_MM.a4.h - blockH) / 2, 5);
  });

  it("never lets the grid block start inside the page margin", () => {
    const plan = planSheet({ ...A4_CARD_MEDIUM, size: "large" }, 1);

    expect(plan.originX).toBeGreaterThanOrEqual(SHEET_MARGIN_MM);
    expect(plan.originY).toBeGreaterThanOrEqual(SHEET_MARGIN_MM);
  });

  it("rounds a part-full last page up", () => {
    const plan = planSheet({ ...A4_CARD_MEDIUM, size: "small" }, 10);

    expect(plan.perPage).toBe(9);
    expect(plan.pages).toBe(2);
  });

  it("reports no pages when nothing is selected", () => {
    expect(planSheet(A4_CARD_MEDIUM, 0).pages).toBe(0);
  });

  it("refuses a cell too large to fit the page rather than returning an empty grid", () => {
    // Not reachable through the exported unions, but the API takes this
    // shape from JSON. A zero-column grid would divide by zero downstream.
    expect(() =>
      planSheet({ ...A4_CARD_MEDIUM, size: "enormous" as "large" }, 1),
    ).toThrow(/does not fit/i);
  });

  it("swaps width and height for landscape", () => {
    const plan = planSheet({ ...A4_CARD_MEDIUM, orientation: "landscape" }, 1);

    expect(plan.pageW).toBeCloseTo(PAPER_MM.a4.h, 5);
    expect(plan.pageH).toBeCloseTo(PAPER_MM.a4.w, 5);
  });

  it("gives every cell its own position, left to right then top to bottom", () => {
    const plan = planSheet(A4_CARD_MEDIUM, 4);

    expect(plan.cellAt(0)).toEqual({ x: plan.originX, y: plan.originY });
    expect(plan.cellAt(1)).toEqual({
      x: plan.originX + plan.cellW + SHEET_GUTTER_MM,
      y: plan.originY,
    });
    expect(plan.cellAt(2)).toEqual({
      x: plan.originX,
      y: plan.originY + plan.cellH + SHEET_GUTTER_MM,
    });
  });

  it("wraps the cell index back to the top of the next page", () => {
    const plan = planSheet(A4_CARD_MEDIUM, 8);

    // Index 4 is the first cell of page two, so it sits where index 0 does.
    expect(plan.cellAt(4)).toEqual(plan.cellAt(0));
  });
});
