import "../config/load-dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { PrismaClient } from "@prisma/client";
import { OrdersService } from "./orders.service";

/**
 * The seam between `setStatus` and the derivation trigger, against a real
 * database.
 *
 * Both halves are already covered on their own — the trigger's arithmetic in
 * src/prisma/derive-order-status.spec.ts, the statement `setStatus` issues in
 * set-status-role.spec.ts — and neither notices if they stop meeting. Since
 * this method stopped writing `orders.status` there is nothing left in the
 * application that sets it, so "the UPDATE on the rounds actually fires the
 * trigger" is the whole mechanism by which a table is ever closed. A mock
 * cannot test that.
 *
 * Seeding runs as the admin role. The call under test does NOT: it goes
 * through a menu_app connection carrying `app.current_user_id`, exactly as
 * TenantInterceptor sets one up, because the trigger's UPDATE of `orders`
 * happens inside that session and has to clear its RLS and guards. Running it
 * as the superuser would bypass every policy and prove nothing.
 */
const ADMIN_URL = process.env.DIRECT_URL!;
const APP_URL = process.env.APP_DATABASE_URL || process.env.DATABASE_URL!;

let admin: Client;
let prisma: PrismaClient;
let owner: string, biz: string, table: string, order: string;

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();

  // `updated_at` has no database-level default anywhere in this schema —
  // Prisma's @updatedAt only fires through Prisma Client — so every raw
  // INSERT here sets it explicitly.
  const u = await admin.query(
    `INSERT INTO users (id, pin_hash, full_name, phone, verified_at, updated_at)
     VALUES (gen_random_uuid(), 'x', 'Close Owner', $1, now(), now()) RETURNING id`,
    [`+9199${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`],
  );
  owner = u.rows[0].id;

  const b = await admin.query(
    `INSERT INTO businesses (id, owner_id, name, public_code, type, currency, updated_at)
     VALUES (gen_random_uuid(), $1, 'Close Test', $2, 'restaurant', 'INR', now())
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

  const o = await admin.query(
    `INSERT INTO orders (id, business_id, table_id, status, business_day, daily_number, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'placed', CURRENT_DATE,
             next_daily_number($1, CURRENT_DATE), now())
     RETURNING id`,
    [biz, table],
  );
  order = o.rows[0].id;

  // Two rounds at different statuses, which is the case the hand-written
  // orders.status could not express and the reason this feature exists. The
  // derivation leaves the order at `preparing`, its least advanced live round.
  for (const [seq, status] of [
    [1, "ready"],
    [2, "preparing"],
  ] as const) {
    await admin.query(
      `INSERT INTO order_rounds
         (id, business_id, order_id, seq, business_day, kot_number, status, placed_at)
       VALUES (gen_random_uuid(), $1, $2, $3, CURRENT_DATE,
               next_kot_number($1, CURRENT_DATE), $4::"OrderStatus", now())`,
      [biz, order, seq, status],
    );
  }

  prisma = new PrismaClient({ datasources: { db: { url: APP_URL } } });
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
  await admin.query("DELETE FROM businesses WHERE id = $1", [biz]);
  await admin.query("DELETE FROM users WHERE id = $1", [owner]);
  await admin.end();
});

/**
 * `setStatus`, run the way a request runs it.
 *
 * TenantInterceptor opens one transaction per request and sets the user id on
 * its connection; `prisma.db` is that transaction's client. Reproduced here
 * rather than booting Nest, because the DI graph is not what is under test —
 * the SQL and the trigger are. Only the collaborators that are neither (auth,
 * notifications) are stubbed.
 */
async function closeTheTable(): Promise<string> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_user_id', ${owner}::text, true)`;
    const orders = new OrdersService(
      { db: tx } as never,
      { assertAccess: async () => ({ business: { id: biz }, role: "owner" }) } as never,
      {} as never,
      { announceStatus: async () => {}, announceReachedKitchen: async () => {} } as never,
    );
    const updated = await orders.setStatus(owner, biz, order, "completed");
    return updated.status;
  });
}

describe("closing a table, end to end", () => {
  it("completes every round and lets the trigger settle the order", async () => {
    expect(await closeTheTable()).toBe("completed");

    const o = await admin.query(
      `SELECT status::text AS s, completed_at FROM orders WHERE id = $1`,
      [order],
    );
    expect(o.rows[0].s).toBe("completed");
    // The trigger owns this column too, now that nothing writes it by hand.
    expect(o.rows[0].completed_at).not.toBeNull();

    const rounds = await admin.query(
      `SELECT status::text AS s FROM order_rounds WHERE order_id = $1 ORDER BY seq`,
      [order],
    );
    expect(rounds.rows.map((r) => r.s)).toEqual(["completed", "completed"]);
  });
});
