"use client";

import { useState } from "react";
import {
  PAYMENT_FILTERS,
  PAYMENT_MODE_LABEL,
  PERIOD_PRESETS,
  PERIOD_PRESET_LABEL,
  localToday,
  presetRange,
  salesFilterSchema,
  type PaymentFilter,
  type SalesFilter,
} from "@menu/shared";
import { Button, Field, Input, Select, Sheet, SheetGrabber, cx } from "@/components/ui";
import type { PresetOrCustom } from "./use-sales-filter";

const MODE_LABEL: Record<PaymentFilter, string> = { ...PAYMENT_MODE_LABEL, unpaid: "Unpaid" };

export function FilterBar({
  tz,
  filter,
  preset,
  onChange,
  tables,
  categories,
  items,
}: {
  tz: string;
  filter: SalesFilter;
  preset: PresetOrCustom;
  onChange: (next: SalesFilter, preset: PresetOrCustom) => void;
  tables: string[];
  categories: { id: string; name: string }[];
  items: { id: string; name: string; categoryId: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<SalesFilter>(filter);
  const [error, setError] = useState<string | null>(null);

  function pickPreset(p: PresetOrCustom) {
    if (p === "custom") {
      setDraft(filter);
      setOpen(true);
      return;
    }
    onChange({ ...filter, ...presetRange(p, localToday(tz)) }, p);
  }

  function apply() {
    const parsed = salesFilterSchema.safeParse(draft);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the filters");
      return;
    }
    const datesChanged = parsed.data.from !== filter.from || parsed.data.to !== filter.to;
    onChange(parsed.data, datesChanged ? "custom" : preset);
    setOpen(false);
  }

  function toggle<K extends "modes" | "tables">(key: K, value: string) {
    const list = new Set((draft[key] as string[] | undefined) ?? []);
    list.has(value) ? list.delete(value) : list.add(value);
    setDraft({ ...draft, [key]: list.size ? [...list] : undefined });
  }

  const chips: { label: string; clear: () => void }[] = [
    ...(filter.modes ?? []).map((m) => ({
      label: MODE_LABEL[m],
      clear: () => onChange({ ...filter, modes: filter.modes!.filter((x) => x !== m) }, preset),
    })),
    ...(filter.tables ?? []).map((t) => ({
      label: `Table ${t}`,
      clear: () => onChange({ ...filter, tables: filter.tables!.filter((x) => x !== t) }, preset),
    })),
    ...(filter.categoryId
      ? [{ label: categories.find((c) => c.id === filter.categoryId)?.name ?? "Category", clear: () => onChange({ ...filter, categoryId: undefined }, preset) }]
      : []),
    ...(filter.menuItemId
      ? [{ label: items.find((i) => i.id === filter.menuItemId)?.name ?? "Dish", clear: () => onChange({ ...filter, menuItemId: undefined }, preset) }]
      : []),
    ...(filter.minTotal !== undefined || filter.maxTotal !== undefined
      ? [{ label: `Total ${filter.minTotal ?? 0}–${filter.maxTotal ?? "∞"}`, clear: () => onChange({ ...filter, minTotal: undefined, maxTotal: undefined }, preset) }]
      : []),
    ...(filter.billNo !== undefined
      ? [{ label: `Bill #${filter.billNo}`, clear: () => onChange({ ...filter, billNo: undefined }, preset) }]
      : []),
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1 overflow-x-auto">
          <div className="flex gap-1.5">
            {[...PERIOD_PRESETS, "custom" as const].map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => pickPreset(p)}
                aria-pressed={preset === p}
                className={cx(
                  "spring h-9 shrink-0 rounded-lg px-3 text-[13.5px] font-medium",
                  preset === p ? "bg-ink text-surface" : "bg-[var(--raised)] text-muted hover:text-ink",
                )}
              >
                {p === "custom" ? "Custom" : PERIOD_PRESET_LABEL[p]}
              </button>
            ))}
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={() => { setDraft(filter); setOpen(true); }}>
          More filters
        </Button>
      </div>

      <p className="tnum text-[13px] text-muted">
        {filter.from === filter.to ? filter.from : `${filter.from} → ${filter.to}`}
      </p>

      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <button key={c.label} type="button" onClick={c.clear}
              className="rounded-full border border-line px-2.5 py-1 text-[12.5px] hover:border-ink">
              {c.label} <span aria-hidden="true">×</span>
              <span className="sr-only">Remove filter</span>
            </button>
          ))}
          <button type="button" className="px-2 text-[12.5px] text-muted underline"
            onClick={() => onChange({ from: filter.from, to: filter.to }, preset)}>
            Clear all
          </button>
        </div>
      )}

      {open && (
        <Sheet label="Filters" onClose={() => setOpen(false)} side="side">
          <SheetGrabber />
          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
            <div className="grid grid-cols-2 gap-3">
              <Field label="From">
                <Input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
              </Field>
              <Field label="To">
                <Input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
              </Field>
            </div>

            <fieldset>
              <legend className="mb-2 text-[13px] font-medium">Payment</legend>
              <div className="flex flex-wrap gap-1.5">
                {PAYMENT_FILTERS.map((m) => (
                  <button key={m} type="button" onClick={() => toggle("modes", m)}
                    aria-pressed={draft.modes?.includes(m) ?? false}
                    className={cx("rounded-lg px-3 py-1.5 text-[13px]",
                      draft.modes?.includes(m) ? "bg-ink text-surface" : "bg-[var(--raised)]")}>
                    {MODE_LABEL[m]}
                  </button>
                ))}
              </div>
            </fieldset>

            {tables.length > 0 && (
              <fieldset>
                <legend className="mb-2 text-[13px] font-medium">Tables</legend>
                <div className="flex flex-wrap gap-1.5">
                  {tables.map((t) => (
                    <button key={t} type="button" onClick={() => toggle("tables", t)}
                      aria-pressed={draft.tables?.includes(t) ?? false}
                      className={cx("rounded-lg px-3 py-1.5 text-[13px]",
                        draft.tables?.includes(t) ? "bg-ink text-surface" : "bg-[var(--raised)]")}>
                      {t}
                    </button>
                  ))}
                </div>
              </fieldset>
            )}

            <Field label="Category">
              <Select value={draft.categoryId ?? ""} onChange={(e) => setDraft({ ...draft, categoryId: e.target.value || undefined, menuItemId: undefined })}>
                <option value="">All categories</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label="Dish">
              <Select value={draft.menuItemId ?? ""} onChange={(e) => setDraft({ ...draft, menuItemId: e.target.value || undefined })}>
                <option value="">All dishes</option>
                {items.filter((i) => !draft.categoryId || i.categoryId === draft.categoryId)
                  .map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </Select>
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Min total">
                <Input inputMode="decimal" value={draft.minTotal ?? ""} onChange={(e) => setDraft({ ...draft, minTotal: e.target.value === "" ? undefined : Number(e.target.value) })} />
              </Field>
              <Field label="Max total">
                <Input inputMode="decimal" value={draft.maxTotal ?? ""} onChange={(e) => setDraft({ ...draft, maxTotal: e.target.value === "" ? undefined : Number(e.target.value) })} />
              </Field>
            </div>
            <Field label="Bill number">
              <Input inputMode="numeric" value={draft.billNo ?? ""} onChange={(e) => setDraft({ ...draft, billNo: e.target.value === "" ? undefined : Number(e.target.value) })} />
            </Field>

            {error && <p role="alert" className="text-[13px] text-[var(--danger,#b42318)]">{error}</p>}
          </div>
          <div className="flex gap-3 border-t border-line px-5 py-4">
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" className="flex-1" onClick={apply}>Apply</Button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
