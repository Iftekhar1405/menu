/** Axis and layout arithmetic for the Insights charts — kept out of JSX so it can be tested. */

/**
 * Y-axis ticks from 0 to a clean ceiling (1, 2, 2.5 or 5 × a power of ten),
 * three to five steps. An all-zero series still gets an axis.
 */
export function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const rough = max / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough)!;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 1000; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

/**
 * Which x labels to print so they never collide: at most `limit`, evenly
 * spaced, always the first and the last.
 */
export function thinIndices(count: number, limit: number): number[] {
  if (count <= limit) return Array.from({ length: count }, (_, i) => i);
  const every = Math.ceil((count - 1) / (limit - 1));
  const kept: number[] = [];
  for (let i = 0; i < count - 1; i += every) kept.push(i);
  if (kept.at(-1) !== count - 1) {
    // Drop the one before last if it would sit on top of the final label.
    if (count - 1 - kept.at(-1)! < every / 2) kept.pop();
    kept.push(count - 1);
  }
  return kept;
}

/** 0 = empty, 1..4 = sequential steps of the accent, 4 = the busiest cell. */
export function heatStep(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.max(1, Math.ceil((value / max) * 4));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "3 Oct" for a day or week start, "Oct" for a month. */
export function shortDate(iso: string, bucket: "day" | "week" | "month"): string {
  const [, m, d] = iso.split("-").map(Number) as [number, number, number];
  return bucket === "month" ? MONTHS[m - 1]! : `${d} ${MONTHS[m - 1]}`;
}
