import "../config/load-dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

/**
 * place_table_round is the only writer of order_rounds. Two things about it
 * would be invisible until a customer hit them, so both get a test here:
 * a new round used to drag the whole order back to 'placed', and the seq /
 * kot_number it allocates are a MAX(...) + 1 that is only safe because of
 * the advisory lock it takes first.
 *
 * Everything runs as the admin role: what is asserted is a function's
 * arithmetic, not who may see it. `updated_at` has no database-level default
 * anywhere in this schema — Prisma's @updatedAt only fires through Prisma
 * Client — so every raw INSERT sets it explicitly.
 */
const ADMIN_URL = process.env.DIRECT_URL!;
let admin: Client;
let owner: string, biz: string, table: string, itemId: string;

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const u = await admin.query(
    `INSERT INTO users (id, pin_hash, full_name, phone, verified_at, updated_at)
     VALUES (gen_random_uuid(), 'x', 'Place Round Owner', $1, now(), now()) RETURNING id`,
    [`+9199${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`],
  );
  owner = u.rows[0].id;
  const b = await admin.query(
    `INSERT INTO businesses (id, owner_id, name, public_code, type, currency, updated_at)
     VALUES (gen_random_uuid(), $1, 'Place Round Test', $2, 'restaurant', 'INR', now())
     RETURNING id`,
    [owner, Math.random().toString(36).slice(2, 10).toUpperCase()],
  );
  biz = b.rows[0].id;
  const t = await admin.query(
    `INSERT INTO tables (id, business_id, label, token, position)
     VALUES (gen_random_uuid(), $1, '1', $2, 1) RETURNING id`,
    [biz, Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32)],
  );
  table = t.rows[0].id;
  const cat = await admin.query(
    `INSERT INTO menu_categories (id, business_id, name, position)
     VALUES (gen_random_uuid(), $1, 'Drinks', 0) RETURNING id`,
    [biz],
  );
  const item = await admin.query(
    `INSERT INTO menu_items (id, business_id, category_id, name, price, is_available, position, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'Irani Chai', 30.00, true, 0, now()) RETURNING id`,
    [biz, cat.rows[0].id],
  );
  itemId = item.rows[0].id;
});

afterAll(async () => {
  await admin.query("DELETE FROM businesses WHERE id = $1", [biz]);
  await admin.query("DELETE FROM users WHERE id = $1", [owner]);
  await admin.end();
});

const lines = (qty: number) => JSON.stringify([{ itemId, variantId: null, quantity: qty }]);

describe("place_table_round", () => {
  it("leaves an in-flight round alone when a new round arrives", async () => {
    await admin.query(`SELECT place_table_round($1, $2, $3::jsonb)`, [table, biz, lines(1)]);
    await admin.query(
      `UPDATE order_rounds SET status = 'ready' WHERE order_id =
         (SELECT id FROM orders WHERE table_id = $1 AND status <> 'completed' LIMIT 1)`,
      [table],
    );

    await admin.query(`SELECT place_table_round($1, $2, $3::jsonb)`, [table, biz, lines(2)]);

    const r = await admin.query(
      `SELECT seq, status::text AS s FROM order_rounds
       WHERE order_id = (SELECT id FROM orders WHERE table_id = $1 AND status <> 'completed' LIMIT 1)
       ORDER BY seq`,
      [table],
    );
    expect(r.rows.map((x) => [x.seq, x.s])).toEqual([
      [1, "ready"],
      [2, "placed"],
    ]);
  });

  // Review Focus #2
  it("gives concurrent rounds distinct seq and kot_number", async () => {
    const a = new Client({ connectionString: ADMIN_URL });
    const b = new Client({ connectionString: ADMIN_URL });
    await a.connect();
    await b.connect();
    try {
      await Promise.all([
        a.query(`SELECT place_table_round($1, $2, $3::jsonb)`, [table, biz, lines(1)]),
        b.query(`SELECT place_table_round($1, $2, $3::jsonb)`, [table, biz, lines(1)]),
      ]);
    } finally {
      await a.end();
      await b.end();
    }
    const r = await admin.query(
      `SELECT count(*)::int AS rounds,
              count(DISTINCT seq)::int AS seqs,
              count(DISTINCT kot_number)::int AS kots
       FROM order_rounds
       WHERE order_id = (SELECT id FROM orders WHERE table_id = $1 AND status <> 'completed' LIMIT 1)`,
      [table],
    );
    expect(r.rows[0].seqs).toBe(r.rows[0].rounds);
    expect(r.rows[0].kots).toBe(r.rows[0].rounds);
  });
});
