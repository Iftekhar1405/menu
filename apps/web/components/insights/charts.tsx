"use client";

import { useState } from "react";
import { cx } from "@/components/ui";
import { heatStep, niceTicks, shortDate, thinIndices } from "./chart-math";

/*
 * The Insights charts. Plain HTML/CSS rather than SVG: text stays crisp at
 * any width and the layout reflows on a phone without a viewBox fighting it.
 *
 * Every chart is a single series in the tenant's accent — the accent is the
 * only colour in the interface — so identity never depends on telling hues
 * apart, and there is no categorical palette to validate. Magnitude is
 * length; the heatmap is one hue stepped light to dark.
 *
 * Marks: bars at most 24px thick with a 4px rounded data end, square at the
 * baseline; hairline, recessive gridlines; values and labels in text tokens,
 * never the accent. Each mark is a focusable hit target with a tooltip, and
 * each chart carries a screen-reader table of its numbers.
 */

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function Tip({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 w-max max-w-[220px] -translate-x-1/2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12.5px] leading-snug text-ink shadow-lift"
    >
      {children}
    </div>
  );
}

function SrTable({ caption, head, rows }: { caption: string; head: string[]; rows: (string | number)[][] }) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>{head.map((h) => <th key={h} scope="col">{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}

/** Gross sales per day, week or month. */
export function BarSeries({
  points,
  bucket,
  format,
  label,
}: {
  points: { start: string; gross: string; bills: number }[];
  bucket: "day" | "week" | "month";
  format: (v: string) => string;
  label: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const values = points.map((p) => Number(p.gross));
  const ticks = niceTicks(Math.max(0, ...values));
  const top = ticks.at(-1)!;
  const shown = new Set(thinIndices(points.length, 8));
  const when = (p: { start: string }) => (bucket === "week" ? `Week of ${shortDate(p.start, "day")}` : shortDate(p.start, bucket));

  return (
    <figure aria-label={label}>
      {/* Top padding: the highest tick label is centred on the top gridline
          and would otherwise ride up into the card heading. */}
      <div className="flex gap-2 pt-3">
        {/* Y axis: clean ticks, muted, right-aligned. */}
        <div className="relative h-[200px] w-14 shrink-0 text-right text-[11.5px] text-faint tnum" aria-hidden="true">
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 -translate-y-1/2" style={{ bottom: `${(t / top) * 100}%` }}>
              {format(String(t))}
            </span>
          ))}
        </div>
        <div className="relative h-[200px] min-w-0 flex-1">
          {ticks.map((t) => (
            <div key={t} aria-hidden="true" className="absolute inset-x-0 border-t border-line" style={{ bottom: `${(t / top) * 100}%` }} />
          ))}
          <div className="absolute inset-0 flex items-end gap-[2px]">
            {points.map((p, i) => (
              <button
                key={p.start}
                type="button"
                aria-label={`${when(p)}: ${format(p.gross)}, ${p.bills} bills`}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                className="relative flex h-full min-w-0 flex-1 items-end justify-center focus:outline-none"
              >
                <span
                  className={cx(
                    "block w-full max-w-[24px] rounded-t-[4px] bg-[var(--accent)] transition-opacity",
                    hover !== null && hover !== i && "opacity-60",
                  )}
                  style={{ height: `${(Number(p.gross) / top) * 100}%`, minHeight: Number(p.gross) > 0 ? 2 : 0 }}
                />
                {hover === i && (
                  <Tip>
                    <strong className="tnum block">{format(p.gross)}</strong>
                    <span className="text-muted">{when(p)} · {p.bills} bill{p.bills === 1 ? "" : "s"}</span>
                  </Tip>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="ml-16 mt-1.5 flex gap-[2px] text-[11.5px] text-faint" aria-hidden="true">
        {points.map((p, i) => (
          <span key={p.start} className="min-w-0 flex-1 text-center">
            {shown.has(i) ? <span className="whitespace-nowrap">{shortDate(p.start, bucket === "month" ? "month" : "day")}</span> : null}
          </span>
        ))}
      </div>
      <SrTable caption={label} head={["Period", "Gross", "Bills"]} rows={points.map((p) => [when(p), format(p.gross), p.bills])} />
    </figure>
  );
}

/** Ranked horizontal bars: tables, categories, payment mix. */
export function HBars({
  rows,
  format,
  label,
  showShare = false,
}: {
  rows: { label: string; value: string; sub?: string }[];
  format: (v: string) => string;
  label: string;
  /** Print each row's share of the total — for a part-to-whole like payment mix. */
  showShare?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const total = rows.reduce((a, r) => a + Number(r.value), 0);
  const max = Math.max(0, ...rows.map((r) => Number(r.value)));
  if (!rows.length || max === 0) {
    return <p className="py-6 text-center text-[13.5px] text-faint">Nothing in this period</p>;
  }
  return (
    <figure aria-label={label}>
      <ul className="space-y-2.5">
        {rows.map((r, i) => (
          <li
            key={r.label}
            className="relative"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          >
            <div className="mb-1 flex items-baseline justify-between gap-3 text-[13.5px]">
              <span className="min-w-0 truncate">{r.label}</span>
              <span className="tnum shrink-0 text-muted">
                {format(r.value)}
                {showShare && total > 0 && <span className="ml-1.5 text-faint">{Math.round((Number(r.value) / total) * 100)}%</span>}
              </span>
            </div>
            <div className="h-3 w-full">
              <div
                className={cx("h-full rounded-r-[4px] bg-[var(--accent)] transition-opacity", hover !== null && hover !== i && "opacity-60")}
                style={{ width: `${(Number(r.value) / max) * 100}%`, minWidth: Number(r.value) > 0 ? 2 : 0 }}
              />
            </div>
            {r.sub && <p className="mt-0.5 text-[12px] text-faint">{r.sub}</p>}
          </li>
        ))}
      </ul>
      <SrTable caption={label} head={["", "Value"]} rows={rows.map((r) => [r.label, format(r.value)])} />
    </figure>
  );
}

/** Bills by local weekday × hour; one hue, light to dark. */
export function Heatmap({
  cells,
  format,
  label,
}: {
  cells: { dow: number; hour: number; bills: number; gross: string }[];
  format: (v: string) => string;
  label: string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  if (!cells.length) return <p className="py-6 text-center text-[13.5px] text-faint">Nothing in this period</p>;

  // Only the span of hours the business actually trades in — a cafe open
  // 8 to 10 has no use for sixteen empty columns.
  const hours = cells.map((c) => c.hour);
  const from = Math.min(...hours);
  const to = Math.max(...hours);
  const cols = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const max = Math.max(...cells.map((c) => c.bills));
  const at = new Map(cells.map((c) => [`${c.dow}:${c.hour}`, c]));
  const alpha = [0, 0.18, 0.4, 0.65, 1];

  return (
    <figure aria-label={label} className="overflow-x-auto">
      <div className="inline-grid gap-[2px]" style={{ gridTemplateColumns: `2.5rem repeat(${cols.length}, minmax(18px, 1fr))` }}>
        <span aria-hidden="true" />
        {cols.map((h) => (
          <span key={h} aria-hidden="true" className="tnum text-center text-[10.5px] text-faint">
            {h % 3 === 0 || cols.length <= 8 ? h : ""}
          </span>
        ))}
        {DAYS.map((day, d) => (
          <div key={day} className="contents">
            <span className="text-[11.5px] leading-[18px] text-faint">{day}</span>
            {cols.map((h) => {
              const key = `${d + 1}:${h}`;
              const c = at.get(key);
              const step = heatStep(c?.bills ?? 0, max);
              return (
                <button
                  key={key}
                  type="button"
                  aria-label={`${day} ${h}:00 — ${c?.bills ?? 0} bills${c ? `, ${format(c.gross)}` : ""}`}
                  onMouseEnter={() => setHover(key)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(key)}
                  onBlur={() => setHover(null)}
                  className="relative h-[18px] rounded-[3px] focus:outline-none focus-visible:ring-2 focus-visible:ring-ink"
                  style={{ background: step ? `rgba(var(--accent-rgb), ${alpha[step]})` : "var(--raised)" }}
                >
                  {hover === key && (
                    <Tip>
                      <strong className="tnum block">{c?.bills ?? 0} bill{c?.bills === 1 ? "" : "s"}</strong>
                      <span className="text-muted">{day} {h}:00{c ? ` · ${format(c.gross)}` : ""}</span>
                    </Tip>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-1.5 text-[11.5px] text-faint" aria-hidden="true">
        <span>Fewer</span>
        {alpha.slice(1).map((a) => (
          <span key={a} className="h-2.5 w-4 rounded-[2px]" style={{ background: `rgba(var(--accent-rgb), ${a})` }} />
        ))}
        <span>More bills</span>
      </div>
      <SrTable
        caption={label}
        head={["Day", "Hour", "Bills", "Gross"]}
        rows={cells.map((c) => [DAYS[c.dow - 1]!, `${c.hour}:00`, c.bills, format(c.gross)])}
      />
    </figure>
  );
}

/** How many ratings at each star level. */
export function Distribution({ counts }: { counts: number[] }) {
  const max = Math.max(0, ...counts);
  if (max === 0) return <p className="py-6 text-center text-[13.5px] text-faint">No ratings in this period</p>;
  return (
    <ul className="space-y-1.5" aria-label="Ratings by stars">
      {[...counts].map((n, i) => ({ n, stars: i + 1 })).reverse().map(({ n, stars }) => (
        <li key={stars} className="flex items-center gap-2 text-[13px]">
          <span className="tnum w-6 text-muted">{stars}★</span>
          <div className="h-2.5 flex-1">
            <div className="h-full rounded-r-[4px] bg-[var(--accent)]" style={{ width: `${(n / max) * 100}%`, minWidth: n ? 2 : 0 }} />
          </div>
          <span className="tnum w-8 text-right text-muted">{n}</span>
        </li>
      ))}
    </ul>
  );
}
