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
  "tables", "orders", "order_rounds", "order_items", "order_events",
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

async function countForBusiness(table: string, businessId: string): Promise<number> {
  const r = await app.query(`SELECT count(*)::int AS n FROM ${table} WHERE business_id = $1`, [
    businessId,
  ]);
  return r.rows[0].n;
}

/**
 * Seeds one row in every READABLE table for a venue, plus one in `bills`,
 * `bill_lines` and `order_ratings` — tables the kitchen role must NOT read —
 * so every assertion in this file is against a real, non-empty row rather
 * than an absence that would pass whether or not a policy existed.
 *
 * `menu_items` and `menu_item_variants` are inserted inside one transaction:
 * the price guard (see the `hardening` migration) is a DEFERRED constraint
 * trigger that only sees both rows together at COMMIT, and an item with
 * neither a price nor a variant yet would otherwise fail the moment it alone
 * is committed.
 */
async function seedVenue(businessId: string, tableLabel: string) {
  const table = await admin.query(
    `INSERT INTO tables (id, business_id, label, token, position)
     VALUES (gen_random_uuid(), $1, $2, $3, 1) RETURNING id`,
    [businessId, tableLabel, Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32)],
  );
  const tableId = table.rows[0].id as string;

  const category = await admin.query(
    `INSERT INTO menu_categories (id, business_id, name, position)
     VALUES (gen_random_uuid(), $1, 'Mains', 1) RETURNING id`,
    [businessId],
  );
  const categoryId = category.rows[0].id as string;

  await admin.query("BEGIN");
  let itemId: string;
  try {
    const item = await admin.query(
      `INSERT INTO menu_items (id, business_id, category_id, name, position, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'Thali', 1, now()) RETURNING id`,
      [businessId, categoryId],
    );
    itemId = item.rows[0].id as string;
    await admin.query(
      `INSERT INTO menu_item_variants (id, item_id, business_id, name, price, position)
       VALUES (gen_random_uuid(), $1, $2, 'Regular', 99.00, 1)`,
      [itemId, businessId],
    );
    await admin.query("COMMIT");
  } catch (err) {
    await admin.query("ROLLBACK");
    throw err;
  }

  await admin.query(
    `INSERT INTO menu_item_photos (id, item_id, business_id, storage_path, position)
     VALUES (gen_random_uuid(), $1, $2, '/fixture.jpg', 1)`,
    [itemId, businessId],
  );

  const order = await admin.query(
    `INSERT INTO orders (id, business_id, table_id, business_day, daily_number, updated_at)
     VALUES (gen_random_uuid(), $1, $2, CURRENT_DATE, 1, now()) RETURNING id`,
    [businessId, tableId],
  );
  const orderId = order.rows[0].id as string;

  const round = await admin.query(
    `INSERT INTO order_rounds
       (id, business_id, order_id, seq, business_day, kot_number, status, placed_at)
     VALUES (gen_random_uuid(), $1, $2, 1, CURRENT_DATE,
             next_kot_number($1, CURRENT_DATE), 'placed', now())
     RETURNING id`,
    [businessId, orderId],
  );

  await admin.query(
    `INSERT INTO order_items (id, order_id, business_id, name_snapshot, unit_price, quantity, round_id)
     VALUES (gen_random_uuid(), $1, $2, 'Thali', 99.00, 1, $3)`,
    [orderId, businessId, round.rows[0].id],
  );

  await admin.query(
    `INSERT INTO order_events (order_id, business_id, kind) VALUES ($1, $2, 'placed')`,
    [orderId, businessId],
  );

  await admin.query(
    `INSERT INTO notifications (business_id, kind, title, body)
     VALUES ($1, 'order_placed', 'New order', 'Table placed an order')`,
    [businessId],
  );

  return { tableId, orderId };
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

    // A full row in every READABLE table for both venues — the only way
    // "sees A, not B" and "every readable table is actually readable" mean
    // anything rather than passing vacuously against empty tables.
    const seedA = await seedVenue(bizA, "A1");
    await seedVenue(bizB, "B1");

    // Money tables kitchen must never see, non-empty for venue A specifically
    // so "gives a kitchen user no sight of money" tests a real denial.
    const bill = await admin.query(
      `INSERT INTO bills (
         id, business_id, order_id, bill_number, table_label,
         prices_include_tax, tax_label, service_charge_rate, business_snapshot,
         subtotal, tax_total, service_charge, round_off, total
       ) VALUES (
         gen_random_uuid(), $1, $2, 1, 'A1',
         true, 'GST', 0, '{}'::jsonb,
         99.00, 0, 0, 0, 99.00
       ) RETURNING id`,
      [bizA, seedA.orderId],
    );
    await admin.query(
      `INSERT INTO bill_lines (
         id, bill_id, business_id, name, quantity,
         unit_price, line_total, line_net, tax_rate, tax_amount, position
       ) VALUES (gen_random_uuid(), $1, $2, 'Thali', 1, 99.00, 99.00, 99.00, 0, 0, 1)`,
      [bill.rows[0].id, bizA],
    );
    await admin.query(
      `INSERT INTO order_ratings (id, business_id, order_id, table_id, stars)
       VALUES (gen_random_uuid(), $1, $2, $3, 5)`,
      [bizA, seedA.orderId, seedA.tableId],
    );
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

  // Review Focus 3: same role, different tenant — checked across every
  // readable table, not just `tables`, since each is a separate policy.
  it("shows a kitchen user nothing of another venue, for every readable table", async () => {
    await asUser(kitchenA, async () => {
      for (const t of READABLE) {
        expect(await countForBusiness(t, bizB)).toBe(0);
      }
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
    try {
      await asUser(kitchenA, async () => {
        expect(await count("businesses")).toBe(0);
        expect(await count("tables")).toBe(0);
      });
    } finally {
      await admin.query("UPDATE business_staff SET status='active' WHERE user_id=$1", [kitchenA]);
    }
  });

  it("leaves every readable table reachable, with venue A's own rows visible", async () => {
    await asUser(kitchenA, async () => {
      for (const t of READABLE) {
        await expect(count(t)).resolves.toBeGreaterThan(0);
      }
    });
  });

  it("creates no kitchen INSERT or DELETE policy", async () => {
    // migration.sql says this in a comment; the drift guard below only
    // checks table names, so a future `orders_kitchen_insert` would pass it
    // silently. This is the assertion that actually enforces the comment.
    const r = await admin.query(
      `SELECT policyname, cmd FROM pg_policies
        WHERE schemaname='public' AND policyname LIKE '%\\_kitchen\\_%'
          AND cmd IN ('INSERT', 'DELETE')`,
    );
    expect(r.rows).toEqual([]);
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
    // 15 pre-existing `_owner` policies, plus `business_staff_owner` from the
    // kitchen-policies migration — the owner's own counterpart to
    // `business_staff_self_read` — plus `order_rounds_owner` from the
    // order_rounds migration.
    const owned = r.rows.map((x) => x.tablename as string);
    expect(owned).toHaveLength(17);

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

  /**
   * RLS grants a whole row; these BEFORE UPDATE triggers are what narrows a
   * kitchen write down to a single column. Reuses the order and menu item
   * seeded for venue A in the outer beforeAll rather than inserting fresh
   * fixtures — those rows already exist and are cleaned up (via the
   * `businesses` cascade) by the outer afterAll.
   */
  describe("column guards", () => {
    let orderId: string;
    let itemId: string;
    let ownerPricedItemId: string;

    beforeAll(async () => {
      const o = await admin.query("SELECT id FROM orders WHERE business_id=$1", [bizA]);
      orderId = o.rows[0].id;
      const i = await admin.query("SELECT id FROM menu_items WHERE business_id=$1", [bizA]);
      itemId = i.rows[0].id;

      // The seeded item above (Thali) has a variant price and no base price —
      // menu_items_price_guard (a deferred constraint trigger from the
      // `hardening` migration) forbids a row having both, so it cannot take
      // a direct price update. One extra item, priced and variant-free, is
      // needed to exercise "owner sets menu_items.price" at all; it is
      // deleted in this describe's own afterAll.
      const categoryRow = await admin.query(
        "SELECT category_id FROM menu_items WHERE id=$1",
        [itemId],
      );
      const p = await admin.query(
        `INSERT INTO menu_items (id, business_id, category_id, name, price, position, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'Owner Priced Dish', 100.00, 2, now()) RETURNING id`,
        [bizA, categoryRow.rows[0].category_id],
      );
      ownerPricedItemId = p.rows[0].id;
    });

    afterAll(async () => {
      await admin.query("DELETE FROM menu_items WHERE id=$1", [ownerPricedItemId]);
    });

    it("lets the kitchen advance an order's status", async () => {
      await asUser(kitchenA, async () => {
        await app.query("UPDATE orders SET status='preparing' WHERE id=$1", [orderId]);
      });
      const r = await admin.query("SELECT status FROM orders WHERE id=$1", [orderId]);
      expect(r.rows[0].status).toBe("preparing");
    });

    // order_rounds_kitchen_update grants the whole row, exactly as
    // orders_kitchen_write does; order_rounds_kitchen_guard is what narrows
    // it. Without that trigger a kitchen account could rewrite order_id and
    // move a round — and every item hanging off it — onto a different order,
    // and so onto a different bill. Both halves in one test: the write the
    // kitchen is for must still work, or a guard that refused everything
    // would pass the negative half on its own.
    it("lets the kitchen advance a round but not renumber or re-parent it", async () => {
      const r = await admin.query("SELECT id FROM order_rounds WHERE business_id=$1", [bizA]);
      const roundId = r.rows[0].id;

      await asUser(kitchenA, async () => {
        await app.query("UPDATE order_rounds SET status='preparing' WHERE id=$1", [roundId]);
      });
      const moved = await admin.query("SELECT status FROM order_rounds WHERE id=$1", [roundId]);
      expect(moved.rows[0].status).toBe("preparing");

      await expect(
        asUser(kitchenA, () =>
          app.query("UPDATE order_rounds SET kot_number=999 WHERE id=$1", [roundId]),
        ),
      ).rejects.toThrow(/only change a round's status/);

      // A *different* order in the same business — the re-parenting that
      // moves a round's items onto someone else's bill. Its table and order
      // are left to the outer afterAll's `businesses` cascade.
      const t = await admin.query(
        `INSERT INTO tables (id, business_id, label, token, position)
         VALUES (gen_random_uuid(), $1, 'Guard1', $2, 200) RETURNING id`,
        [bizA, Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32)],
      );
      const other = await admin.query(
        `INSERT INTO orders (id, business_id, table_id, business_day, daily_number, updated_at)
         VALUES (gen_random_uuid(), $1, $2, CURRENT_DATE, 97, now()) RETURNING id`,
        [bizA, t.rows[0].id],
      );

      await expect(
        asUser(kitchenA, () =>
          app.query("UPDATE order_rounds SET order_id=$2 WHERE id=$1", [
            roundId,
            other.rows[0].id,
          ]),
        ),
      ).rejects.toThrow(/only change a round's status/);
    });

    it("refuses the kitchen the statuses that touch a bill", async () => {
      await expect(
        asUser(kitchenA, () =>
          app.query("UPDATE orders SET status='completed' WHERE id=$1", [orderId]),
        ),
      ).rejects.toThrow(/may not set order status/);
    });

    // Fix round 1, Important 1: the guard used to key its staff lookup on
    // NEW.business_id, so rewriting business_id to a venue the caller is
    // NOT staff of made the lookup find nothing, take the "not staff"
    // branch, and return NEW unexamined — skipping every column check,
    // including the one that would have caught the rewrite itself. It was
    // only ever caught by *_kitchen_write's WITH CHECK, a policy living in
    // a different migration. The guard now keys on OLD.business_id, so this
    // is the column-guard's own check: the trigger fires (and raises)
    // before Postgres ever evaluates WITH CHECK for an UPDATE.
    it("refuses the kitchen a rewrite of business_id itself", async () => {
      await expect(
        asUser(kitchenA, () =>
          app.query("UPDATE orders SET business_id=$2 WHERE id=$1", [orderId, bizB]),
        ),
      ).rejects.toThrow(/only change an order's status/);

      await expect(
        asUser(kitchenA, () =>
          app.query("UPDATE menu_items SET business_id=$2 WHERE id=$1", [itemId, bizB]),
        ),
      ).rejects.toThrow(/only change a dish's availability/);
    });

    it("refuses the kitchen any column but status", async () => {
      // Explicit, not inherited: this used to rely on an earlier test
      // having already moved the order to 'preparing', because the
      // whitelist ran unconditionally and 'placed' is not in it — on a
      // fresh 'placed' order the whitelist fired first and this regex
      // would not have matched. Fix round 1, Minor: the whitelist now only
      // runs when status actually changes, so this is set up explicitly
      // and holds regardless of what state earlier tests left the order in.
      await admin.query("UPDATE orders SET status='placed' WHERE id=$1", [orderId]);
      await expect(
        asUser(kitchenA, () => app.query("UPDATE orders SET note='changed' WHERE id=$1", [orderId])),
      ).rejects.toThrow(/only change an order's status/);
    });

    it("lets the kitchen toggle availability but not touch a price", async () => {
      await asUser(kitchenA, async () => {
        await app.query("UPDATE menu_items SET is_available=false WHERE id=$1", [itemId]);
      });
      const r = await admin.query("SELECT is_available FROM menu_items WHERE id=$1", [itemId]);
      expect(r.rows[0].is_available).toBe(false);

      await expect(
        asUser(kitchenA, () => app.query("UPDATE menu_items SET price=1.00 WHERE id=$1", [itemId])),
      ).rejects.toThrow(/only change a dish's availability/);
    });

    // Ruling 2's hole: the brief's own column list for menu_items omitted
    // created_at. The migration pins it anyway — this proves the guard
    // actually rejects it, not just that the brief forgot to ask.
    it("refuses the kitchen a column the brief's own list omitted: created_at", async () => {
      await expect(
        asUser(kitchenA, () =>
          app.query("UPDATE menu_items SET created_at=now() WHERE id=$1", [itemId]),
        ),
      ).rejects.toThrow(/only change a dish's availability/);
    });

    // Fix round 1, Important 2b: the existing suspension test only covers
    // reads. For a write, nothing in the column-guard trigger is what stops
    // a suspended staff member — app_staff_business_ids() filters on
    // status='active', so a suspended user's venue never appears in it,
    // orders_kitchen_write's USING clause then matches zero rows, and the
    // UPDATE affects nothing before the trigger ever runs. It does not
    // raise; asserted here as "no rows changed", not as a throw.
    it("lets a suspended staff member's write affect nothing, without raising", async () => {
      const before = await admin.query("SELECT status FROM orders WHERE id=$1", [orderId]);

      await admin.query("UPDATE business_staff SET status='suspended' WHERE user_id=$1", [kitchenA]);
      try {
        await asUser(kitchenA, async () => {
          const r = await app.query("UPDATE orders SET status='ready' WHERE id=$1", [orderId]);
          expect(r.rowCount).toBe(0);
        });
      } finally {
        await admin.query("UPDATE business_staff SET status='active' WHERE user_id=$1", [kitchenA]);
      }

      const after = await admin.query("SELECT status FROM orders WHERE id=$1", [orderId]);
      expect(after.rows[0].status).toBe(before.rows[0].status);
    });

    it("leaves the owner unrestricted", async () => {
      await asUser(ownerA, async () => {
        await app.query("UPDATE orders SET note='owner may' WHERE id=$1", [orderId]);
        await app.query("UPDATE menu_items SET price=150.00 WHERE id=$1", [ownerPricedItemId]);
      });
      const r = await admin.query("SELECT note FROM orders WHERE id=$1", [orderId]);
      expect(r.rows[0].note).toBe("owner may");
      const m = await admin.query("SELECT price FROM menu_items WHERE id=$1", [ownerPricedItemId]);
      expect(Number(m.rows[0].price)).toBe(150);
    });
  });

  /**
   * Task 5: who caused each order_events row. log_order_status_event is
   * SECURITY DEFINER because order_events has no kitchen INSERT policy
   * (only order_events_owner / ALL and order_events_kitchen_read / SELECT) —
   * drop SECURITY DEFINER and the kitchen's own status UPDATE below would be
   * refused by RLS. The first test is therefore also the regression test for
   * that: if it throws instead of succeeding, SECURITY DEFINER is gone.
   */
  describe("audit trail", () => {
    /**
     * Each test below gets its own table: the venue-A order seeded in the
     * outer beforeAll, and the one used by "column guards", both stay
     * "open" (orders_one_open_per_table) across these tests, so reusing
     * either table's existing order would collide with that constraint.
     */
    async function freshTable(label: string) {
      const t = await admin.query(
        `INSERT INTO tables (id, business_id, label, token, position)
         VALUES (gen_random_uuid(), $1, $2, $3, 100) RETURNING id`,
        [bizA, label, Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32)],
      );
      return t.rows[0].id as string;
    }

    it("records the kitchen user who advanced an order, and the write succeeds", async () => {
      const tableId = await freshTable("Audit2");
      const o = await admin.query(
        `INSERT INTO orders (id, business_id, table_id, business_day, daily_number, updated_at)
         VALUES (gen_random_uuid(), $1, $2, CURRENT_DATE, 99, now()) RETURNING id`,
        [bizA, tableId],
      );
      const id = o.rows[0].id;

      await asUser(kitchenA, async () => {
        const r = await app.query("UPDATE orders SET status='ready' WHERE id=$1", [id]);
        // The regression check for ruling 1: without SECURITY DEFINER, the
        // trigger's INSERT into order_events is refused by RLS and the
        // UPDATE fails outright rather than merely logging nothing.
        expect(r.rowCount).toBe(1);
      });

      const e = await admin.query(
        "SELECT actor_id FROM order_events WHERE order_id=$1 AND kind='ready'",
        [id],
      );
      expect(e.rows[0].actor_id).toBe(kitchenA);

      await admin.query("DELETE FROM orders WHERE id=$1", [id]);
      await admin.query("DELETE FROM tables WHERE id=$1", [tableId]);
    });

    // Same regression as the order-level test above, for order_rounds_log_status:
    // that trigger's INSERT into order_events runs in the kitchen account's own
    // session, which order_events' RLS (owner-only ALL, plus a kitchen SELECT)
    // does not grant INSERT to. Without SECURITY DEFINER on
    // order_rounds_log_status_fn, this UPDATE is the one a kitchen user issues
    // most often, and it would fail outright rather than merely logging nothing.
    it("records the kitchen user who advanced a round, and the write succeeds", async () => {
      const tableId = await freshTable("Audit4");
      const o = await admin.query(
        `INSERT INTO orders (id, business_id, table_id, business_day, daily_number, updated_at)
         VALUES (gen_random_uuid(), $1, $2, CURRENT_DATE, 96, now()) RETURNING id`,
        [bizA, tableId],
      );
      const orderId = o.rows[0].id;
      const round = await admin.query(
        `INSERT INTO order_rounds
           (id, business_id, order_id, seq, business_day, kot_number, status, placed_at)
         VALUES (gen_random_uuid(), $1, $2, 1, CURRENT_DATE,
                 next_kot_number($1, CURRENT_DATE), 'placed', now())
         RETURNING id`,
        [bizA, orderId],
      );
      const roundId = round.rows[0].id;

      await asUser(kitchenA, async () => {
        const r = await app.query("UPDATE order_rounds SET status='preparing' WHERE id=$1", [
          roundId,
        ]);
        expect(r.rowCount).toBe(1);
      });

      const e = await admin.query(
        "SELECT actor_id, round_id FROM order_events WHERE order_id=$1 AND kind='round.preparing'",
        [orderId],
      );
      expect(e.rows[0].actor_id).toBe(kitchenA);
      expect(e.rows[0].round_id).toBe(roundId);

      await admin.query("DELETE FROM orders WHERE id=$1", [orderId]);
      await admin.query("DELETE FROM tables WHERE id=$1", [tableId]);
    });

    it("records the owner who moved an order", async () => {
      const tableId = await freshTable("Audit3");
      const o = await admin.query(
        `INSERT INTO orders (id, business_id, table_id, business_day, daily_number, updated_at)
         VALUES (gen_random_uuid(), $1, $2, CURRENT_DATE, 98, now()) RETURNING id`,
        [bizA, tableId],
      );
      const id = o.rows[0].id;

      await asUser(ownerA, async () => {
        await app.query("UPDATE orders SET status='completed' WHERE id=$1", [id]);
      });

      const e = await admin.query(
        "SELECT actor_id FROM order_events WHERE order_id=$1 AND kind='completed'",
        [id],
      );
      expect(e.rows[0].actor_id).toBe(ownerA);

      await admin.query("DELETE FROM orders WHERE id=$1", [id]);
      await admin.query("DELETE FROM tables WHERE id=$1", [tableId]);
    });

    // The case most likely to regress: place_table_round runs with no
    // app.current_user_id at all — a diner placing an order through the
    // public menu, not a logged-in staff member — so its order_events row
    // must record no actor, not accidentally inherit one.
    it("leaves actor_id null for a diner-placed order with no user context", async () => {
      const tableId = await freshTable("Audit1");

      // A menu item of its own, available, rather than the seeded venue-A
      // item — the "column guards" tests above toggle that one unavailable
      // along the way and never flip it back. Item and variant are inserted
      // in one transaction: menu_items_price_guard is a DEFERRED constraint
      // trigger that only sees both rows together at COMMIT (see seedVenue).
      const category = await admin.query(
        "SELECT id FROM menu_categories WHERE business_id=$1 LIMIT 1",
        [bizA],
      );
      let itemId: string;
      await admin.query("BEGIN");
      try {
        const menuItem = await admin.query(
          `INSERT INTO menu_items (id, business_id, category_id, name, position, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'Audit Dish', 2, now()) RETURNING id`,
          [bizA, category.rows[0].id],
        );
        itemId = menuItem.rows[0].id;
        await admin.query(
          `INSERT INTO menu_item_variants (id, item_id, business_id, name, price, position)
           VALUES (gen_random_uuid(), $1, $2, 'Regular', 50.00, 1)`,
          [itemId, bizA],
        );
        await admin.query("COMMIT");
      } catch (err) {
        await admin.query("ROLLBACK");
        throw err;
      }
      const variant = await admin.query(
        "SELECT id FROM menu_item_variants WHERE item_id=$1",
        [itemId],
      );
      const variantId = variant.rows[0].id;

      // No set_config, no asUser: this is the unauthenticated diner path.
      const placed = await app.query(
        `SELECT place_table_round($1, $2, $3::jsonb) AS result`,
        [tableId, bizA, JSON.stringify([{ itemId, variantId, quantity: 1 }])],
      );
      expect(placed.rows[0].result).toBeTruthy();

      const order = await admin.query("SELECT id FROM orders WHERE table_id=$1", [tableId]);
      const orderId = order.rows[0].id;

      const e = await admin.query(
        "SELECT actor_id FROM order_events WHERE order_id=$1 AND kind='placed'",
        [orderId],
      );
      expect(e.rows[0].actor_id).toBeNull();

      await admin.query("DELETE FROM orders WHERE id=$1", [orderId]);
      await admin.query("DELETE FROM tables WHERE id=$1", [tableId]);
      await admin.query("DELETE FROM menu_items WHERE id=$1", [itemId]);
    });
  });
});
