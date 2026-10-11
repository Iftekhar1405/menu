import "../config/load-dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

/**
 * get_table_order is the whole payload the diner's screen reads, and it is
 * also what place_table_round returns — so a key that quietly stops being
 * emitted here breaks a screen with nothing else to catch it.
 *
 * Two things are asserted, because two readers depend on this shape:
 *
 *   - `rounds` is what the boards render a table's batches from. Flattened
 *     items cannot carry a round's own status or KOT number, which is the
 *     entire point of rounds being first-class rows.
 *   - `batch` on each flat item is what notifications/events.ts picks the
 *     newest round with (`Math.max(...items.map(i => i.batch))`). Dropping
 *     it would have the kitchen announced an empty round.
 *
 * Seeding runs as the admin role; the call under test runs as `menu_app`,
 * which is the role the API actually reaches this function with
 * (orders.service.ts `currentForTable`, inside `withoutTenant`).
 */
const ADMIN_URL = process.env.DIRECT_URL!;
const APP_URL = process.env.APP_DATABASE_URL || process.env.DATABASE_URL!;

type Round = {
  id: string;
  seq: number;
  kotNumber: number;
  status: string;
  placedAt: string;
  items: { id: string; name: string; variant: string | null; unitPrice: string; quantity: number }[];
};
type Payload = {
  items: { name: string; quantity: number; batch: number }[];
  rounds: Round[];
};

let admin: Client;
let app: Client;
let owner: string, biz: string, table: string, chai: string, dosa: string;

const lines = (itemId: string, quantity: number) =>
  JSON.stringify([{ itemId, variantId: null, quantity }]);

const place = (itemId: string, quantity: number) =>
  admin.query(`SELECT place_table_round($1, $2, $3::jsonb)`, [table, biz, lines(itemId, quantity)]);

async function payload(): Promise<Payload> {
  const r = await app.query<{ p: Payload }>(`SELECT get_table_order($1::uuid) AS p`, [table]);
  return r.rows[0].p;
}

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  app = new Client({ connectionString: APP_URL });
  await admin.connect();
  await app.connect();

  // `updated_at` has no database-level default anywhere in this schema —
  // Prisma's @updatedAt only fires through Prisma Client — so every raw
  // INSERT sets it explicitly.
  const u = await admin.query(
    `INSERT INTO users (id, pin_hash, full_name, phone, verified_at, updated_at)
     VALUES (gen_random_uuid(), 'x', 'Table Order Owner', $1, now(), now()) RETURNING id`,
    [`+9199${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`],
  );
  owner = u.rows[0].id;
  const b = await admin.query(
    `INSERT INTO businesses (id, owner_id, name, public_code, type, currency, updated_at)
     VALUES (gen_random_uuid(), $1, 'Table Order Test', $2, 'restaurant', 'INR', now())
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
     VALUES (gen_random_uuid(), $1, 'All day', 0) RETURNING id`,
    [biz],
  );
  const mk = async (name: string, price: string, position: number) =>
    (
      await admin.query(
        `INSERT INTO menu_items (id, business_id, category_id, name, price, is_available, position, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, true, $5, now()) RETURNING id`,
        [biz, cat.rows[0].id, name, price, position],
      )
    ).rows[0].id as string;
  chai = await mk("Irani Chai", "30.00", 0);
  dosa = await mk("Masala Dosa", "90.00", 1);

  // One table, two rounds, with the first already past the second's status:
  // that is the case a single order-level status cannot represent.
  await place(chai, 2);
  await admin.query(
    `UPDATE order_rounds SET status = 'ready'
     WHERE order_id = (SELECT id FROM orders WHERE table_id = $1 ORDER BY placed_at DESC LIMIT 1)
       AND seq = 1`,
    [table],
  );
  await place(dosa, 1);
});

afterAll(async () => {
  await admin.query("DELETE FROM businesses WHERE id = $1", [biz]);
  await admin.query("DELETE FROM users WHERE id = $1", [owner]);
  await admin.end();
  await app.end();
});

describe("get_table_order", () => {
  it("returns each round with its own kot number, status and items", async () => {
    const { rounds } = await payload();

    expect(rounds.map((r) => [r.seq, r.status])).toEqual([
      [1, "ready"],
      [2, "placed"],
    ]);
    expect(new Set(rounds.map((r) => r.kotNumber)).size).toBe(2);
    expect(rounds.every((r) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(r.placedAt))).toBe(true);

    // Each round carries only its own items — the board prints one KOT per
    // round, so a round that reported the whole order would be reprinted in
    // full every time the table ordered again.
    expect(rounds.map((r) => r.items.map((i) => [i.name, i.quantity, i.unitPrice]))).toEqual([
      [["Irani Chai", 2, "30.00"]],
      [["Masala Dosa", 1, "90.00"]],
    ]);
  });

  it("keeps the flat items array, each item tagged with its round", async () => {
    const { items } = await payload();

    expect(items.map((i) => [i.name, i.batch])).toEqual([
      ["Irani Chai", 1],
      ["Masala Dosa", 2],
    ]);
  });
});
