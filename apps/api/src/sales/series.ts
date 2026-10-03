import { addDays, type DateRange } from "@menu/shared";

type Point = { start: string; gross: string; bills: number };

function bucketStart(date: string, bucket: "day" | "week" | "month"): string {
  if (bucket === "day") return date;
  if (bucket === "month") return `${date.slice(0, 7)}-01`;
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((dow + 6) % 7));
}

function nextStart(start: string, bucket: "day" | "week" | "month"): string {
  if (bucket === "day") return addDays(start, 1);
  if (bucket === "week") return addDays(start, 7);
  const [y, m] = start.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

/** A chart with gaps reads as "no data"; a zero reads as "no sales". */
export function fillSeries(points: Point[], range: DateRange, bucket: "day" | "week" | "month"): Point[] {
  const have = new Map(points.map((p) => [p.start, p]));
  const out: Point[] = [];
  for (let s = bucketStart(range.from, bucket); s <= range.to; s = nextStart(s, bucket)) {
    out.push(have.get(s) ?? { start: s, gross: "0", bills: 0 });
  }
  return out;
}
