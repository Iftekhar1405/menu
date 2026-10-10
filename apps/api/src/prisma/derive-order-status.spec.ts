import "../config/load-dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

/**
 * The same matrix as packages/shared/src/rounds.spec.ts, asserted against
 * the database. Two implementations of one rule only stay in agreement if
 * both are tested against the same table of cases.
 *
 * Seeding and the status assertions run as the admin role: what is being
 * asserted is a trigger's arithmetic, not who may see it. The one test that
 * is about a role — the kitchen advancing a round — opens its own menu_app
 * connection, because the derivation's UPDATE of `orders` happens inside the
 * kitchen user's session and so has to clear that session's RLS and guards.
 */
const ADMIN_URL = process.env.DIRECT_URL!;
const APP_URL = process.env.APP_DATABASE_URL || process.env.DATABASE_URL!;

let admin: Client;
let app: Client;
let owner: string, kitchen: string, biz: string;

/**
 * A table of its own per order. `orders_one_open_per_table` allows a table
 * exactly one open order, and most tests here leave one behind.
 */
async function freshTable(): Promise<string> {
  const t = await admin.query(
    `INSERT INTO tables (id, business_id, label, token, position)
     VALUES (gen_random_uuid(), $1, '1', $2, 1) RETURNING id`,
    [biz, Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32)],
  );
  return t.rows[0].id as string;
}

async function orderWithRounds(statuses: string[]): Promise<string> {
  // `updated_at` has no database-level default anywhere in this schema —
  // Prisma's @updatedAt only fires through Prisma Client — so every raw
  // INSERT here sets it explicitly.
  const o = await admin.query(
    `INSERT INTO orders (id, business_id, table_id, status, business_day, daily_number, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'placed', CURRENT_DATE,
             next_daily_number($1, CURRENT_DATE), now())
     RETURNING id`,
    [biz, await freshTable()],
  );
  const orderId = o.rows[0].id as string;
  let seq = 1;
  for (const status of statuses) {
    await addRound(orderId, seq++, status);
  }
  return orderId;
}

async function addRound(orderId: string, seq: number, status: string): Promise<string> {
  const r = await admin.query(
    `INSERT INTO order_rounds
       (id, business_id, order_id, seq, business_day, kot_number, status, placed_at)
     VALUES (gen_random_uuid(), $1, $2, $3, CURRENT_DATE,
             next_kot_number($1, CURRENT_DATE), $4::"OrderStatus", now())
     RETURNING id`,
    [biz, orderId, seq, status],
  );
  return r.rows[0].id as string;
}

async function statusOf(orderId: string): Promise<string> {
  const r = await admin.query(`SELECT status::text AS s FROM orders WHERE id = $1`, [orderId]);
  return r.rows[0].s;
}

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();

  const mkUser = async (name: string) => {
    const u = await admin.query(
      `INSERT INTO users (id, pin_hash, full_name, phone, verified_at, updated_at)
       VALUES (gen_random_uuid(), 'x', $1, $2, now(), now()) RETURNING id`,
      [name, `+9199${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`],
    );
    return u.rows[0].id as string;
  };
  owner = await mkUser("Derive Owner");
  kitchen = await mkUser("Derive Kitchen");

  const b = await admin.query(
    `INSERT INTO businesses (id, owner_id, name, public_code, type, currency, updated_at)
     VALUES (gen_random_uuid(), $1, 'Derive Test', $2, 'restaurant', 'INR', now()) RETURNING id`,
    [owner, Math.random().toString(36).slice(2, 10).toUpperCase()],
  );
  biz = b.rows[0].id;

  await admin.query(
    `INSERT INTO business_staff (id, business_id, user_id, updated_at)
     VALUES (gen_random_uuid(), $1, $2, now())`,
    [biz, kitchen],
  );

  app = new Client({ connectionString: APP_URL });
  await app.connect();
});

afterAll(async () => {
  await app.end();
  await admin.query("DELETE FROM businesses WHERE id = $1", [biz]);
  await admin.query("DELETE FROM users WHERE id = ANY($1)", [[owner, kitchen]]);
  await admin.end();
});

describe("derive_order_status", () => {
  it("does not drag a ready round backwards when a new round lands", async () => {
    // This is the bug. Everything else in this migration exists to make it
    // possible to assert.
    const id = await orderWithRounds(["ready"]);
    expect(await statusOf(id)).toBe("ready");

    await addRound(id, 2, "placed");

    expect(await statusOf(id)).toBe("placed");
    const r = await admin.query(
      `SELECT status::text AS s FROM order_rounds WHERE order_id = $1 AND seq = 1`,
      [id],
    );
    expect(r.rows[0].s).toBe("ready");
  });

  it("completes only when every round is terminal, and stamps completed_at", async () => {
    const id = await orderWithRounds(["ready", "ready"]);

    await admin.query(
      `UPDATE order_rounds SET status = 'completed', completed_at = now()
       WHERE order_id = $1 AND seq = 1`,
      [id],
    );
    expect(await statusOf(id)).toBe("ready");

    await admin.query(
      `UPDATE order_rounds SET status = 'completed', completed_at = now()
       WHERE order_id = $1 AND seq = 2`,
      [id],
    );
    expect(await statusOf(id)).toBe("completed");

    const r = await admin.query(`SELECT completed_at FROM orders WHERE id = $1`, [id]);
    expect(r.rows[0].completed_at).not.toBeNull();
  });

  // Review Focus #1
  it("cancels, not completes, when every round is cancelled", async () => {
    const id = await orderWithRounds(["cancelled", "cancelled"]);
    expect(await statusOf(id)).toBe("cancelled");
  });

  /**
   * An aggregate over no rows still returns a row, so the terminal branch
   * answers for an order with no rounds unless it is told not to. Getting
   * this wrong closes an empty order instead of leaving it open — which
   * releases `orders_one_open_per_table` and hands the table a second bill.
   */
  it("leaves an order with no rounds left open rather than closing it", async () => {
    const id = await orderWithRounds(["placed"]);
    await admin.query(`DELETE FROM order_rounds WHERE order_id = $1`, [id]);

    expect(await statusOf(id)).toBe("placed");
    const r = await admin.query(`SELECT completed_at FROM orders WHERE id = $1`, [id]);
    expect(r.rows[0].completed_at).toBeNull();
  });

  /** Advances one round as an active kitchen staff user, over menu_app. */
  async function kitchenAccepts(orderId: string, seq: number) {
    await app.query("BEGIN");
    await app.query("SELECT set_config('app.current_user_id', $1, true)", [kitchen]);
    try {
      const n = await app.query(
        `UPDATE order_rounds SET status = 'accepted', accepted_at = now()
         WHERE order_id = $1 AND seq = $2`,
        [orderId, seq],
      );
      expect(n.rowCount).toBe(1);
      await app.query("COMMIT");
    } catch (err) {
      await app.query("ROLLBACK");
      throw err;
    }
  }

  /**
   * The derivation's UPDATE of `orders` runs in whatever session moved the
   * round — for the kitchen, a session that RLS and `orders_kitchen_guard`
   * both have opinions about.
   *
   * Two rounds, because the multi-round order is both the point of this
   * feature and the harder half of that interaction. Accepting KOT 1 while
   * KOT 2 is still waiting leaves the derived minimum at 'placed', so the
   * trigger writes 'placed' onto a row already sitting in 'placed' — a value
   * `orders_kitchen_guard` forbids the kitchen to *set*, and which only gets
   * through because 20261004034321_rbac_kitchen_guards_fix made that
   * whitelist conditional on the status actually changing. Simplify that
   * clause away and every kitchen accept on a multi-round order starts
   * raising 42501.
   *
   * Accepting KOT 2 afterwards is what proves the write lands at all: an
   * UPDATE that RLS filters out affects zero rows and raises nothing, so
   * "the order stayed 'placed'" would otherwise pass against a derivation
   * that silently did nothing.
   */
  it("carries the order with the round when the kitchen is the one moving it", async () => {
    const id = await orderWithRounds(["placed", "placed"]);

    await kitchenAccepts(id, 1);
    const r = await admin.query(
      `SELECT status::text AS s FROM order_rounds WHERE order_id = $1 AND seq = 1`,
      [id],
    );
    expect(r.rows[0].s).toBe("accepted");
    expect(await statusOf(id)).toBe("placed");

    await kitchenAccepts(id, 2);
    expect(await statusOf(id)).toBe("accepted");
  });
});
