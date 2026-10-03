import { cx } from "@/components/ui";

export function pctChange(current: string, previous: string): number | null {
  const p = Number(previous);
  if (!p) return null;
  return Math.round(((Number(current) - p) / p) * 1000) / 10;
}

export function KpiTile({ label, value, current, previous, warn }: {
  label: string;
  value: string;
  current?: string;
  previous?: string;
  warn?: boolean;
}) {
  const change = current !== undefined && previous !== undefined ? pctChange(current, previous) : null;
  return (
    <div className={cx("rounded-2xl border px-4 py-3.5", warn ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-line bg-surface")}>
      <p className="text-[12.5px] text-muted">{label}</p>
      <p className="tnum mt-1 text-[24px] font-semibold leading-none tracking-tight">{value}</p>
      {change !== null && (
        <p className="tnum mt-1.5 text-[12.5px] text-muted">
          <span aria-hidden="true">{change >= 0 ? "▲" : "▼"}</span> {Math.abs(change)}%
          <span className="sr-only">{change >= 0 ? "up" : "down"}</span> vs previous period
        </p>
      )}
    </div>
  );
}
