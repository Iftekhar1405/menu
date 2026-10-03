import { Prisma } from "@prisma/client";
import { addDays, type SalesFilter } from "@menu/shared";

/**
 * The one place a sales filter becomes SQL.
 *
 * The list, the export and every analytics query build their WHERE from
 * here, so the three can never disagree about which bills "October, UPI,
 * table 12" means. Every value is a bind parameter; nothing a user typed is
 * ever part of the SQL string.
 *
 * Conditions are on alias `b` (bills).
 */
export function billWhere(f: SalesFilter, businessId: string, tz: string): Prisma.Sql {
  const parts: Prisma.Sql[] = [
    Prisma.sql`b.business_id = ${businessId}::uuid`,
    // A local date at local midnight, as an instant. `to` is inclusive, so
    // the upper bound is the following local midnight.
    Prisma.sql`b.issued_at >= (${f.from}::date::timestamp AT TIME ZONE ${tz})`,
    Prisma.sql`b.issued_at < (${addDays(f.to, 1)}::date::timestamp AT TIME ZONE ${tz})`,
    // A bill printed for an order that was later cancelled is not a sale, and
    // it can never be paid — counting it would leave a permanent "Unpaid".
    Prisma.sql`EXISTS (SELECT 1 FROM orders o WHERE o.id = b.order_id AND o.status <> 'cancelled')`,
  ];

  if (f.modes?.length) {
    const modes = f.modes.filter((m) => m !== "unpaid");
    const ors: Prisma.Sql[] = [];
    if (modes.length) ors.push(Prisma.sql`b.payment_mode::text IN (${Prisma.join(modes)})`);
    if (f.modes.includes("unpaid")) ors.push(Prisma.sql`b.payment_mode IS NULL`);
    parts.push(Prisma.sql`(${Prisma.join(ors, " OR ")})`);
  }
  if (f.tables?.length) parts.push(Prisma.sql`b.table_label IN (${Prisma.join(f.tables)})`);
  if (f.minTotal !== undefined) parts.push(Prisma.sql`b.total >= ${f.minTotal}`);
  if (f.maxTotal !== undefined) parts.push(Prisma.sql`b.total <= ${f.maxTotal}`);
  if (f.billNo !== undefined) parts.push(Prisma.sql`b.bill_number = ${f.billNo}`);

  // Bill lines carry only a name, so "bills with a coffee" goes through the
  // order's items to the dish's *current* category.
  if (f.menuItemId) {
    parts.push(Prisma.sql`EXISTS (
      SELECT 1 FROM order_items oi
      WHERE oi.order_id = b.order_id AND oi.menu_item_id = ${f.menuItemId}::uuid)`);
  }
  if (f.categoryId) {
    parts.push(Prisma.sql`EXISTS (
      SELECT 1 FROM order_items oi JOIN menu_items mi ON mi.id = oi.menu_item_id
      WHERE oi.order_id = b.order_id AND mi.category_id = ${f.categoryId}::uuid)`);
  }

  return Prisma.join(parts, " AND ");
}

/**
 * For item-level queries over `bill_lines l` joined to `bills b`: resolves
 * each line to its dish and current category. A line maps to the order item
 * it was generated from by name and variant (generate_bill writes one line
 * per order item). A deleted dish leaves both ids null.
 */
export const LINE_CATEGORY_JOIN = Prisma.sql`
  LEFT JOIN LATERAL (
    SELECT oi.menu_item_id, mi.category_id, c.name AS category_name
    FROM order_items oi
    LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
    LEFT JOIN menu_categories c ON c.id = mi.category_id
    WHERE oi.order_id = b.order_id
      AND oi.name_snapshot = l.name
      AND oi.variant_snapshot IS NOT DISTINCT FROM l.variant
    LIMIT 1
  ) cat ON true`;

/** Restricts item-level rows to the filtered item/category. */
export function lineMatch(f: SalesFilter): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (f.menuItemId) parts.push(Prisma.sql`cat.menu_item_id = ${f.menuItemId}::uuid`);
  if (f.categoryId) parts.push(Prisma.sql`cat.category_id = ${f.categoryId}::uuid`);
  return parts.length ? Prisma.join(parts, " AND ") : Prisma.sql`TRUE`;
}

export interface Cursor {
  /**
   * The row's `issued_at` exactly as Postgres holds it — ISO text with
   * microseconds, selected via `CURSOR_AT`. Never a JS Date: a Date keeps
   * milliseconds only, and a cursor truncated that way sorts *before* its own
   * row, so the next page would repeat it.
   */
  issuedAt: string;
  id: string;
}

/** Select this as `cursor_at` to build a full-precision cursor. */
export const CURSOR_AT = Prisma.sql`to_char(b.issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f-]{36}$/i;

export function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.issuedAt}|${c.id}`).toString("base64url");
}

export function decodeCursor(s: string): Cursor | null {
  try {
    const [issuedAt, id] = Buffer.from(s, "base64url").toString().split("|");
    if (!issuedAt || !id || !CURSOR_TIME.test(issuedAt) || !UUID.test(id)) return null;
    return { issuedAt, id };
  } catch {
    return null;
  }
}

/** Keyset condition for newest-first pages (the Sales list). */
export function beforeCursor(c: Cursor | null): Prisma.Sql {
  return c ? Prisma.sql`(b.issued_at, b.id) < (${c.issuedAt}::timestamptz, ${c.id}::uuid)` : Prisma.sql`TRUE`;
}

/** Keyset condition for oldest-first pages (the export). */
export function afterCursor(c: Cursor | null): Prisma.Sql {
  return c ? Prisma.sql`(b.issued_at, b.id) > (${c.issuedAt}::timestamptz, ${c.id}::uuid)` : Prisma.sql`TRUE`;
}
