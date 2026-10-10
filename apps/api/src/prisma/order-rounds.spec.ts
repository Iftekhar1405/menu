import "../config/load-dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

/**
 * The backfill is a one-shot that runs against live data. It gets a test
 * because getting it wrong renumbers every historical round, and nothing
 * downstream would notice until a customer asked about a bill.
 */
const ADMIN_URL = process.env.DIRECT_URL!;

let admin: Client;
let owner: string, bizA: string, bizB: string, orderA: string, orderB: string;

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();

  // `updated_at` has no database-level default anywhere in this schema —
  // Prisma's @updatedAt only fires through Prisma Client — so every raw
  // INSERT here sets it explicitly.
  const u = await admin.query(
    `INSERT INTO users (id, pin_hash, full_name, phone, verified_at, updated_at)
     VALUES (gen_random_uuid(), 'x', 'Rounds Owner', $1, now(), now()) RETURNING id`,
    [`+9199${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`],
  );
  owner = u.rows[0].id;

  const biz = async (name: string) => {
    const r = await admin.query(
      `INSERT INTO businesses (id, owner_id, name, public_code, type, currency, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'restaurant', 'INR', now()) RETURNING id`,
      [owner, name, Math.random().toString(36).slice(2, 10).toUpperCase()],
    );
    return r.rows[0].id as string;
  };
  bizA = await biz("Rounds Test A");
  bizB = await biz("Rounds Test B");

  // One open order per business. bizB's exists so the kot_number test can
  // run against a business with no rounds of its own, rather than against
  // whatever the tests above it happen to have left on bizA.
  const openOrder = async (businessId: string, dailyNumber: number) => {
    const t = await admin.query(
      `INSERT INTO tables (id, business_id, label, token, position)
       VALUES (gen_random_uuid(), $1, '1', $2, 1) RETURNING id`,
      [businessId, Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32)],
    );
    const o = await admin.query(
      `INSERT INTO orders (id, business_id, table_id, status, business_day, daily_number, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'placed', CURRENT_DATE, $3, now()) RETURNING id`,
      [businessId, t.rows[0].id, dailyNumber],
    );
    return o.rows[0].id as string;
  };
  orderA = await openOrder(bizA, 9001);
  orderB = await openOrder(bizB, 9002);
});

afterAll(async () => {
  await admin.query("DELETE FROM businesses WHERE id = ANY($1)", [[bizA, bizB]]);
  await admin.query("DELETE FROM users WHERE id = $1", [owner]);
  await admin.end();
});

describe("order_rounds", () => {
  it("attaches items to a round rather than a bare integer", async () => {
    const round = await admin.query(
      `INSERT INTO order_rounds
         (id, business_id, order_id, seq, business_day, kot_number, status, placed_at)
       VALUES (gen_random_uuid(), $1, $2, 1, CURRENT_DATE,
               next_kot_number($1, CURRENT_DATE), 'placed', now())
       RETURNING id, kot_number`,
      [bizA, orderA],
    );
    await admin.query(
      `INSERT INTO order_items
         (id, order_id, business_id, name_snapshot, unit_price, quantity, round_id)
       VALUES (gen_random_uuid(), $1, $2, 'Chai', 30.00, 2, $3)`,
      [orderA, bizA, round.rows[0].id],
    );
    const r = await admin.query(
      `SELECT count(*)::int AS n FROM order_items WHERE round_id = $1`,
      [round.rows[0].id],
    );
    expect(r.rows[0].n).toBe(1);
  });

  it("refuses two rounds with the same seq on one order", async () => {
    await expect(
      admin.query(
        `INSERT INTO order_rounds
           (id, business_id, order_id, seq, business_day, kot_number, status, placed_at)
         VALUES (gen_random_uuid(), $1, $2, 1, CURRENT_DATE,
                 next_kot_number($1, CURRENT_DATE), 'placed', now())`,
        [bizA, orderA],
      ),
    ).rejects.toThrow(/order_rounds_order_id_seq_key|duplicate key/);
  });

  // Without this, an implementation of next_kot_number that ignored its
  // arguments and returned a constant 1 would pass every other test in this
  // file. Task 5's concurrency fix is built directly on this function, and
  // nothing else in the plan guards it.
  it("counts kot_number up within one business day, per business", async () => {
    const insert = (seq: number) =>
      admin.query(
        `INSERT INTO order_rounds
           (id, business_id, order_id, seq, business_day, kot_number, status, placed_at)
         VALUES (gen_random_uuid(), $1, $2, $3, CURRENT_DATE,
                 next_kot_number($1, CURRENT_DATE), 'placed', now())
         RETURNING kot_number`,
        [bizB, orderB, seq],
      );

    // bizA already has a round on this same day, so a first round numbered 1
    // here is also what proves the serial is scoped per business.
    const first = await insert(1);
    expect(first.rows[0].kot_number).toBe(1);

    const second = await insert(2);
    expect(second.rows[0].kot_number).toBe(2);
  });

  it("restarts kot_number per business day", async () => {
    // "Re-fire KOT 38" has to mean one ticket. A serial that did not restart
    // per day would make it ambiguous every morning.
    const fresh = await admin.query(`SELECT next_kot_number($1, CURRENT_DATE + 7) AS n`, [bizA]);
    expect(fresh.rows[0].n).toBe(1);
  });
});
