"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type SheetOrientation,
  type SheetPaper,
  type SheetSize,
  type SheetStyle,
  planSheet,
} from "@menu/shared";
import { ApiError, api, downloadFile } from "@/lib/api-client";
import { useSession } from "@/components/session";
import { useConfirm } from "@/components/confirm";
import { Banner, Button, Empty, Field, Input, Select, cx } from "@/components/ui";

interface TableRow {
  id: string;
  label: string;
  token: string;
  position: number;
  isActive: boolean;
}

type TableStatus = "blank" | "active" | "printed" | "paused";

function tableStatus(t: TableRow): TableStatus {
  if (!t.isActive) return "paused";
  return "blank";
}

const STATUS_COLORS: Record<TableStatus, string> = {
  blank:   "bg-surface border-line text-ink",
  active:  "bg-[#dbeafe] border-[#93c5fd] text-[#1e40af] dark:bg-[rgba(59,130,246,0.18)] dark:border-[rgba(59,130,246,0.3)] dark:text-[#93c5fd]",
  printed: "bg-[#d1fae5] border-[#6ee7b7] text-[#065f46] dark:bg-[rgba(16,185,129,0.18)] dark:border-[rgba(16,185,129,0.3)] dark:text-[#6ee7b7]",
  paused:  "bg-raised border-line text-faint",
};

const STATUS_DOT: Record<TableStatus, string> = {
  blank:   "bg-[#94a3b8]",
  active:  "bg-[#3b82f6]",
  printed: "bg-[#10b981]",
  paused:  "bg-[#f59e0b]",
};

const STATUS_LABEL: Record<TableStatus, string> = {
  blank:   "Blank",
  active:  "Running",
  printed: "Printed",
  paused:  "Paused",
};

export default function TablesPage() {
  const { current } = useSession();
  const confirm = useConfirm();
  const [tables, setTables] = useState<TableRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState("");
  const [range, setRange] = useState({ from: "1", to: "10", prefix: "" });
  const [showRange, setShowRange] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [sheet, setSheet] = useState<{
    paper: SheetPaper;
    orientation: SheetOrientation;
    size: SheetSize;
    style: SheetStyle;
  }>({ paper: "a4", orientation: "portrait", size: "medium", style: "card" });
  const [printing, setPrinting] = useState(false);

  const plan = useMemo(() => {
    if (selected.length === 0) return null;
    try { return planSheet(sheet, selected.length); }
    catch { return null; }
  }, [sheet, selected.length]);

  const load = useCallback(async () => {
    if (!current) return;
    setTables(await api.get<TableRow[]>(`/businesses/${current.id}/tables`));
    setLoading(false);
  }, [current]);

  useEffect(() => { void load(); }, [load]);

  if (!current) return null;

  async function addOne(e: React.FormEvent) {
    e.preventDefault();
    if (!current || !label.trim()) return;
    setError(null);
    try {
      await api.post(`/businesses/${current.id}/tables`, { label: label.trim() });
      setLabel("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add that table.");
    }
  }

  async function addRange(e: React.FormEvent) {
    e.preventDefault();
    if (!current) return;
    setError(null);
    try {
      await api.post(`/businesses/${current.id}/tables/range`, {
        from: Number(range.from),
        to: Number(range.to),
        prefix: range.prefix,
      });
      setShowRange(false);
      setShowAdd(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add those tables.");
    }
  }

  async function write(what: string, run: () => Promise<void>) {
    setError(null);
    try { await run(); }
    catch (err) {
      setError(err instanceof ApiError ? err.message : `Could not ${what}. Try again.`);
      await load().catch(() => undefined);
    }
  }

  async function rename(table: TableRow, next: string) {
    if (!current || next === table.label || !next.trim()) return;
    await write("rename that table", async () => {
      await api.patch(`/businesses/${current.id}/tables/${table.id}`, { label: next.trim() });
      await load();
    });
  }

  async function toggle(table: TableRow) {
    if (!current) return;
    setTables((prev) => prev.map((t) => (t.id === table.id ? { ...t, isActive: !t.isActive } : t)));
    await write(table.isActive ? "pause that table" : "resume that table", async () => {
      await api.patch(`/businesses/${current.id}/tables/${table.id}`, { isActive: !table.isActive });
    });
  }

  async function remove(table: TableRow) {
    if (!current) return;
    const ok = await confirm({
      title: `Delete table ${table.label}?`,
      body: "Any printed card for this table stops working. If you just want to stop taking orders there, pause it instead.",
      confirmLabel: "Delete table",
    });
    if (!ok) return;
    await write("delete that table", async () => {
      await api.del(`/businesses/${current.id}/tables/${table.id}`);
      await load();
    });
  }

  function toggleSelected(id: string) {
    setSelected((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }

  async function printSheet() {
    if (!current || selected.length === 0) return;
    setError(null);
    setPrinting(true);
    try {
      await downloadFile(
        `/businesses/${current.id}/tables/qr-sheet`,
        `table-qr-sheet-${selected.length}.pdf`,
        { ...sheet, tableIds: selected },
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not build that print sheet.");
    } finally {
      setPrinting(false);
    }
  }

  async function download(table: TableRow, format: "png" | "pdf") {
    if (!current) return;
    setBusy(`${table.id}-${format}`);
    try {
      await downloadFile(
        `/businesses/${current.id}/tables/${table.id}/qr?format=${format}`,
        `table-${table.label.replace(/\s+/g, "-").toLowerCase()}-qr.${format}`,
      );
    } finally {
      setBusy(null);
    }
  }

  const allSelected = selected.length === tables.length && tables.length > 0;
  const someSelected = selected.length > 0 && selected.length < tables.length;

  return (
    <div className="mx-auto max-w-5xl px-5 py-8 sm:px-6 sm:py-10 lg:px-10 lg:py-12">
      {/* Header */}
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-semibold leading-tight tracking-tight sm:text-[30px]">
            Tables
          </h1>
          <p className="mt-1 text-[14px] text-muted">
            Each table gets its own QR code. Select tables to batch-print.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => { setShowAdd(true); setShowRange(false); }}>
            + Add table
          </Button>
          <Button onClick={() => { setShowAdd(true); setShowRange(true); }}>
            + Add several
          </Button>
        </div>
      </header>

      {error && <div className="mb-6"><Banner>{error}</Banner></div>}

      {/* Add form */}
      {showAdd && (
        <div className="mb-8 rounded-2xl border border-line bg-surface p-5 animate-[float-up_220ms_cubic-bezier(0.22,1,0.36,1)_both]">
          {!showRange ? (
            <form onSubmit={addOne} className="flex flex-wrap items-end gap-3">
              <div className="min-w-[180px] flex-1">
                <Field label="Table name / number">
                  <Input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="e.g. 12 or A/C-5"
                    autoFocus
                  />
                </Field>
              </div>
              <Button type="submit" variant="primary" className="mb-[1px]">Add</Button>
              <Button type="button" variant="ghost" className="mb-[1px]" onClick={() => { setShowAdd(false); setLabel(""); }}>Cancel</Button>
              <button
                type="button"
                onClick={() => setShowRange(true)}
                className="mb-[1px] self-end text-[13px] text-muted hover:text-ink"
              >
                Add a range instead
              </button>
            </form>
          ) : (
            <form onSubmit={addRange} className="flex flex-wrap items-end gap-3">
              <div className="w-28">
                <Field label="Prefix" optional>
                  <Input
                    value={range.prefix}
                    onChange={(e) => setRange({ ...range, prefix: e.target.value })}
                    placeholder="T"
                  />
                </Field>
              </div>
              <div className="w-24">
                <Field label="From">
                  <Input
                    value={range.from}
                    onChange={(e) => setRange({ ...range, from: e.target.value.replace(/\D/g, "") })}
                    inputMode="numeric"
                    className="tnum"
                  />
                </Field>
              </div>
              <div className="w-24">
                <Field label="To">
                  <Input
                    value={range.to}
                    onChange={(e) => setRange({ ...range, to: e.target.value.replace(/\D/g, "") })}
                    inputMode="numeric"
                    className="tnum"
                  />
                </Field>
              </div>
              <Button type="submit" variant="primary" className="mb-[1px]">Create</Button>
              <Button type="button" variant="ghost" className="mb-[1px]" onClick={() => { setShowRange(false); setShowAdd(false); }}>Cancel</Button>
            </form>
          )}
        </div>
      )}

      {/* Status legend */}
      {tables.length > 0 && (
        <div className="mb-5 flex flex-wrap items-center gap-x-5 gap-y-2">
          {(["blank","active","printed","paused"] as TableStatus[]).map((s) => (
            <span key={s} className="flex items-center gap-1.5 text-[12.5px] text-muted">
              <span className={cx("h-2.5 w-2.5 rounded-full", STATUS_DOT[s])} />
              {STATUS_LABEL[s]} Table
            </span>
          ))}
        </div>
      )}

      {/* Toolbar: select all + batch print */}
      {tables.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <label className="-my-2 flex min-h-[44px] cursor-pointer items-center gap-2 py-2 text-[13.5px] text-muted select-none">
            <input
              type="checkbox"
              className="size-4 shrink-0 accent-[var(--accent)]"
              checked={allSelected}
              ref={(el) => { if (el) el.indeterminate = someSelected; }}
              onChange={(e) => setSelected(e.target.checked ? tables.map((t) => t.id) : [])}
            />
            {selected.length > 0 ? `${selected.length} selected` : "Select all"}
          </label>

          {selected.length > 0 && (
            <div className="flex flex-wrap items-end gap-2 rounded-2xl border border-line bg-surface px-4 py-3">
              <div className="w-28">
                <Field label="Paper">
                  <Select value={sheet.paper} onChange={(e) => setSheet({ ...sheet, paper: e.target.value as SheetPaper })}>
                    <option value="a4">A4</option>
                    <option value="a3">A3</option>
                    <option value="letter">Letter</option>
                  </Select>
                </Field>
              </div>
              <div className="w-32">
                <Field label="Orientation">
                  <Select value={sheet.orientation} onChange={(e) => setSheet({ ...sheet, orientation: e.target.value as SheetOrientation })}>
                    <option value="portrait">Portrait</option>
                    <option value="landscape">Landscape</option>
                  </Select>
                </Field>
              </div>
              <div className="w-36">
                <Field label="Card size">
                  <Select value={sheet.size} onChange={(e) => setSheet({ ...sheet, size: e.target.value as SheetSize })}>
                    <option value="small">Small — 53mm</option>
                    <option value="medium">Medium — 74mm</option>
                    <option value="large">Large — 105mm</option>
                  </Select>
                </Field>
              </div>
              <div className="w-36">
                <Field label="Style">
                  <Select value={sheet.style} onChange={(e) => setSheet({ ...sheet, style: e.target.value as SheetStyle })}>
                    <option value="card">Full card</option>
                    <option value="compact">QR + label only</option>
                  </Select>
                </Field>
              </div>
              <Button variant="primary" loading={printing} onClick={() => void printSheet()} className="mb-[1px] self-end">
                Download PDF
              </Button>
              {plan && (
                <p className="w-full text-[12.5px] text-faint">
                  {selected.length} {selected.length === 1 ? "card" : "cards"} · {plan.perPage} per page · {plan.pages === 1 ? "1 page" : `${plan.pages} pages`}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Table grid */}
      {loading ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-3">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="h-[100px] animate-pulse rounded-2xl bg-raised" />
          ))}
        </div>
      ) : tables.length === 0 ? (
        <Empty
          title="No tables yet"
          body="Add one table to try it, or add a range if you already know how many you have."
        />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-3">
          {tables.map((table) => {
            const status = tableStatus(table);
            const isSelected = selected.includes(table.id);
            const isBusy = busy?.startsWith(table.id);
            return (
              <div
                key={table.id}
                className={cx(
                  "spring group relative flex flex-col rounded-2xl border-2 p-3 cursor-pointer",
                  STATUS_COLORS[status],
                  isSelected && "ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-paper",
                )}
                onClick={() => toggleSelected(table.id)}
              >
                {/* Select checkbox */}
                <label
                  className="absolute top-2 left-2 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    className="size-3.5 accent-[var(--accent)]"
                    checked={isSelected}
                    onChange={() => toggleSelected(table.id)}
                    aria-label={`Select ${table.label}`}
                  />
                </label>

                {/* Status dot */}
                <span className={cx("absolute top-2 right-2 h-2 w-2 rounded-full", STATUS_DOT[status])} />

                {/* Table name */}
                <span className="mt-4 block text-[13px] font-semibold leading-tight truncate">
                  {table.label}
                </span>
                {!table.isActive && (
                  <span className="mt-0.5 block text-[10px] text-faint">Paused</span>
                )}

                {/* Actions row */}
                <div
                  className="mt-auto flex items-center gap-1 pt-2"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    title="Download PNG"
                    onClick={() => void download(table, "png")}
                    disabled={isBusy}
                    className="spring flex h-7 w-7 items-center justify-center rounded-lg text-faint hover:bg-[rgba(0,0,0,0.08)] hover:text-ink dark:hover:bg-[rgba(255,255,255,0.1)]"
                  >
                    <PrintIcon />
                  </button>
                  <button
                    title={table.isActive ? "Pause" : "Resume"}
                    onClick={() => void toggle(table)}
                    className="spring flex h-7 w-7 items-center justify-center rounded-lg text-faint hover:bg-[rgba(0,0,0,0.08)] hover:text-ink dark:hover:bg-[rgba(255,255,255,0.1)]"
                  >
                    {table.isActive ? <PauseIcon /> : <PlayIcon />}
                  </button>
                  <button
                    title="Delete"
                    onClick={() => void remove(table)}
                    className="spring flex h-7 w-7 items-center justify-center rounded-lg text-faint hover:bg-[rgba(179,38,30,0.1)] hover:text-[#B3261E] dark:hover:bg-[rgba(179,38,30,0.2)]"
                  >
                    <TrashIcon />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PrintIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <polyline points="6 9 6 2 18 2 18 9" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="8" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}
