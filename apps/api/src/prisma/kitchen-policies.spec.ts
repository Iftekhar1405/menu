import "../config/load-dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

/**
 * Policies asserted against a real database, because a policy is the one
 * thing that cannot be unit-tested honestly — its whole behaviour is the
 * database's, and a mock would only re-state what we hoped we wrote.
 *
 * Runs as menu_app, never as postgres: a superuser bypasses RLS entirely and
 * every assertion here would pass for the wrong reason.
 */
const APP_URL = process.env.APP_DATABASE_URL || process.env.DATABASE_URL;
const ADMIN_URL = process.env.DIRECT_URL;

/** Every table a kitchen user is allowed to read. */
const READABLE = [
  "tables", "orders", "order_items", "order_events",
  "menu_categories", "menu_items", "menu_item_variants",
  "menu_item_photos", "notifications",
];

/** Owner policies we have deliberately decided kitchen gets nothing from. */
const KITCHEN_DENIED = [
  "bills", "bill_lines", "order_ratings", "order_item_cancellations",
  "merch_orders", "merch_order_items", "merch_products",
  "menu_views", "review_prompts", "push_subscriptions",
];

let admin: Client;
let app: Client;
let ownerA: string, bizA: string, kitchenA: string;
let ownerB: string, bizB: string;

/** Runs a block with the tenant context a real request would carry. */
async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  await app.query("BEGIN");
  await app.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
  try {
    return await fn();
  } finally {
    await app.query("COMMIT");
  }
}

async function count(table: string): Promise<number> {
  const r = await app.query(`SELECT count(*)::int AS n FROM ${table}`);
  return r.rows[0].n;
}

describe.skipIf(!process.env.DATABASE_URL)("kitchen policies", () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: ADMIN_URL });
    app = new Client({ connectionString: APP_URL });
    await admin.connect();
    await app.connect();

    // Two tenants. Seeded as admin so RLS is not in the way of the fixture.
    // `updated_at` has no DB-level default anywhere in this schema — Prisma's
    // @updatedAt only fires through Prisma Client, not through a raw insert —
    // so every raw INSERT below sets it explicitly. `business_staff.id` has
    // no DB default either, so it is generated explicitly too.
    const mk = async (name: string) => {
      const u = await admin.query(
        `INSERT INTO users (id, pin_hash, full_name, phone, verified_at, updated_at)
         VALUES (gen_random_uuid(), 'x', $1, $2, now(), now()) RETURNING id`,
        [name, `+9199${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`],
      );
      const b = await admin.query(
        `INSERT INTO businesses (id, owner_id, name, type, public_code, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'cafe', $3, now()) RETURNING id`,
        [u.rows[0].id, `${name} Place`, Math.random().toString(36).slice(2, 10).toUpperCase()],
      );
      return { user: u.rows[0].id as string, biz: b.rows[0].id as string };
    };

    const a = await mk("PolicyA");
    const b = await mk("PolicyB");
    ownerA = a.user; bizA = a.biz;
    ownerB = b.user; bizB = b.biz;

    const k = await admin.query(
      `INSERT INTO users (id, pin_hash, full_name, role, verified_at, updated_at)
       VALUES (gen_random_uuid(), 'x', 'Kitchen A', 'kitchen', now(), now()) RETURNING id`,
    );
    kitchenA = k.rows[0].id;
    await admin.query(
      `INSERT INTO business_staff (id, business_id, user_id, updated_at)
       VALUES (gen_random_uuid(), $1, $2, now())`,
      [bizA, kitchenA],
    );

    // One table row in each venue, so "sees A, not B" has something to see.
    for (const [biz, label] of [[bizA, "A1"], [bizB, "B1"]] as const) {
      await admin.query(
        `INSERT INTO tables (id, business_id, label, token, position)
         VALUES (gen_random_uuid(), $1, $2, $3, 1)`,
        [biz, label, Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32)],
      );
    }
  });

  afterAll(async () => {
    for (const b of [bizA, bizB]) await admin.query("DELETE FROM businesses WHERE id = $1", [b]);
    for (const u of [ownerA, ownerB, kitchenA]) await admin.query("DELETE FROM users WHERE id = $1", [u]);
    await admin.end();
    await app.end();
  });

  it("shows a kitchen user their own venue", async () => {
    await asUser(kitchenA, async () => {
      const r = await app.query("SELECT id FROM businesses");
      expect(r.rows.map((x) => x.id)).toEqual([bizA]);
    });
  });

  // Review Focus 3: same role, different tenant.
  it("shows a kitchen user nothing of another venue", async () => {
    await asUser(kitchenA, async () => {
      const r = await app.query("SELECT count(*)::int AS n FROM tables WHERE business_id = $1", [bizB]);
      expect(r.rows[0].n).toBe(0);
    });
  });

  it("gives a kitchen user no sight of money", async () => {
    await asUser(kitchenA, async () => {
      for (const t of ["bills", "bill_lines", "order_ratings"]) {
        expect(await count(t)).toBe(0);
      }
    });
  });

  it("hides everything from a suspended staff member", async () => {
    await admin.query("UPDATE business_staff SET status='suspended' WHERE user_id=$1", [kitchenA]);
    await asUser(kitchenA, async () => {
      expect(await count("businesses")).toBe(0);
      expect(await count("tables")).toBe(0);
    });
    await admin.query("UPDATE business_staff SET status='active' WHERE user_id=$1", [kitchenA]);
  });

  it("leaves every readable table reachable", async () => {
    await asUser(kitchenA, async () => {
      for (const t of READABLE) {
        await expect(count(t)).resolves.toBeGreaterThanOrEqual(0);
      }
    });
  });

  /**
   * The drift guard. The two policy sets are parallel by decision, which is
   * the exact shape where a later feature updates one and forgets the other.
   */
  it("gives every owner policy a kitchen counterpart or an explicit denial", async () => {
    const r = await admin.query(
      `SELECT tablename FROM pg_policies
        WHERE schemaname='public' AND policyname LIKE '%\\_owner'`,
    );
    // 15 pre-existing `_owner` policies plus `business_staff_owner`, added by
    // this very migration (Part 2) — the owner's own counterpart to
    // `business_staff_self_read`. Verified directly against the dev
    // database after deploy; see task-3-report.md for the query.
    const owned = r.rows.map((x) => x.tablename as string);
    expect(owned).toHaveLength(16);

    const k = await admin.query(
      `SELECT DISTINCT tablename FROM pg_policies
        WHERE schemaname='public' AND policyname LIKE '%\\_kitchen\\_%'`,
    );
    const kitchen = new Set(k.rows.map((x) => x.tablename as string));

    // business_staff's kitchen-facing policy is business_staff_self_read: a
    // staff member reads their own row regardless of role, so — unlike every
    // other table — it is deliberately not named with "_kitchen_".
    const staffPolicies = await admin.query(
      `SELECT 1 FROM pg_policies
        WHERE schemaname='public' AND tablename='business_staff'
          AND policyname='business_staff_self_read'`,
    );
    const businessStaffHasSelfRead = staffPolicies.rowCount! > 0;

    for (const t of owned) {
      const covered =
        kitchen.has(t) ||
        KITCHEN_DENIED.includes(t) ||
        (t === "business_staff" && businessStaffHasSelfRead);
      expect(
        covered,
        `${t} has an owner policy but no kitchen policy and no explicit denial`,
      ).toBe(true);
    }
  });
});
