"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { PAYMENT_MODE_LABEL, formatMoney, timezoneFor } from "@menu/shared";
import { api } from "@/lib/api-client";
import { useSession } from "@/components/session";
import { Button, Empty, cx } from "@/components/ui";
import { FilterBar } from "@/components/sales/filter-bar";
import { BillSheet } from "@/components/sales/bill-sheet";
import { ExportDialog } from "@/components/sales/export-dialog";
import { useSalesFilter } from "@/components/sales/use-sales-filter";
import { useSalesLookups } from "@/components/sales/use-sales-lookups";
import type { BillRow, SalesPage, Totals } from "@/lib/sales/types";

export default function SalesRoute() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <Sales />
    </Suspense>
  );
}

function Sales() {
  const { current } = useSession();
  const tz = timezoneFor(current?.country ?? "IN");
  const { filter, preset, setFilter, query } = useSalesFilter(tz);
  const [rows, setRows] = useState<BillRow[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<BillRow | null>(null);
  const [exporting, setExporting] = useState(false);
  const lookups = useSalesLookups(current?.id);

  const load = useCallback(async () => {
    if (!current) return;
    setLoading(true);
    try {
      const page = await api.get<SalesPage>(`/businesses/${current.id}/bills?${query}`);
      setRows(page.bills);
      setTotals(page.totals);
      setCursor(page.nextCursor);
    } finally {
      setLoading(false);
    }
  }, [current, query]);

  useEffect(() => void load(), [load]);

  async function more() {
    if (!current || !cursor) return;
    const page = await api.get<SalesPage>(`/businesses/${current.id}/bills?${query}&cursor=${encodeURIComponent(cursor)}`);
    setRows((r) => [...r, ...page.bills]);
    setCursor(page.nextCursor);
  }

  if (!current) return null;
  const money = (v: string) => formatMoney(v, current.currency);

  return (
    <div className="mx-auto max-w-5xl px-5 py-8 sm:px-6 sm:py-10 lg:px-10">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[26px] font-semibold leading-tight tracking-tight sm:text-[30px]">Sales</h1>
          <p className="mt-1 text-[14px] text-muted">Every bill, for tallying and filing. Receipts showing tax, not GST tax invoices.</p>
        </div>
        <Button variant="primary" onClick={() => setExporting(true)} disabled={!totals?.count}>Export</Button>
      </header>

      <FilterBar tz={tz} filter={filter} preset={preset} onChange={setFilter} {...lookups} />

      {totals && (
        <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
          <Tot label="Bills" value={String(totals.count)} />
          <Tot label="Gross" value={money(totals.gross)} />
          <Tot label="Tax" value={money(totals.tax)} />
          <Tot label="Net (excl. tax)" value={money(totals.net)} />
          {(["cash", "upi", "card", "other"] as const).map((m) => (
            <Tot key={m} label={PAYMENT_MODE_LABEL[m]} value={money(totals.byMode[m])} />
          ))}
          <Tot label="Unpaid" value={money(totals.byMode.unpaid)} warn={Number(totals.byMode.unpaid) > 0} />
        </dl>
      )}

      <section className="mt-8">
        {loading ? (
          <div className="skeleton h-48 rounded-2xl" />
        ) : rows.length === 0 ? (
          <Empty title="No bills in this period" body="Change the dates or clear filters." />
        ) : (
          <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
            {rows.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => setOpen(r)}
                  className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-0.5 px-4 py-3 text-left hover:bg-[var(--raised)] sm:grid-cols-[5rem_1fr_10rem_8rem_7rem]">
                  <span className="tnum font-medium">#{r.billNumber}</span>
                  <span className="text-[13.5px] text-muted">
                    {new Date(r.issuedAt).toLocaleString("en-IN", { timeZone: tz, dateStyle: "medium", timeStyle: "short" })}
                    <span className="sm:hidden"> · Table {r.tableLabel}</span>
                  </span>
                  <span className="hidden truncate text-[13.5px] sm:block">Table {r.tableLabel}</span>
                  <span className={cx("hidden w-fit rounded-full px-2 py-0.5 text-[12px] sm:block",
                    r.paymentMode ? "bg-[var(--raised)]" : "bg-[var(--accent-soft)] text-[var(--accent-strong)]")}>
                    {r.paymentMode ? `Paid · ${PAYMENT_MODE_LABEL[r.paymentMode]}` : "Unpaid"}
                  </span>
                  <span className="tnum text-right font-medium">{money(r.total)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {cursor && (
          <div className="mt-4 flex justify-center">
            <Button variant="secondary" onClick={() => void more()}>Load more</Button>
          </div>
        )}
      </section>

      {open && (
        <BillSheet businessId={current.id} currency={current.currency} row={open}
          onClose={() => setOpen(null)} onChanged={() => { setOpen(null); void load(); }} />
      )}
      {exporting && totals && (
        <ExportDialog businessId={current.id} businessName={current.name} filter={filter} query={query}
          billCount={totals.count} onClose={() => setExporting(false)} />
      )}
    </div>
  );
}

function Tot({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={cx("rounded-xl border px-3 py-2.5", warn ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-line bg-surface")}>
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd className="tnum mt-0.5 text-[17px] font-semibold">{value}</dd>
    </div>
  );
}
