"use client";

import { Suspense, useEffect, useState } from "react";
import { CANCELLATION_REASON_LABEL, PAYMENT_MODE_LABEL, formatMoney, timezoneFor } from "@menu/shared";
import { api } from "@/lib/api-client";
import { useSession } from "@/components/session";
import { Empty, Segmented, cx } from "@/components/ui";
import { FilterBar } from "@/components/sales/filter-bar";
import { useSalesFilter } from "@/components/sales/use-sales-filter";
import { KpiTile } from "@/components/insights/kpi";
import { BarSeries, Distribution, HBars, Heatmap } from "@/components/insights/charts";
import { useSalesLookups } from "@/components/sales/use-sales-lookups";
import type { Analytics } from "@/lib/sales/types";

export default function InsightsRoute() {
  return (
    <Suspense fallback={null}>
      <Insights />
    </Suspense>
  );
}

function Insights() {
  const { current } = useSession();
  const tz = timezoneFor(current?.country ?? "IN");
  const { filter, preset, setFilter, query } = useSalesFilter(tz);
  const [data, setData] = useState<Analytics | null>(null);
  const [itemSort, setItemSort] = useState<"gross" | "qty">("gross");
  const [loading, setLoading] = useState(true);
  const lookups = useSalesLookups(current?.id);

  useEffect(() => {
    if (!current) return;
    let live = true;
    // The previous charts stay up while the next filter loads, dimmed, so the
    // page does not collapse to a skeleton on every chip tap.
    setLoading(true);
    void api
      .get<Analytics>(`/businesses/${current.id}/analytics?${query}`)
      .then((d) => live && setData(d))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [current, query]);

  if (!current) return null;
  const money = (v: string) => formatMoney(v, current.currency);
  const k = data?.kpis;

  return (
    <div className="mx-auto max-w-6xl px-5 py-8 sm:px-6 sm:py-10 lg:px-10">
      <header className="mb-6">
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight sm:text-[30px]">Insights</h1>
        <p className="mt-1 text-[14px] text-muted">How the business is doing, with the same filters as Sales.</p>
      </header>

      <FilterBar tz={tz} filter={filter} preset={preset} onChange={setFilter} {...lookups} />

      {!data || !k ? (
        <div className="skeleton mt-8 h-96 rounded-2xl" />
      ) : k.current.count === 0 && !loading ? (
        <div className="mt-10"><Empty title="No sales in this period" body="Pick a different period or clear filters." /></div>
      ) : (
        <div className={cx("mt-8 space-y-8 transition-opacity", loading && "opacity-60")} aria-busy={loading}>
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            <KpiTile label="Gross sales" value={money(k.current.gross)} current={k.current.gross} previous={k.previous.gross} />
            <KpiTile label="Bills" value={String(k.current.count)} current={String(k.current.count)} previous={String(k.previous.count)} />
            <KpiTile label="Average bill" value={money(k.current.avgBill)} current={k.current.avgBill} previous={k.previous.avgBill} />
            <KpiTile label="Items sold" value={String(k.current.itemsSold)} current={String(k.current.itemsSold)} previous={String(k.previous.itemsSold)} />
            <KpiTile label="Paid digitally"
              value={`${Math.round(((Number(k.current.byMode.upi) + Number(k.current.byMode.card) + Number(k.current.byMode.other)) / Math.max(1, Number(k.current.gross) - Number(k.current.byMode.unpaid))) * 100)}%`} />
            <KpiTile label="Unpaid" value={money(k.current.byMode.unpaid)} warn={Number(k.current.byMode.unpaid) > 0} />
          </section>

          <Card title="Sales over time" note={`By ${data.series.bucket}`}>
            <BarSeries points={data.series.points} bucket={data.series.bucket} format={money} label="Gross sales over time" />
          </Card>

          <div className="grid gap-8 lg:grid-cols-2">
            <Card title="How people paid">
              <HBars format={money} label="How people paid" showShare rows={[
                ...(["cash", "upi", "card", "other"] as const).map((m) => ({ label: PAYMENT_MODE_LABEL[m], value: k.current.byMode[m] })),
                { label: "Unpaid", value: k.current.byMode.unpaid },
              ]} />
            </Card>
            <Card title="Tables">
              <HBars format={money} label="Sales by table" rows={data.tables.map((t) => ({ label: t.label, value: t.gross, sub: `${t.bills} bill${t.bills === 1 ? "" : "s"}` }))} />
            </Card>
          </div>

          <Card title="Top dishes" action={
            <div className="w-52">
              <Segmented label="Sort dishes" value={itemSort} onChange={setItemSort}
                options={[{ value: "gross", label: "Revenue" }, { value: "qty", label: "Quantity" }]} />
            </div>
          }>
            <table className="w-full text-[14px]">
              <thead className="text-left text-[12px] text-muted">
                <tr><th className="py-1.5 font-medium">Dish</th><th className="font-medium">Category</th><th className="text-right font-medium">Qty</th><th className="text-right font-medium">Revenue</th></tr>
              </thead>
              <tbody>
                {[...data.items].sort((a, b) => itemSort === "qty" ? b.qty - a.qty : Number(b.gross) - Number(a.gross)).slice(0, 20).map((i) => (
                  <tr key={`${i.name}|${i.variant ?? ""}`} className="border-t border-line">
                    <td className="py-2">{i.name}{i.variant ? ` (${i.variant})` : ""}</td>
                    <td className="text-muted">{i.category}</td>
                    <td className="tnum text-right">{i.qty}</td>
                    <td className="tnum text-right">{money(i.gross)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <div className="grid gap-8 lg:grid-cols-2">
            <Card title="Categories">
              <HBars format={money} label="Sales by category" rows={data.categories.map((c) => ({ label: c.category, value: c.gross, sub: `${c.qty} sold` }))} />
            </Card>
            <Card title="Busy hours" note={`Bills by weekday and hour (${data.timezone})`}>
              <Heatmap cells={data.heatmap} format={money} label="Bills by weekday and hour" />
            </Card>
          </div>

          <div className="grid gap-8 lg:grid-cols-3">
            <Card title="Kitchen times" note={`Median minutes, ${data.kitchen.orders} orders`}>
              <dl className="grid grid-cols-2 gap-3 text-[14px]">
                {([["Wait to accept", data.kitchen.toAccept], ["Prep", data.kitchen.toReady], ["Serve", data.kitchen.toServe], ["Pay", data.kitchen.toPay]] as const).map(([l, v]) => (
                  <div key={l}><dt className="text-[12px] text-muted">{l}</dt><dd className="tnum text-[20px] font-semibold">{v === null ? "—" : `${v} min`}</dd></div>
                ))}
              </dl>
            </Card>
            <Card title="Cancellations" note="Date range only">
              <p className="tnum text-[20px] font-semibold">{data.cancellations.units} items · {money(data.cancellations.value)}</p>
              <ul className="mt-3 space-y-1 text-[13.5px]">
                {data.cancellations.byReason.map((r) => (
                  <li key={r.reason} className="flex justify-between"><span>{CANCELLATION_REASON_LABEL[r.reason as keyof typeof CANCELLATION_REASON_LABEL] ?? r.reason}</span><span className="tnum">{r.units}</span></li>
                ))}
              </ul>
            </Card>
            <Card title="Ratings" note={data.ratings.count ? `${data.ratings.average}★ from ${data.ratings.count}` : "No ratings yet"}>
              <Distribution counts={data.ratings.distribution} />
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function Card({ title, note, action, children }: { title: string; note?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-display text-[15px] font-semibold">{title}</h2>
          {note && <p className="text-[12.5px] text-muted">{note}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
