import "../config/load-dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

/**
 * A table that orders one biryani and then two more has ordered three
 * biryanis, and that is what the bill has to say. generate_bill used to print
 * one line per order_items row, so the same dish across two rounds came out as
 * `1 x Dum Biryani` and `2 x Dum Biryani` — arithmetically correct and, to the
 * person holding the bill, simply wrong.
 *
 * The other half of the behaviour is the half that is easy to lose: rows only
 * merge when they are genuinely the same thing. Every column of the grouping
 * key gets a test here, because dropping one of them does not error — the
 * SELECT list is all aggregates — it just quietly prints a number nobody was
 * charged. A price snapshotted at 320 must not merge with one snapshotted at
 * 330, and two dishes sharing a name and a price must not merge across a tax
 * rate.
 *
 * Seeding and the assertions run as the admin role; the call under test does
 * not. generate_bill is SECURITY DEFINER and reachable only through
 * `GRANT EXECUTE ... TO menu_app`, so it goes through a menu_app connection —
 * the role the API holds — and a migration that dropped that grant would turn
 * this suite red instead of production. The readback stays on admin because
 * bill_lines_owner keys on app_current_user_id(), and who may *see* a bill is
 * another spec's subject.
 */
const ADMIN_URL = process.env.DIRECT_URL!;
const APP_URL = process.env.APP_DATABASE_URL || process.env.DATABASE_URL!;

let admin: Client;
let app: Client;
let owner: string, biz: string, biryani: string, biryaniTaxed: string;

interface Line {
  name: string;
  quantity: number;
  unit_price: string;
  line_total: string;
  tax_rate: string;
}

/**
 * A table of its own per call. `orders_one_open_per_table` allows a table
 * exactly one open order and every bill here leaves one behind, so sharing one
 * table would couple the tests to each other's order and to run order.
 */
async function freshTable(): Promise<string> {
  const t = await admin.query(
    `INSERT INTO tables (id, business_id, label, token, position)
     VALUES (gen_random_uuid(), $1, '1', $2, 1) RETURNING id`,
    [biz, Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32)],
  );
  return t.rows[0].id as string;
}

/** One round of one dish, placed the way a diner places it. */
async function place(tableId: string, itemId: string, quantity: number): Promise<void> {
  await admin.query(`SELECT place_table_round($1, $2, $3::jsonb)`, [
    tableId,
    biz,
    JSON.stringify([{ itemId, variantId: null, quantity }]),
  ]);
}

/** Close the table's rounds, bill it the way the API does, read the lines. */
async function billLines(tableId: string): Promise<Line[]> {
  const o = await admin.query(`SELECT id FROM orders WHERE table_id = $1 ORDER BY placed_at DESC LIMIT 1`, [
    tableId,
  ]);
  const orderId = o.rows[0].id as string;
  await admin.query(`UPDATE order_rounds SET status = 'completed', completed_at = now() WHERE order_id = $1`, [
    orderId,
  ]);

  // Through menu_app, not admin: this is the one call the GRANT protects.
  await app.query(`SELECT generate_bill($1, $2)`, [orderId, biz]);

  const r = await admin.query(
    `SELECT name, quantity, unit_price::text, line_total::text, tax_rate::text
     FROM bill_lines WHERE bill_id = (SELECT id FROM bills WHERE order_id = $1)
     ORDER BY position`,
    [orderId],
  );
  return r.rows as Line[];
}

/**
 * One biryani, then two more, then a bill. `priceSecondRound` reprices the
 * menu item between the rounds, which is how the second round comes to carry a
 * different snapshot; `null` leaves the price alone. The price is reset on the
 * way in so the two tests cannot depend on each other's order.
 */
async function billLinesFor(priceSecondRound: number | null): Promise<Line[]> {
  const table = await freshTable();
  await admin.query(`UPDATE menu_items SET price = 320.00 WHERE id = $1`, [biryani]);

  await place(table, biryani, 1);
  if (priceSecondRound !== null) {
    await admin.query(`UPDATE menu_items SET price = $1 WHERE id = $2`, [priceSecondRound, biryani]);
  }
  await place(table, biryani, 2);

  return billLines(table);
}

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const u = await admin.query(
    `INSERT INTO users (id, pin_hash, full_name, phone, verified_at, updated_at)
     VALUES (gen_random_uuid(), 'x', 'Bill Merge Owner', $1, now(), now()) RETURNING id`,
    [`+9199${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`],
  );
  owner = u.rows[0].id;
  // tax_enabled, so the rate in the grouping key is a real number rather than
  // the constant 0 every dish would collapse to with tax off.
  const b = await admin.query(
    `INSERT INTO businesses (id, owner_id, name, public_code, type, currency, updated_at, tax_enabled)
     VALUES (gen_random_uuid(), $1, 'Bill Merge Test', $2, 'restaurant', 'INR', now(), true)
     RETURNING id`,
    [owner, Math.random().toString(36).slice(2, 10).toUpperCase()],
  );
  biz = b.rows[0].id;
  const cat = await admin.query(
    `INSERT INTO menu_categories (id, business_id, name, position)
     VALUES (gen_random_uuid(), $1, 'Biryani', 0) RETURNING id`,
    [biz],
  );
  const mk = async (taxRate: string | null) => {
    const i = await admin.query(
      `INSERT INTO menu_items (id, business_id, category_id, name, price, is_available, position, updated_at, tax_rate)
       VALUES (gen_random_uuid(), $1, $2, 'Dum Biryani', 320.00, true, 0, now(), $3::numeric) RETURNING id`,
      [biz, cat.rows[0].id, taxRate],
    );
    return i.rows[0].id as string;
  };
  // No rate of its own, so it falls back to the business default of 5.00.
  biryani = await mk(null);
  biryaniTaxed = await mk("18.00");

  app = new Client({ connectionString: APP_URL });
  await app.connect();
});

afterAll(async () => {
  await app.end();
  await admin.query("DELETE FROM businesses WHERE id = $1", [biz]);
  await admin.query("DELETE FROM users WHERE id = $1", [owner]);
  await admin.end();
});

describe("generate_bill line merging", () => {
  it("merges the same dish ordered in two rounds into one line", async () => {
    // One biryani at 8:42, two more at 9:06. The customer ordered three and
    // expects to see three.
    const bill = await billLinesFor(null);
    const lines = bill.filter((l) => l.name === "Dum Biryani");
    expect(lines).toHaveLength(1);
    expect(lines[0].quantity).toBe(3);
    expect(lines[0].line_total).toBe("960.00");
  });

  it("keeps the lines apart when the price changed between rounds", async () => {
    // Prices are snapshotted per round on purpose. Merging 320 and 330 would
    // print a price nobody was charged.
    const bill = await billLinesFor(330);
    const lines = bill.filter((l) => l.name === "Dum Biryani");
    expect(lines.map((l) => l.unit_price)).toEqual(["320.00", "330.00"]);
  });

  it("keeps the lines apart when two dishes share a name and price but not a tax rate", async () => {
    // Same name, same price, two tax rates — the one case where dropping a
    // column from the grouping key raises nothing at all. The lines would
    // merge into one billed at MAX of the two rates, which is a tax figure
    // the restaurant cannot account for and the diner never incurred.
    const table = await freshTable();
    await admin.query(`UPDATE menu_items SET price = 320.00 WHERE id = $1`, [biryani]);
    await place(table, biryani, 1);
    await place(table, biryaniTaxed, 1);

    const lines = (await billLines(table)).filter((l) => l.name === "Dum Biryani");
    expect(lines.map((l) => l.tax_rate)).toEqual(["5.00", "18.00"]);
  });
});
