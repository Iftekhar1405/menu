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
 * drifting from what ships is not a failure mode this test can have. That also
 * means what runs here is genuinely table-wide, which this file has to take
 * seriously rather than wish away — see the transaction in the test body.
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
/** A second session, for observing what the repair's table lock does to one. */
let other: Client;
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

/** Both of this test's orders, in full, for comparing a run against the last. */
async function ourOrders() {
  const r = await admin.query(
    `SELECT id, status::text AS status, completed_at, updated_at
       FROM orders WHERE business_id = $1 ORDER BY id`,
    [biz],
  );
  return r.rows;
}

/** How many of this test's orders disagree with their rounds. */
async function ourDivergentCount(): Promise<number> {
  const r = await admin.query(
    `SELECT count(*)::int AS n FROM orders
      WHERE business_id = $1 AND status IS DISTINCT FROM derive_order_status(id)`,
    [biz],
  );
  return r.rows[0].n;
}

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  other = new Client({ connectionString: ADMIN_URL });
  await other.connect();

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
  await other.end();
  await admin.query("DELETE FROM businesses WHERE id = $1", [biz]);
  await admin.query("DELETE FROM users WHERE id = $1", [owner]);
  await admin.end();
});

describe("20261005098000_repair_derived_status", () => {
  it("repairs only what disagrees, and is a no-op from then on", async () => {
    // Precondition, so a seed that silently failed cannot be mistaken for a
    // repair that silently worked.
    expect((await orderRow(broken)).status).toBe("ready");

    // Everything below runs inside one transaction that is rolled back, and
    // every assertion is scoped to this test's own business.
    //
    // The statement under test is unqualified, because it is a migration and is
    // meant to be. This suite is not: vitest runs its files in parallel against
    // one database, and kitchen-policies.spec.ts hand-writes orders.status
    // fixtures its rounds do not derive — exactly the rows this repairs.
    // Committing a table-wide write in the middle of that would silently
    // rewrite another file's fixture, and asserting anything table-wide here
    // would observe it. Rolled back, neither can happen; and the SHARE ROW
    // EXCLUSIVE lock the migration takes holds other writers off for the few
    // milliseconds this runs, which is what makes the comparisons below
    // deterministic rather than a race.
    await admin.query("BEGIN");
    try {
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

      expect(await ourDivergentCount()).toBe(0);

      // The property that actually matters, asserted per row rather than by the
      // statement's table-wide row count: once the derivation holds, further
      // passes change nothing at all — which is also what a first pass against
      // a database the defect never ran on would do.
      const settled = await ourOrders();
      await admin.query(REPAIR);
      expect(await ourOrders()).toEqual(settled);
      await admin.query(REPAIR);
      expect(await ourOrders()).toEqual(settled);
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  // The LOCK TABLE this statement opens with is load-bearing, and reads as
  // noise: it is the kind of line a later edit deletes for tidiness. Without
  // it, an UPDATE that blocks on a concurrent writer and then unblocks rechecks
  // the target row at its new version but reuses the pre-snapshot tuple for the
  // joined `d` — so it writes a stale status over a freshly correct one. On the
  // very rows this repairs that means overwriting a brand-new round's 'placed'
  // with 'cancelled'. Asserting the exclusion behaviourally is the only way to
  // notice the line going missing.
  it("holds concurrent writers off orders while it runs", async () => {
    await admin.query("BEGIN");
    try {
      await admin.query(REPAIR);

      await other.query("BEGIN");
      await other.query("SET LOCAL lock_timeout = '250ms'");
      await expect(
        other.query(`UPDATE orders SET updated_at = now() WHERE id = $1`, [healthy]),
      ).rejects.toMatchObject({ code: "55P03" });
      await other.query("ROLLBACK");
    } finally {
      await admin.query("ROLLBACK");
    }

    // And lets them straight through again once it is done, so what the test
    // above saw was this statement's lock and not a table wedged by something
    // else.
    await other.query("BEGIN");
    await other.query("SET LOCAL lock_timeout = '250ms'");
    await other.query(`UPDATE orders SET updated_at = now() WHERE id = $1`, [healthy]);
    await other.query("ROLLBACK");
  });
});
