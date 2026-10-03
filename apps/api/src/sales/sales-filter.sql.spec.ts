import { describe, expect, it } from "vitest";
import { afterCursor, beforeCursor, billWhere, decodeCursor, encodeCursor, lineMatch } from "./sales-filter.sql";

const base = { from: "2026-10-02", to: "2026-10-02" };
const BIZ = "11111111-1111-1111-1111-111111111111";

describe("billWhere", () => {
  it("scopes to the business and a local-day range in the business timezone", () => {
    const w = billWhere(base, BIZ, "Asia/Kolkata");
    expect(w.sql).toContain("b.business_id = ");
    expect(w.sql).toContain("AT TIME ZONE");
    // to is inclusive: the upper bound is the next local midnight.
    expect(w.values).toEqual([BIZ, "2026-10-02", "Asia/Kolkata", "2026-10-03", "Asia/Kolkata"]);
  });

  it("ORs modes with unpaid", () => {
    const w = billWhere({ ...base, modes: ["cash", "unpaid"] }, BIZ, "UTC");
    expect(w.sql).toMatch(/b\.payment_mode::text IN \(\?\) OR b\.payment_mode IS NULL/);
    expect(w.values).toContain("cash");
  });

  it("filters only on unpaid when that is all that is asked", () => {
    const w = billWhere({ ...base, modes: ["unpaid"] }, BIZ, "UTC");
    expect(w.sql).toContain("(b.payment_mode IS NULL)");
    expect(w.sql).not.toContain("IN (");
  });

  it("adds tables, totals, bill number, item and category", () => {
    const w = billWhere(
      {
        ...base,
        tables: ["12", "Balcony 3"],
        minTotal: 100,
        maxTotal: 500,
        billNo: 42,
        menuItemId: "22222222-2222-2222-2222-222222222222",
        categoryId: "33333333-3333-3333-3333-333333333333",
      },
      BIZ,
      "UTC",
    );
    expect(w.sql).toContain("b.table_label IN (");
    expect(w.sql).toContain("b.total >= ");
    expect(w.sql).toContain("b.total <= ");
    expect(w.sql).toContain("b.bill_number = ");
    expect(w.sql).toContain("oi.menu_item_id = ");
    expect(w.sql).toContain("mi.category_id = ");
    expect(w.values).toEqual(expect.arrayContaining(["12", "Balcony 3", 100, 500, 42]));
  });

  it("never interpolates user text into the SQL string", () => {
    const evil = "x'); DROP TABLE bills; --";
    const w = billWhere({ ...base, tables: [evil] }, BIZ, "UTC");
    expect(w.sql).not.toContain("DROP");
    expect(w.values).toContain(evil);
  });
});

describe("lineMatch", () => {
  it("is TRUE with no item filter", () => {
    expect(lineMatch(base).sql.trim()).toBe("TRUE");
  });
  it("matches category on the lateral alias", () => {
    expect(lineMatch({ ...base, categoryId: "33333333-3333-3333-3333-333333333333" }).sql).toContain("cat.category_id = ");
  });
});

describe("cursor", () => {
  it("round-trips and rejects junk", () => {
    const c = { issuedAt: "2026-10-02T10:00:00.123456Z", id: "44444444-4444-4444-4444-444444444444" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor("not-a-cursor")).toBeNull();
  });

  // Postgres keeps microseconds; a JS Date keeps milliseconds. A cursor cut
  // to milliseconds sorts *before* its own row, so the next page repeats it —
  // a duplicated bill in every 1000-row export page.
  it("keeps the database's microseconds so a page never repeats its last row", () => {
    const c = { issuedAt: "2026-10-03T12:08:20.873463Z", id: "44444444-4444-4444-4444-444444444444" };
    expect(afterCursor(c).values).toContain("2026-10-03T12:08:20.873463Z");
    expect(beforeCursor(c).values).toContain("2026-10-03T12:08:20.873463Z");
  });
});
