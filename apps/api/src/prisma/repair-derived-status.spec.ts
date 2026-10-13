import "../config/load-dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The one-shot repair in 20261005098000_repair_derived_status.
 *
 * It gets a test for the reason the migration's own header gives: it runs
 * unqualified over every order a venue has ever taken. The thing that must be
 * true is not that it fixes a broken row — that is the easy half — but that it
 * is *narrow*: against a database where the derivation already holds, it
 * changes nothing, and it goes on changing nothing however often it runs.
 *
 * The statement is read from the migration file rather than retyped, so a copy
 * drifting from what ships is not a failure mode this test can have.
 *
 * Admin connection throughout, deliberately. The migration runs as the
 * migration role, and the divergent row it exists to repair can only be
 * produced by writing orders.status directly — which is the defect, and which
 * nothing in the application can do any more.
 */
const ADMIN_URL = process.env.DIRECT_URL!;

const REPAIR = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20261005098000_repair_derived_status/migration.sql",
  ),
  "utf8",
);

let admin: Client;
let owner: string, biz: string;
let broken: string, healthy: string;

async function freshTable(): Promise<string> {
  // `orders_one_open_per_table` allows a table exactly one open order, and both
  // orders below are open.
  const t = await admin.query(
    `INSERT INTO tables (id, business_id, label, token, position)
     VALUES (gen_random_uuid(), $1, '1', $2, 1) RETURNING id`,
    [biz, Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32)],
  );
  return t.rows[0].id as string;
}

/** An order with one round, left wherever the derivation puts it. */
async function orderWithRound(roundStatus: string): Promise<string> {
  // `updated_at` has no database-level default anywhere in this schema —
  // Prisma's @updatedAt only fires through Prisma Client — so every raw INSERT
  // here sets it explicitly.
  const o = await admin.query(
    `INSERT INTO orders (id, business_id, table_id, status, business_day, daily_number, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'placed', CURRENT_DATE,
             next_daily_number($1, CURRENT_DATE), now())
     RETURNING id`,
    [biz, await freshTable()],
  );
  const orderId = o.rows[0].id as string;
  await admin.query(
    `INSERT INTO order_rounds
       (id, business_id, order_id, seq, business_day, kot_number, status, placed_at)
     VALUES (gen_random_uuid(), $1, $2, 1, CURRENT_DATE,
             next_kot_number($1, CURRENT_DATE), $3::"OrderStatus", now())`,
    [biz, orderId, roundStatus],
  );
  return orderId;
}

async function orderRow(id: string) {
  const r = await admin.query(
    `SELECT status::text AS status, completed_at, updated_at FROM orders WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();

  const u = await admin.query(
    `INSERT INTO users (id, pin_hash, full_name, phone, verified_at, updated_at)
     VALUES (gen_random_uuid(), 'x', 'Repair Owner', $1, now(), now()) RETURNING id`,
    [`+9199${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`],
  );
  owner = u.rows[0].id;

  const b = await admin.query(
    `INSERT INTO businesses (id, owner_id, name, public_code, type, currency, updated_at)
     VALUES (gen_random_uuid(), $1, 'Repair Test', $2, 'restaurant', 'INR', now())
     RETURNING id`,
    [owner, Math.random().toString(36).slice(2, 10).toUpperCase()],
  );
  biz = b.rows[0].id;

  healthy = await orderWithRound("preparing");

  // The divergent row, reproduced the only way it can be: the round is
  // cancelled through the trigger, which correctly derives 'cancelled', and
  // then orders.status is written over the top — which is exactly what the
  // removed hand-write did when it landed after a diner's cancellation.
  broken = await orderWithRound("placed");
  const round = await admin.query(
    `SELECT id FROM order_rounds WHERE order_id = $1`,
    [broken],
  );
  await admin.query(
    `UPDATE order_rounds SET status = 'cancelled', completed_at = now() WHERE id = $1`,
    [round.rows[0].id],
  );
  await admin.query(
    `UPDATE orders SET status = 'ready', completed_at = NULL WHERE id = $1`,
    [broken],
  );
});

afterAll(async () => {
  await admin.query("DELETE FROM businesses WHERE id = $1", [biz]);
  await admin.query("DELETE FROM users WHERE id = $1", [owner]);
  await admin.end();
});

describe("20261005098000_repair_derived_status", () => {
  it("repairs only what disagrees, and is a no-op from then on", async () => {
    // Precondition, so a seed that silently failed cannot be mistaken for a
    // repair that silently worked.
    expect((await orderRow(broken)).status).toBe("ready");
    const before = await orderRow(healthy);

    await admin.query(REPAIR);

    const fixed = await orderRow(broken);
    expect(fixed.status).toBe("cancelled");
    // The trigger owns completed_at too, so the repair has to carry it or the
    // row lands terminal with no completion time.
    expect(fixed.completed_at).not.toBeNull();

    // The order that was already right is untouched — not re-derived to the
    // same value, not touched at all. updated_at is how that shows.
    expect(await orderRow(healthy)).toEqual(before);

    // The property that actually matters. Zero rows across the WHOLE database,
    // not just this business: the derivation is an invariant every committed
    // row obeys, so a second pass has nothing to find — and neither would a
    // first pass against a database the defect never ran on.
    const second = await admin.query(REPAIR);
    expect(second.rowCount).toBe(0);

    const third = await admin.query(REPAIR);
    expect(third.rowCount).toBe(0);
  });
});
