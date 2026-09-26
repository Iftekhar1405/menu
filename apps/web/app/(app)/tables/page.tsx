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

export default function TablesPage() {
  const { current } = useSession();
  const confirm = useConfirm();
  const [tables, setTables] = useState<TableRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState("");
  const [range, setRange] = useState({ from: "1", to: "10", prefix: "" });
  const [showRange, setShowRange] = useState(false);
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

  /**
   * The same arithmetic the API lays the PDF out with, so the count shown
   * here cannot disagree with the file that arrives.
   */
  const plan = useMemo(() => {
    if (selected.length === 0) return null;
    try {
      return planSheet(sheet, selected.length);
    } catch {
      return null;
    }
  }, [sheet, selected.length]);

  const load = useCallback(async () => {
    if (!current) return;
    setTables(await api.get<TableRow[]>(`/businesses/${current.id}/tables`));
    setLoading(false);
  }, [current]);

  useEffect(() => {
    void load();
  }, [load]);

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
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add those tables.");
    }
  }

  async function rename(table: TableRow, next: string) {
    if (!current || next === table.label || !next.trim()) return;
    await api.patch(`/businesses/${current.id}/tables/${table.id}`, { label: next.trim() });
    await load();
  }

  async function toggle(table: TableRow) {
    if (!current) return;
    setTables((prev) =>
      prev.map((t) => (t.id === table.id ? { ...t, isActive: !t.isActive } : t)),
    );
    await api.patch(`/businesses/${current.id}/tables/${table.id}`, {
      isActive: !table.isActive,
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
    await api.del(`/businesses/${current.id}/tables/${table.id}`);
    await load();
  }

  function toggleSelected(id: string) {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  async function printSheet() {
    if (!current || selected.length === 0) return;
    setError(null);
    setPrinting(true);
    try {
      // Selection order is whatever they clicked in; the API prints in table
      // order regardless, so the stack comes out sorted.
      await downloadFile(
        `/businesses/${current.id}/tables/qr-sheet`,
        `table-qr-sheet-${selected.length}.pdf`,
        { ...sheet, tableIds: selected },
      );
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not build that print sheet.",
      );
    } finally {
      setPrinting(false);
    }
  }

  async function download(table: TableRow, format: "png" | "pdf") {
    if (!current) return;
    setBusy(table.id);
    try {
      await downloadFile(
        `/businesses/${current.id}/tables/${table.id}/qr?format=${format}`,
        `table-${table.label.replace(/\s+/g, "-").toLowerCase()}-qr.${format}`,
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-10 lg:px-10 lg:py-12">
      <header className="mb-8">
        <h1 className="text-[30px] font-semibold leading-tight tracking-tight">Tables</h1>
        <p className="mt-1 text-[14.5px] leading-relaxed text-muted">
          Each table gets its own card. Scanning one puts that diner&apos;s order on that
          table — they never see a table number in the address, so nobody can browse to
          another table&apos;s order.
        </p>
      </header>

      {error && (
        <div className="mb-6">
          <Banner>{error}</Banner>
        </div>
      )}

      <div className="mb-8 flex flex-wrap items-end gap-2">
        <form onSubmit={addOne} className="flex gap-2">
          <div className="w-44">
            <Field label="Add a table">
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="12"
              />
            </Field>
          </div>
          <Button type="submit" variant="primary" className="mb-[1px] self-end">
            Add
          </Button>
        </form>
        <Button
          className="mb-[1px] self-end"
          onClick={() => setShowRange((s) => !s)}
          aria-expanded={showRange}
        >
          Add several
        </Button>
      </div>

      {showRange && (
        <form
          onSubmit={addRange}
          className="mb-8 flex flex-wrap items-end gap-2 rounded-2xl border border-line bg-surface p-4"
        >
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
          <Button type="submit" variant="primary" className="mb-[1px] self-end">
            Create
          </Button>
        </form>
      )}

      {loading ? (
        <p className="text-[14px] text-faint">Loading…</p>
      ) : tables.length === 0 ? (
        <Empty
          title="No tables yet"
          body="Add one table to try it, or add a range if you already know how many you have."
        />
      ) : (
        <>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-[13.5px] text-muted">
            <input
              type="checkbox"
              className="size-4 accent-[var(--accent)]"
              checked={selected.length === tables.length && tables.length > 0}
              // Half-selected is its own state: the box should not claim
              // "all" when it would clear a partial selection.
              ref={(el) => {
                if (el) el.indeterminate = selected.length > 0 && selected.length < tables.length;
              }}
              onChange={(e) =>
                setSelected(e.target.checked ? tables.map((t) => t.id) : [])
              }
            />
            Select all
          </label>
          {selected.length > 0 && (
            <span className="text-[13.5px] text-faint">
              {selected.length} selected
            </span>
          )}
        </div>

        {selected.length > 0 && (
          <div className="mb-6 rounded-2xl border border-line bg-surface p-4">
            <div className="flex flex-wrap items-end gap-2">
              <div className="w-32">
                <Field label="Paper">
                  <Select
                    value={sheet.paper}
                    onChange={(e) =>
                      setSheet({ ...sheet, paper: e.target.value as SheetPaper })
                    }
                  >
                    <option value="a4">A4</option>
                    <option value="a3">A3</option>
                    <option value="letter">Letter</option>
                  </Select>
                </Field>
              </div>
              <div className="w-36">
                <Field label="Orientation">
                  <Select
                    value={sheet.orientation}
                    onChange={(e) =>
                      setSheet({
                        ...sheet,
                        orientation: e.target.value as SheetOrientation,
                      })
                    }
                  >
                    <option value="portrait">Portrait</option>
                    <option value="landscape">Landscape</option>
                  </Select>
                </Field>
              </div>
              <div className="w-36">
                <Field label="Card size">
                  <Select
                    value={sheet.size}
                    onChange={(e) =>
                      setSheet({ ...sheet, size: e.target.value as SheetSize })
                    }
                  >
                    <option value="small">Small — 53mm</option>
                    <option value="medium">Medium — 74mm</option>
                    <option value="large">Large — 105mm</option>
                  </Select>
                </Field>
              </div>
              <div className="w-40">
                <Field label="Style">
                  <Select
                    value={sheet.style}
                    onChange={(e) =>
                      setSheet({ ...sheet, style: e.target.value as SheetStyle })
                    }
                  >
                    <option value="card">Full card</option>
                    <option value="compact">QR and label only</option>
                  </Select>
                </Field>
              </div>
              <Button
                variant="primary"
                className="mb-[1px] self-end"
                loading={printing}
                onClick={() => void printSheet()}
              >
                Download PDF
              </Button>
            </div>
            {plan && (
              <p className="mt-3 text-[13px] text-faint">
                {selected.length} {selected.length === 1 ? "card" : "cards"} ·{" "}
                {plan.perPage} per page ·{" "}
                {plan.pages === 1 ? "1 page" : `${plan.pages} pages`}. Cut along
                the light guides.
              </p>
            )}
          </div>
        )}

        <ul className="overflow-hidden rounded-2xl border border-line bg-surface">
          {tables.map((table) => (
            <li
              key={table.id}
              className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3 first:border-t-0"
            >
              <input
                type="checkbox"
                className="size-4 accent-[var(--accent)]"
                checked={selected.includes(table.id)}
                onChange={() => toggleSelected(table.id)}
                aria-label={`Select ${table.label} for printing`}
              />
              <input
                defaultValue={table.label}
                onBlur={(e) => void rename(table, e.target.value)}
                aria-label={`Table name, currently ${table.label}`}
                className={cx(
                  "w-24 rounded-lg border border-transparent bg-transparent px-2 py-1 text-[14.5px] font-medium",
                  "hover:border-line focus:border-[var(--accent)] focus:bg-surface",
                  !table.isActive && "text-faint line-through",
                )}
              />
              {!table.isActive && (
                <span className="text-[12px] text-faint">Not taking orders</span>
              )}
              <span className="ml-auto flex flex-wrap gap-1.5">
                <Button size="sm" loading={busy === table.id} onClick={() => void download(table, "png")}>
                  PNG
                </Button>
                <Button size="sm" onClick={() => void download(table, "pdf")}>
                  PDF
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void toggle(table)}>
                  {table.isActive ? "Pause" : "Resume"}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void remove(table)}>
                  Delete
                </Button>
              </span>
            </li>
          ))}
        </ul>
        </>
      )}
    </div>
  );
}
