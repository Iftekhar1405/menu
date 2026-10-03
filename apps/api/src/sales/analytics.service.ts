import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { addDays, bucketFor, previousPeriod, type DateRange, type SalesFilter } from "@menu/shared";
import { PrismaService } from "../prisma/prisma.service";
import { LINE_CATEGORY_JOIN, billWhere, lineMatch } from "./sales-filter.sql";
import { SalesService, type Totals } from "./sales.service";
import { fillSeries } from "./series";

export type Kpis = Totals & { avgBill: string; itemsSold: number };

/**
 * Every section is one aggregate query over the same filtered bills. They run
 * one after another on the request's tenant transaction (a transaction is a
 * single connection), which with a remote database is ~10 round trips —
 * comfortably inside the 20 s transaction ceiling.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sales: SalesService,
  ) {}

  async get(userId: string, businessId: string, filter: SalesFilter) {
    const { tz, business } = await this.sales.context(userId, businessId);
    const range: DateRange = { from: filter.from, to: filter.to };
    const previous = previousPeriod(range);
    const where = billWhere(filter, businessId, tz);
    const prevWhere = billWhere({ ...filter, ...previous }, businessId, tz);
    const bucket = bucketFor(range);
    const db = this.prisma.db;

    const kpis = { current: await this.kpis(where), previous: await this.kpis(prevWhere) };

    const seriesRows = await db.$queryRaw<{ start: string; gross: string; bills: number }[]>`
      SELECT to_char(date_trunc(${bucket}, b.issued_at AT TIME ZONE ${tz}), 'YYYY-MM-DD') AS start,
             sum(b.total)::text AS gross, count(*)::int AS bills
      FROM bills b WHERE ${where} GROUP BY 1 ORDER BY 1`;

    const items = await db.$queryRaw<{ name: string; variant: string | null; category: string; qty: number; gross: string }[]>`
      SELECT l.name, l.variant,
             COALESCE(cat.category_name, CASE WHEN cat.menu_item_id IS NULL THEN 'Deleted item' ELSE 'Uncategorised' END) AS category,
             sum(l.quantity)::int AS qty, sum(l.line_total)::text AS gross
      FROM bills b JOIN bill_lines l ON l.bill_id = b.id
      ${LINE_CATEGORY_JOIN}
      WHERE ${where} AND ${lineMatch(filter)}
      GROUP BY 1, 2, 3 ORDER BY sum(l.line_total) DESC LIMIT 200`;

    const categories = await db.$queryRaw<{ category: string; qty: number; gross: string }[]>`
      SELECT COALESCE(cat.category_name, CASE WHEN cat.menu_item_id IS NULL THEN 'Deleted item' ELSE 'Uncategorised' END) AS category,
             sum(l.quantity)::int AS qty, sum(l.line_total)::text AS gross
      FROM bills b JOIN bill_lines l ON l.bill_id = b.id
      ${LINE_CATEGORY_JOIN}
      WHERE ${where} AND ${lineMatch(filter)}
      GROUP BY 1 ORDER BY sum(l.line_total) DESC`;

    const heatmap = await db.$queryRaw<{ dow: number; hour: number; bills: number; gross: string }[]>`
      SELECT extract(isodow FROM b.issued_at AT TIME ZONE ${tz})::int AS dow,
             extract(hour FROM b.issued_at AT TIME ZONE ${tz})::int AS hour,
             count(*)::int AS bills, sum(b.total)::text AS gross
      FROM bills b WHERE ${where} GROUP BY 1, 2`;

    const tables = await db.$queryRaw<{ label: string; bills: number; gross: string }[]>`
      SELECT b.table_label AS label, count(*)::int AS bills, sum(b.total)::text AS gross
      FROM bills b WHERE ${where} GROUP BY 1 ORDER BY sum(b.total) DESC`;

    // First time each stage was reached. A second round resets an order to
    // 'placed'; using the first occurrence measures the first round, which is
    // what "how long did the kitchen take" means to an owner.
    const [kitchen] = await db.$queryRaw<
      { to_accept: number | null; to_ready: number | null; to_serve: number | null; to_pay: number | null; orders: number }[]
    >`
      WITH fb AS (SELECT b.order_id FROM bills b WHERE ${where}),
      st AS (
        SELECT e.order_id,
               min(e.at) FILTER (WHERE e.kind = 'placed')    AS placed,
               min(e.at) FILTER (WHERE e.kind = 'accepted')  AS accepted,
               min(e.at) FILTER (WHERE e.kind = 'ready')     AS ready,
               min(e.at) FILTER (WHERE e.kind = 'completed') AS completed,
               min(e.at) FILTER (WHERE e.kind = 'paid')      AS paid
        FROM order_events e JOIN fb ON fb.order_id = e.order_id
        GROUP BY e.order_id
      )
      SELECT
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM accepted - placed)) / 60)::numeric, 1)::float AS to_accept,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ready - COALESCE(accepted, placed))) / 60)::numeric, 1)::float AS to_ready,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM completed - ready)) / 60)::numeric, 1)::float AS to_serve,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM paid - completed)) / 60)::numeric, 1)::float AS to_pay,
        count(*)::int AS orders
      FROM st`;

    // Date range only: a cancelled line never reached a bill, so payment,
    // table-on-bill, total and bill-number filters have nothing to match.
    const cancelRows = await db.$queryRaw<{ reason: string; units: number; value: string }[]>`
      SELECT c.reason::text AS reason, sum(c.quantity)::int AS units, sum(c.quantity * c.unit_price)::text AS value
      FROM order_item_cancellations c
      WHERE c.business_id = ${businessId}::uuid
        AND c.created_at >= (${filter.from}::date::timestamp AT TIME ZONE ${tz})
        AND c.created_at <  (${addDays(filter.to, 1)}::date::timestamp AT TIME ZONE ${tz})
      GROUP BY 1 ORDER BY 2 DESC`;

    const ratingRows = await db.$queryRaw<{ stars: number; n: number }[]>`
      SELECT r.stars, count(*)::int AS n
      FROM order_ratings r JOIN bills b ON b.order_id = r.order_id
      WHERE ${where} GROUP BY 1`;

    const distribution = [1, 2, 3, 4, 5].map((s) => ratingRows.find((r) => r.stars === s)?.n ?? 0);
    const ratingCount = distribution.reduce((a, b) => a + b, 0);

    return {
      range,
      previous,
      timezone: tz,
      currency: business.currency,
      kpis,
      series: { bucket, points: fillSeries(seriesRows, range, bucket) },
      items,
      categories,
      heatmap,
      tables,
      kitchen: {
        toAccept: kitchen?.to_accept ?? null,
        toReady: kitchen?.to_ready ?? null,
        toServe: kitchen?.to_serve ?? null,
        toPay: kitchen?.to_pay ?? null,
        orders: kitchen?.orders ?? 0,
      },
      cancellations: {
        units: cancelRows.reduce((a, r) => a + r.units, 0),
        value: cancelRows.reduce((a, r) => a + Number(r.value), 0).toFixed(2),
        byReason: cancelRows.map((r) => ({ reason: r.reason, units: r.units })),
      },
      ratings: {
        average: ratingCount ? Number((distribution.reduce((a, n, i) => a + n * (i + 1), 0) / ratingCount).toFixed(2)) : null,
        count: ratingCount,
        distribution,
      },
    };
  }

  private async kpis(where: Prisma.Sql): Promise<Kpis> {
    const totals = await this.sales.totals(where);
    const [extra] = await this.prisma.db.$queryRaw<{ avg_bill: string; items_sold: number }[]>`
      SELECT COALESCE(avg(b.total), 0)::numeric(12,2)::text AS avg_bill,
             COALESCE((SELECT sum(l.quantity) FROM bill_lines l JOIN bills b2 ON b2.id = l.bill_id
                       WHERE b2.id IN (SELECT b.id FROM bills b WHERE ${where})), 0)::int AS items_sold
      FROM bills b WHERE ${where}`;
    return { ...totals, avgBill: extra!.avg_bill, itemsSold: extra!.items_sold };
  }
}

export type Analytics = Awaited<ReturnType<AnalyticsService["get"]>>;
