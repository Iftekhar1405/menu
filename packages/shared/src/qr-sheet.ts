/**
 * Where each QR cell lands on a printed sheet.
 *
 * Shared rather than living in the API because the tables page shows the
 * owner "9 per page · 3 pages" as they change the dropdowns, and a preview
 * computed from different arithmetic than the PDF is a preview that lies.
 *
 * Everything here is millimetres. The API converts to PostScript points at
 * the moment it draws; nothing above that layer should think in points.
 */

export const SHEET_PAPERS = ["a4", "a3", "letter"] as const;
export type SheetPaper = (typeof SHEET_PAPERS)[number];

export const SHEET_ORIENTATIONS = ["portrait", "landscape"] as const;
export type SheetOrientation = (typeof SHEET_ORIENTATIONS)[number];

export const SHEET_SIZES = ["small", "medium", "large"] as const;
export type SheetSize = (typeof SHEET_SIZES)[number];

export const SHEET_STYLES = ["card", "compact"] as const;
export type SheetStyle = (typeof SHEET_STYLES)[number];

/** Portrait dimensions. Landscape swaps them. */
export const PAPER_MM: Record<SheetPaper, { w: number; h: number }> = {
  a4: { w: 210, h: 297 },
  a3: { w: 297, h: 420 },
  letter: { w: 215.9, h: 279.4 },
};

/** Kept clear of the page edge, since few desktop printers can reach it. */
export const SHEET_MARGIN_MM = 10;

/** Between cells. Enough to get scissors in without wasting a column. */
export const SHEET_GUTTER_MM = 4;

/**
 * Cell height as a multiple of its width.
 *
 * `card` is A6 — the same 105 x 148mm proportion `buildCardSvg` already
 * draws, so a tiled card is the card an owner downloads singly, only
 * smaller. `compact` is near-square because it carries a QR and one line
 * of label and nothing else.
 */
export const CELL_ASPECT: Record<SheetStyle, number> = {
  card: 148 / 105,
  compact: 1.12,
};

/** The three named widths the print panel offers. */
export const CELL_WIDTH_MM: Record<SheetSize, number> = {
  small: 52.5,
  medium: 74,
  large: 105,
};

export interface SheetOptions {
  paper: SheetPaper;
  orientation: SheetOrientation;
  size: SheetSize;
  style: SheetStyle;
}

export interface SheetPlan extends SheetOptions {
  pageW: number;
  pageH: number;
  cellW: number;
  cellH: number;
  cols: number;
  rows: number;
  perPage: number;
  pages: number;
  /** Top-left of the grid block, already centred on the page. */
  originX: number;
  originY: number;
  /** Top-left of the nth cell, counting left to right then top to bottom. */
  cellAt(index: number): { x: number; y: number };
}

/**
 * How many cells fit across `span`, given each needs `cell` plus a gutter
 * after it — except the last, which does not. Adding one gutter to the span
 * before dividing is the tidy way to say that.
 */
function fitAcross(span: number, cell: number): number {
  return Math.floor((span + SHEET_GUTTER_MM) / (cell + SHEET_GUTTER_MM));
}

export function planSheet(opts: SheetOptions, count: number): SheetPlan {
  const paper = PAPER_MM[opts.paper];
  const portrait = opts.orientation === "portrait";
  const pageW = portrait ? paper.w : paper.h;
  const pageH = portrait ? paper.h : paper.w;

  const cellW = CELL_WIDTH_MM[opts.size];
  const cellH = cellW * CELL_ASPECT[opts.style];

  const cols = fitAcross(pageW - SHEET_MARGIN_MM * 2, cellW);
  const rows = fitAcross(pageH - SHEET_MARGIN_MM * 2, cellH);

  // NaN-safe on purpose: an unknown size yields NaN rather than 0, and
  // `NaN >= 1` is false, so this catches both without a separate check.
  if (!(cols >= 1) || !(rows >= 1)) {
    throw new Error(
      `A ${opts.size} ${opts.style} cell does not fit a ${opts.orientation} ${opts.paper} page.`,
    );
  }

  const perPage = cols * rows;
  const blockW = cols * cellW + (cols - 1) * SHEET_GUTTER_MM;
  const blockH = rows * cellH + (rows - 1) * SHEET_GUTTER_MM;
  const originX = (pageW - blockW) / 2;
  const originY = (pageH - blockH) / 2;

  return {
    ...opts,
    pageW,
    pageH,
    cellW,
    cellH,
    cols,
    rows,
    perPage,
    pages: Math.ceil(count / perPage),
    originX,
    originY,
    cellAt(index: number) {
      const onPage = index % perPage;
      return {
        x: originX + (onPage % cols) * (cellW + SHEET_GUTTER_MM),
        y: originY + Math.floor(onPage / cols) * (cellH + SHEET_GUTTER_MM),
      };
    },
  };
}
