# Round-Level Orders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A round added to an open order gets its own status, so a table that orders a chai no longer drags its already-ready biryani back to New.

**Architecture:** `order_items.batch` becomes a foreign key to a new `order_rounds` table that carries `status`, `kot_number` and its own timestamps. `orders.status` stays, but stops being written by hand — an `AFTER INSERT OR UPDATE` trigger on `order_rounds` derives it as the least advanced live round. Deriving rather than deleting the column keeps `orders_one_open_per_table`, `get_table_order`, the board query and the kitchen RLS policies working untouched.

**Tech Stack:** Postgres 16 (raw SQL migrations under Prisma 5.22), NestJS 10, Next.js 15, TypeScript 5.7, vitest 2.1, Playwright 1.49, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-10-04-kot-printing-design.md` (Part 1; Part 2 is a separate plan)

## Global Constraints

- Node >= 22, pnpm 10.33.2. Never run `npm` or `yarn`.
- Postgres runs locally via `pnpm db:up` on port **5433**.
- Migrations are **raw SQL** in `apps/api/prisma/migrations/<timestamp>_<name>/migration.sql`. The Prisma schema is edited to match, but the SQL is authoritative. Create migration directories by hand with a timestamp **later than `20260928000000`**.
- After editing `packages/shared`, run `pnpm --filter @menu/shared build` before typechecking or testing `apps/api` or `apps/web` — both consume its `dist/`.
- Database tests connect with `pg` as **`APP_DATABASE_URL` (the `menu_app` role), never `DIRECT_URL`**. A superuser bypasses RLS and every assertion would pass for the wrong reason. Use `DIRECT_URL` only for seeding fixtures.
- Test files are `*.spec.ts` and live beside the code (`src/**/*.spec.ts` for API, `{lib,components,app}/**/*.spec.ts` for web).
- Statuses are the existing `OrderStatus` enum: `placed, accepted, preparing, ready, completed, cancelled`. No new status values.
- `OPEN_STATUSES` = `placed, accepted, preparing, ready`, hand-written in SQL in several places. Any new copy must be named in the warning comment in `apps/api/src/orders/transitions.ts`.
- Commit after every task. Do not push.
- **Test what would silently break, not everything that could be asserted.** One test per behaviour that a bug would make wrong in production; no exhaustive matrices, no restating the happy path three ways. Every test below is there because its absence would let a real failure ship.

## Review Focus

Three things the spec implies that no happy path would catch. Each is pinned to a test in the task that owns the code.

1. **An order whose every round is cancelled must derive `cancelled`, not `completed`.** Deriving `completed` hands a bill to a table that cancelled everything. → Task 3.
2. **Two phones placing rounds on one table at once must get distinct `seq` and `kot_number`.** `MAX(seq) + 1` outside the advisory lock is a lost update. → Task 5.
3. **The role matrix must apply at round level** — a kitchen user moving a round to `completed` gets 403, `ready` succeeds. → Task 9.

---

### Task 1: `deriveOrderStatus` in `@menu/shared`

The SQL trigger and the browser both need to answer "what status is this order, given its rounds". Writing it here first gives the trigger a specification to match and the board a way to place a card without a round trip.

**Files:**
- Create: `packages/shared/src/rounds.ts`
- Create: `packages/shared/src/rounds.spec.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `OrderStatus` from `packages/shared/src/roles.ts`
- Produces: `deriveOrderStatus(roundStatuses: OrderStatus[]): OrderStatus`, `LIFECYCLE_ORDER: OrderStatus[]`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/rounds.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deriveOrderStatus } from "./rounds";

describe("deriveOrderStatus", () => {
  it("is the least advanced live round", () => {
    // The whole point: round 1 ready, round 2 just placed -> the order is
    // placed, because something on this table has not been started.
    expect(deriveOrderStatus(["ready", "placed"])).toBe("placed");
    expect(deriveOrderStatus(["completed", "preparing"])).toBe("preparing");
  });

  it("completes when every round is terminal and one completed", () => {
    expect(deriveOrderStatus(["completed", "cancelled"])).toBe("completed");
  });

  it("cancels only when every round is cancelled", () => {
    expect(deriveOrderStatus(["cancelled", "cancelled"])).toBe("cancelled");
  });
});```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @menu/shared exec vitest run src/rounds.spec.ts
```

Expected: FAIL — `Failed to resolve import "./rounds"`.

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/rounds.ts`:

```ts
import type { OrderStatus } from "./roles";

/**
 * The live statuses, least advanced first.
 *
 * This is the same list as OPEN_STATUSES in the API, and the same list the
 * derivation trigger walks in SQL. See the warning in
 * apps/api/src/orders/transitions.ts: adding a status here means adding it
 * there too, and the failure is silent.
 */
export const LIFECYCLE_ORDER: OrderStatus[] = [
  "placed",
  "accepted",
  "preparing",
  "ready",
];

/**
 * What an order's status is, given its rounds'.
 *
 * The least advanced live round, because an order is not ready while some
 * part of it has not been started. A table with a ready biryani and a just
 * -ordered chai is a table with something still to do, and the board must
 * show it that way.
 *
 * Terminal rounds are invisible while anything is live: a cancelled chai
 * must not hold an otherwise finished order open, and a completed first
 * round must not make a second round look served.
 *
 * Mirrored in SQL by derive_order_status(). The two are tested against the
 * same matrix; if you change one, change both.
 */
export function deriveOrderStatus(roundStatuses: OrderStatus[]): OrderStatus {
  const live = roundStatuses.filter((s) => LIFECYCLE_ORDER.includes(s));
  if (live.length > 0) {
    return LIFECYCLE_ORDER.find((s) => live.includes(s))!;
  }
  if (roundStatuses.length === 0) return "placed";
  // Every round is terminal. One completed round means food was served and a
  // bill is owed; only an entirely cancelled order is cancelled.
  return roundStatuses.includes("completed") ? "completed" : "cancelled";
}
```

- [ ] **Step 4: Export it**

Append to `packages/shared/src/index.ts`:

```ts
export * from "./rounds";
```

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @menu/shared exec vitest run src/rounds.spec.ts
pnpm --filter @menu/shared build
```

Expected: 3 passing, build clean.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/rounds.ts packages/shared/src/rounds.spec.ts packages/shared/src/index.ts
git commit -m "feat(shared): derive an order's status from its rounds"
```

---

### Task 2: The `order_rounds` table, backfilled from `batch`

**Files:**
- Create: `apps/api/prisma/migrations/20261005090000_order_rounds/migration.sql`
- Create: `apps/api/src/prisma/order-rounds.spec.ts`
- Modify: `apps/api/prisma/schema.prisma` (the `Order` and `OrderItem` models)

**Interfaces:**
- Produces: table `order_rounds (id, business_id, order_id, seq, business_day, kot_number, status, placed_at, accepted_at, completed_at)`; column `order_items.round_id`; function `next_kot_number(p_business_id uuid, p_day date) returns int`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/prisma/order-rounds.spec.ts`:

```ts
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
let bizA: string, bizB: string, orderA: string;

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();

  const biz = async (name: string) => {
    const r = await admin.query(
      `INSERT INTO businesses (id, owner_id, name, slug, type, currency)
       VALUES (gen_random_uuid(),
               (SELECT id FROM users ORDER BY created_at LIMIT 1),
               $1, $2, 'restaurant', 'INR') RETURNING id`,
      [name, name.toLowerCase().replace(/\W/g, "-") + "-" + Date.now()],
    );
    return r.rows[0].id as string;
  };
  bizA = await biz("Rounds Test A");
  bizB = await biz("Rounds Test B");

  const t = await admin.query(
    `INSERT INTO tables (id, business_id, label, token, position)
     VALUES (gen_random_uuid(), $1, '1', $2, 1) RETURNING id`,
    [bizA, Date.now().toString(16).padEnd(32, "0").slice(0, 32)],
  );
  const o = await admin.query(
    `INSERT INTO orders (id, business_id, table_id, status, business_day, daily_number)
     VALUES (gen_random_uuid(), $1, $2, 'placed', CURRENT_DATE, 9001) RETURNING id`,
    [bizA, t.rows[0].id],
  );
  orderA = o.rows[0].id;
});

afterAll(async () => {
  await admin.query("DELETE FROM businesses WHERE id = ANY($1)", [[bizA, bizB]]);
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

  it("restarts kot_number per business day", async () => {
    // "Re-fire KOT 38" has to mean one ticket. A serial that did not restart
    // per day would make it ambiguous every morning.
    const fresh = await admin.query(`SELECT next_kot_number($1, CURRENT_DATE + 7) AS n`, [bizA]);
    expect(fresh.rows[0].n).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm db:up
pnpm --filter @menu/api exec vitest run src/prisma/order-rounds.spec.ts
```

Expected: FAIL — `relation "order_rounds" does not exist`.

- [ ] **Step 3: Write the migration**

Create `apps/api/prisma/migrations/20261005090000_order_rounds/migration.sql`:

```sql
-- A round becomes a thing that has a status.
--
-- Until now a round was order_items.batch: an integer with nowhere to hang a
-- status, a KOT number or a timestamp. Status lived on the order, so
-- place_table_round reset the whole order to 'placed' whenever a table added
-- anything, dragging food that was already ready back to the New column.
--
-- This migration only creates and backfills the structure. The trigger that
-- derives orders.status, and the rewrite of place_table_round, follow in
-- their own migrations so each can be reverted on its own.

CREATE TABLE order_rounds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id     uuid NOT NULL REFERENCES orders(id)     ON DELETE CASCADE,

  -- 1-based, per order. Migrated straight across from order_items.batch so
  -- nothing renumbers and "round 2" still means what it meant yesterday.
  seq          int  NOT NULL,

  -- Denormalised from orders so the KOT serial is unique without a join, and
  -- so a round placed either side of midnight keeps the day it was placed on.
  business_day date NOT NULL,
  -- What the pass calls a ticket. Per business, per day, like daily_number.
  kot_number   int  NOT NULL,

  status       "OrderStatus" NOT NULL DEFAULT 'placed',
  placed_at    timestamptz(6) NOT NULL DEFAULT now(),
  accepted_at  timestamptz(6),
  completed_at timestamptz(6),

  CONSTRAINT order_rounds_order_id_seq_key UNIQUE (order_id, seq),
  CONSTRAINT order_rounds_kot_key UNIQUE (business_id, business_day, kot_number)
);

CREATE INDEX order_rounds_business_status_idx ON order_rounds (business_id, status);
CREATE INDEX order_rounds_order_idx           ON order_rounds (order_id, seq);

-- The next KOT serial for a business on a day.
--
-- Shaped exactly like next_daily_number: callers take the table's advisory
-- lock first, so this is a plain MAX rather than a sequence. A sequence would
-- be per-database and could not restart per business per day.
CREATE OR REPLACE FUNCTION next_kot_number(p_business_id uuid, p_day date)
RETURNS int
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(MAX(kot_number), 0) + 1
  FROM order_rounds
  WHERE business_id = p_business_id AND business_day = p_day;
$$;

ALTER TABLE order_items ADD COLUMN round_id uuid REFERENCES order_rounds(id) ON DELETE CASCADE;

-- Backfill. One round per distinct (order_id, batch), carrying batch across
-- as seq. KOT numbers are allocated per business-day in the order the rounds
-- were actually placed, so historical tickets get stable, sensible numbers
-- rather than nulls.
INSERT INTO order_rounds (id, business_id, order_id, seq, business_day, kot_number, status, placed_at, completed_at)
SELECT
  gen_random_uuid(),
  o.business_id,
  o.id,
  b.batch,
  o.business_day,
  row_number() OVER (
    PARTITION BY o.business_id, o.business_day
    ORDER BY b.first_at, o.id, b.batch
  ),
  o.status,
  b.first_at,
  o.completed_at
FROM orders o
JOIN (
  SELECT order_id, batch, MIN(created_at) AS first_at
  FROM order_items
  GROUP BY order_id, batch
) b ON b.order_id = o.id;

UPDATE order_items i
SET round_id = r.id
FROM order_rounds r
WHERE r.order_id = i.order_id AND r.seq = i.batch;

-- An order with no items at all has no round; it also has no bill and no
-- meaning. Give it one so the derivation trigger is never asked about an
-- empty set in production.
INSERT INTO order_rounds (id, business_id, order_id, seq, business_day, kot_number, status, placed_at, completed_at)
SELECT
  gen_random_uuid(), o.business_id, o.id, 1, o.business_day,
  COALESCE((SELECT MAX(kot_number) FROM order_rounds r2
            WHERE r2.business_id = o.business_id AND r2.business_day = o.business_day), 0)
    + row_number() OVER (PARTITION BY o.business_id, o.business_day ORDER BY o.id),
  o.status, o.placed_at, o.completed_at
FROM orders o
WHERE NOT EXISTS (SELECT 1 FROM order_rounds r WHERE r.order_id = o.id);

ALTER TABLE order_items ALTER COLUMN round_id SET NOT NULL;
ALTER TABLE order_items DROP COLUMN batch;

CREATE INDEX order_items_round_idx ON order_items (round_id, created_at);

-- RLS, in the same shape as order_items: owners reach their own venue's
-- rounds, kitchen staff reach the venues they work at.
ALTER TABLE order_rounds ENABLE ROW LEVEL SECURITY;

CREATE POLICY order_rounds_owner ON order_rounds
  FOR ALL
  USING (business_id IN (
    SELECT id FROM businesses WHERE owner_id = current_app_user()
  ))
  WITH CHECK (business_id IN (
    SELECT id FROM businesses WHERE owner_id = current_app_user()
  ));

CREATE POLICY order_rounds_kitchen_read ON order_rounds
  FOR SELECT
  USING (business_id IN (
    SELECT business_id FROM business_staff
    WHERE user_id = current_app_user() AND role = 'kitchen'
  ));

-- Kitchen may move a round along and nothing else. Mirrors the single-column
-- restriction already on orders.
CREATE POLICY order_rounds_kitchen_update ON order_rounds
  FOR UPDATE
  USING (business_id IN (
    SELECT business_id FROM business_staff
    WHERE user_id = current_app_user() AND role = 'kitchen'
  ))
  WITH CHECK (business_id IN (
    SELECT business_id FROM business_staff
    WHERE user_id = current_app_user() AND role = 'kitchen'
  ));

GRANT SELECT, INSERT, UPDATE ON order_rounds TO menu_app;
GRANT EXECUTE ON FUNCTION next_kot_number(uuid, date) TO menu_app;
```

**Before writing this, read `apps/api/prisma/migrations/` for the exact name of the helper used in existing policies** (`current_app_user()` above is a placeholder for whatever the kitchen RLS migration `144f88d` actually calls). Run:

```bash
grep -rn "CREATE POLICY order_items" apps/api/prisma/migrations/
```

and copy the `USING` clause verbatim, substituting the table name. Do not invent a new helper.

- [ ] **Step 4: Apply it and run the test**

```bash
pnpm --filter @menu/api exec prisma migrate dev
pnpm --filter @menu/api exec vitest run src/prisma/order-rounds.spec.ts
```

Expected: 3 passing.

- [ ] **Step 5: Bring the Prisma schema into line**

In `apps/api/prisma/schema.prisma`, add the model and swap `batch` for the relation:

```prisma
/// One round of an order: what a table asked for in one go.
///
/// Status lives here rather than on the order so a chai ordered at 9pm does
/// not drag a biryani that is already ready back to New. The order's own
/// status is derived from these by trigger — see derive_order_status().
model OrderRound {
  id          String      @id @default(uuid()) @db.Uuid
  businessId  String      @map("business_id") @db.Uuid
  orderId     String      @map("order_id") @db.Uuid
  /// 1-based, per order. Migrated from the old order_items.batch.
  seq         Int
  /// Denormalised from the order so the KOT serial needs no join.
  businessDay DateTime    @map("business_day") @db.Date
  /// What the pass calls this ticket. Per business, per day.
  kotNumber   Int         @map("kot_number")
  status      OrderStatus @default(placed)
  placedAt    DateTime    @default(now()) @map("placed_at") @db.Timestamptz(6)
  acceptedAt  DateTime?   @map("accepted_at") @db.Timestamptz(6)
  completedAt DateTime?   @map("completed_at") @db.Timestamptz(6)

  business Business    @relation(fields: [businessId], references: [id], onDelete: Cascade)
  order    Order       @relation(fields: [orderId], references: [id], onDelete: Cascade)
  items    OrderItem[]
  events   OrderEvent[]

  @@unique([orderId, seq])
  @@unique([businessId, businessDay, kotNumber])
  @@index([businessId, status])
  @@index([orderId, seq])
  @@map("order_rounds")
}
```

In `OrderItem`, replace `batch Int` with:

```prisma
  roundId String @map("round_id") @db.Uuid

  round OrderRound @relation(fields: [roundId], references: [id], onDelete: Cascade)
```

and replace `@@index([orderId, batch])` with `@@index([roundId, createdAt])`.

Add `rounds OrderRound[]` to the `Order` model and `orderRounds OrderRound[]` to `Business`.

- [ ] **Step 6: Verify the schema matches the database**

```bash
pnpm --filter @menu/api exec prisma generate
pnpm --filter @menu/api exec prisma migrate diff \
  --from-schema-datamodel prisma/schema.prisma \
  --to-schema-datasource prisma/schema.prisma --exit-code
```

Expected: exit code 0 and "No difference detected". If it reports a difference, the hand-written SQL and the schema disagree — fix the schema, never add a second migration.

- [ ] **Step 7: Add the new table to the RLS drift guard**

`apps/api/src/prisma/kitchen-policies.spec.ts` asserts, against a real
database as `menu_app`, exactly which tables a kitchen user can read. A new
table carrying order data that is not in that list is a hole nobody would
notice. Add `"order_rounds"` to the `READABLE` array — one line, and the
existing seeding helper already creates the rows it needs once `seedVenue`
inserts a round (update it to insert one, since `order_items.round_id` is now
`NOT NULL` and its existing insert will otherwise fail).

```bash
pnpm --filter @menu/api exec vitest run src/prisma/kitchen-policies.spec.ts
```

Expected: green. A failure here means the policy is wrong, not the test.

- [ ] **Step 8: Commit**

```bash
git add apps/api/prisma/migrations/20261005090000_order_rounds apps/api/prisma/schema.prisma apps/api/src/prisma/order-rounds.spec.ts apps/api/src/prisma/kitchen-policies.spec.ts
git commit -m "feat(db): make a round a first-class row with its own status"
```

---

### Task 3: Derive `orders.status` from its rounds

**Files:**
- Create: `apps/api/prisma/migrations/20261005091000_derive_order_status/migration.sql`
- Create: `apps/api/src/prisma/derive-order-status.spec.ts`
- Modify: `apps/api/src/orders/transitions.ts` (the `OPEN_STATUSES` warning comment)

**Interfaces:**
- Consumes: `order_rounds` from Task 2; the matrix in `packages/shared/src/rounds.spec.ts` from Task 1
- Produces: `derive_order_status(p_order_id uuid) returns "OrderStatus"`; trigger `order_rounds_derive_status` on `order_rounds`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/prisma/derive-order-status.spec.ts`:

```ts
import "../config/load-dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

/**
 * The same matrix as packages/shared/src/rounds.spec.ts, asserted against
 * the database. Two implementations of one rule only stay in agreement if
 * both are tested against the same table of cases.
 */
const ADMIN_URL = process.env.DIRECT_URL!;

let admin: Client;
let biz: string, table: string;

async function orderWithRounds(statuses: string[]): Promise<string> {
  const o = await admin.query(
    `INSERT INTO orders (id, business_id, table_id, status, business_day, daily_number)
     VALUES (gen_random_uuid(), $1, $2, 'placed', CURRENT_DATE,
             next_daily_number($1, CURRENT_DATE))
     RETURNING id`,
    [biz, table],
  );
  const orderId = o.rows[0].id as string;
  let seq = 1;
  for (const status of statuses) {
    await admin.query(
      `INSERT INTO order_rounds
         (id, business_id, order_id, seq, business_day, kot_number, status, placed_at)
       VALUES (gen_random_uuid(), $1, $2, $3, CURRENT_DATE,
               next_kot_number($1, CURRENT_DATE), $4::"OrderStatus", now())`,
      [biz, orderId, seq++, status],
    );
  }
  return orderId;
}

async function statusOf(orderId: string): Promise<string> {
  const r = await admin.query(`SELECT status::text AS s FROM orders WHERE id = $1`, [orderId]);
  return r.rows[0].s;
}

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const b = await admin.query(
    `INSERT INTO businesses (id, owner_id, name, slug, type, currency)
     VALUES (gen_random_uuid(), (SELECT id FROM users ORDER BY created_at LIMIT 1),
             'Derive Test', $1, 'restaurant', 'INR') RETURNING id`,
    ["derive-test-" + Date.now()],
  );
  biz = b.rows[0].id;
  const t = await admin.query(
    `INSERT INTO tables (id, business_id, label, token, position)
     VALUES (gen_random_uuid(), $1, '1', $2, 1) RETURNING id`,
    [biz, Date.now().toString(16).padEnd(32, "0").slice(0, 32)],
  );
  table = t.rows[0].id;
});

afterAll(async () => {
  await admin.query("DELETE FROM businesses WHERE id = $1", [biz]);
  await admin.end();
});

describe("derive_order_status", () => {
  it("does not drag a ready round backwards when a new round lands", async () => {
    // This is the bug. Everything else in this migration exists to make it
    // possible to assert.
    const id = await orderWithRounds(["ready"]);
    expect(await statusOf(id)).toBe("ready");

    await admin.query(
      `INSERT INTO order_rounds
         (id, business_id, order_id, seq, business_day, kot_number, status, placed_at)
       VALUES (gen_random_uuid(), $1, $2, 2, CURRENT_DATE,
               next_kot_number($1, CURRENT_DATE), 'placed', now())`,
      [biz, id],
    );

    expect(await statusOf(id)).toBe("placed");
    const r = await admin.query(
      `SELECT status::text AS s FROM order_rounds WHERE order_id = $1 AND seq = 1`, [id],
    );
    expect(r.rows[0].s).toBe("ready");
  });

  it("completes only when every round is terminal, and stamps completed_at", async () => {
    const id = await orderWithRounds(["ready"]);
    await admin.query(
      `UPDATE order_rounds SET status = 'completed', completed_at = now() WHERE order_id = $1`, [id],
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
});
```

Note: each `it` that needs a fresh open order must use a fresh table, because `orders_one_open_per_table` forbids two. Add a `freshTable()` helper that inserts a table with a random token and use it inside `orderWithRounds`.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @menu/api exec vitest run src/prisma/derive-order-status.spec.ts
```

Expected: FAIL — the order stays `placed` because nothing derives it yet.

- [ ] **Step 3: Write the migration**

Create `apps/api/prisma/migrations/20261005091000_derive_order_status/migration.sql`:

```sql
-- orders.status stops being written by hand.
--
-- The column stays, because four things read it and would all have to be
-- rewritten if it went: the orders_one_open_per_table partial unique index
-- (the only thing stopping a table getting two bills), get_table_order, the
-- board's status filter, and the kitchen RLS policies. Deriving keeps every
-- one of them correct for free.
--
-- WARNING: the open-status list below is the fifth hand-written copy. See
-- apps/api/src/orders/transitions.ts.

CREATE OR REPLACE FUNCTION derive_order_status(p_order_id uuid)
RETURNS "OrderStatus"
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    -- The least advanced live round. An order is not ready while some part
    -- of it has not been started.
    (SELECT r.status
     FROM order_rounds r
     WHERE r.order_id = p_order_id
       AND r.status IN ('placed','accepted','preparing','ready')
     ORDER BY array_position(
       ARRAY['placed','accepted','preparing','ready']::"OrderStatus"[], r.status)
     LIMIT 1),
    -- Everything is terminal. One completed round means food was served and
    -- a bill is owed; only an entirely cancelled order is cancelled.
    (SELECT CASE WHEN bool_or(r.status = 'completed') THEN 'completed' ELSE 'cancelled' END
     FROM order_rounds r WHERE r.order_id = p_order_id),
    -- No rounds at all: only reachable mid-transaction, inside
    -- place_table_round. Stay inside the open set and out of billing.
    'placed'::"OrderStatus"
  );
$$;

CREATE OR REPLACE FUNCTION order_rounds_derive_status_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_order_id uuid := COALESCE(NEW.order_id, OLD.order_id);
  v_status   "OrderStatus";
BEGIN
  v_status := derive_order_status(v_order_id);

  UPDATE orders SET
    status = v_status,
    -- Set on the way into a terminal state, cleared on the way out of one.
    -- An order can leave 'completed' only if a round is reopened, which the
    -- state machine forbids; clearing is belt and braces.
    completed_at = CASE
                     WHEN v_status IN ('completed','cancelled')
                       THEN COALESCE(completed_at, now())
                     ELSE NULL
                   END,
    updated_at = now()
  WHERE id = v_order_id AND (status IS DISTINCT FROM v_status OR updated_at < now());

  RETURN NULL;
END;
$$;

CREATE TRIGGER order_rounds_derive_status
AFTER INSERT OR UPDATE OF status OR DELETE ON order_rounds
FOR EACH ROW EXECUTE FUNCTION order_rounds_derive_status_fn();

GRANT EXECUTE ON FUNCTION derive_order_status(uuid) TO menu_app;
```

- [ ] **Step 4: Apply and run**

```bash
pnpm --filter @menu/api exec prisma migrate dev
pnpm --filter @menu/api exec vitest run src/prisma/derive-order-status.spec.ts
```

Expected: 3 passing.

- [ ] **Step 5: Name the new copy in the drift warning**

In `apps/api/src/orders/transitions.ts`, extend the existing `WARNING` comment above `OPEN_STATUSES`:

```ts
/**
 * What counts as an order still in play.
 *
 * WARNING: this list is written out by hand in five other places, all of them
 * SQL — the `orders_one_open_per_table` unique index, `place_table_round`'s
 * lookup of the order to append to, `get_table_order`'s WHERE clause, and
 * `derive_order_status`, which walks it in order to pick the least advanced
 * live round. Adding a status here without adding it there does not fail
 * loudly: the index silently stops constraining accepted orders, a table ends
 * up with two open orders and two bills, and the derivation quietly treats
 * the new status as terminal. See the 20260927110000_order_events and
 * 20261005091000_derive_order_status migrations.
 */
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/prisma/migrations/20261005091000_derive_order_status apps/api/src/prisma/derive-order-status.spec.ts apps/api/src/orders/transitions.ts
git commit -m "feat(db): derive orders.status from its rounds"
```

---

### Task 4: Round events

The board's timeline and (later) KOT printing both hang off `order_events`. Status changes now happen to rounds, so the trigger that logs them has to follow.

**Files:**
- Create: `apps/api/prisma/migrations/20261005092000_round_events/migration.sql`
- Modify: `apps/api/prisma/schema.prisma` (`OrderEvent`)

**Interfaces:**
- Produces: `order_events.round_id uuid null`; events `round.accepted`, `round.preparing`, `round.ready`, `round.completed`, `round.cancelled`, each with `round_id` set and `data = { seq, kotNumber }`. The existing `orders` trigger is left alone and keeps writing `completed` / `cancelled` with `round_id` null.

- [ ] **Step 1: Write the migration**

```sql
-- Status changes happen to rounds now, so the log of them follows.
--
-- The trigger on `orders` is deliberately NOT removed. It keeps logging the
-- order's own transitions, which is what the diner's "your table is settled"
-- line reads and what the bill will hang off. Round events and order events
-- are different facts about different things.

ALTER TABLE order_events ADD COLUMN round_id uuid REFERENCES order_rounds(id) ON DELETE CASCADE;
CREATE INDEX order_events_round_idx ON order_events (round_id, id);

CREATE OR REPLACE FUNCTION order_rounds_log_status_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NULL;
  END IF;

  INSERT INTO order_events (order_id, business_id, round_id, kind, data, actor_id)
  VALUES (
    NEW.order_id, NEW.business_id, NEW.id,
    'round.' || NEW.status::text,
    jsonb_build_object('seq', NEW.seq, 'kotNumber', NEW.kot_number),
    -- Set by the API before it writes; null for anything the database did
    -- on its own, which is honest: we do not know who.
    NULLIF(current_setting('app.current_user_id', true), '')::uuid
  );
  RETURN NULL;
END;
$$;

CREATE TRIGGER order_rounds_log_status
AFTER UPDATE OF status ON order_rounds
FOR EACH ROW EXECUTE FUNCTION order_rounds_log_status_fn();
```

Note there is no `AFTER INSERT` trigger: a round's arrival is already logged by `place_table_round` as `placed` / `round_added`, with the item list in `data`, and a second event for the same moment would double every notification.

- [ ] **Step 2: Apply it, and add `roundId` to the `OrderEvent` model**

```bash
pnpm --filter @menu/api exec prisma migrate dev
```

In `schema.prisma`, add to `OrderEvent`:

```prisma
  /// Null for order-level events; set for anything that happened to one round.
  roundId String? @map("round_id") @db.Uuid

  round OrderRound? @relation(fields: [roundId], references: [id], onDelete: Cascade)
```

and `@@index([roundId, id])`.

- [ ] **Step 3: Verify and commit**

```bash
pnpm --filter @menu/api exec prisma generate
pnpm --filter @menu/api exec prisma migrate diff \
  --from-schema-datamodel prisma/schema.prisma \
  --to-schema-datasource prisma/schema.prisma --exit-code
git add apps/api/prisma/migrations/20261005092000_round_events apps/api/prisma/schema.prisma
git commit -m "feat(db): log round status changes as round events"
```

---

### Task 5: `place_table_round` stops resetting the order

The fix itself.

**Files:**
- Create: `apps/api/prisma/migrations/20261005093000_place_round_per_round/migration.sql`
- Create: `apps/api/src/prisma/place-round.spec.ts`

**Interfaces:**
- Consumes: `next_kot_number` (Task 2), the derivation trigger (Task 3)
- Produces: `place_table_round` unchanged in signature and return shape; it now inserts an `order_rounds` row instead of touching `orders.status`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/prisma/place-round.spec.ts`. Two tests only: the bug, and the race.

```ts
import "../config/load-dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

const ADMIN_URL = process.env.DIRECT_URL!;
let admin: Client;
let biz: string, table: string, itemId: string;

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const b = await admin.query(
    `INSERT INTO businesses (id, owner_id, name, slug, type, currency)
     VALUES (gen_random_uuid(), (SELECT id FROM users ORDER BY created_at LIMIT 1),
             'Place Round Test', $1, 'restaurant', 'INR') RETURNING id`,
    ["place-round-" + Date.now()],
  );
  biz = b.rows[0].id;
  const t = await admin.query(
    `INSERT INTO tables (id, business_id, label, token, position)
     VALUES (gen_random_uuid(), $1, '1', $2, 1) RETURNING id`,
    [biz, Date.now().toString(16).padEnd(32, "0").slice(0, 32)],
  );
  table = t.rows[0].id;
  const cat = await admin.query(
    `INSERT INTO menu_categories (id, business_id, name, position)
     VALUES (gen_random_uuid(), $1, 'Drinks', 0) RETURNING id`, [biz],
  );
  const item = await admin.query(
    `INSERT INTO menu_items (id, business_id, category_id, name, price, is_available, position)
     VALUES (gen_random_uuid(), $1, $2, 'Irani Chai', 30.00, true, 0) RETURNING id`,
    [biz, cat.rows[0].id],
  );
  itemId = item.rows[0].id;
});

afterAll(async () => {
  await admin.query("DELETE FROM businesses WHERE id = $1", [biz]);
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
       ORDER BY seq`, [table],
    );
    expect(r.rows.map((x) => [x.seq, x.s])).toEqual([[1, "ready"], [2, "placed"]]);
  });

  // Review Focus #2
  it("gives concurrent rounds distinct seq and kot_number", async () => {
    const a = new Client({ connectionString: ADMIN_URL });
    const b = new Client({ connectionString: ADMIN_URL });
    await a.connect(); await b.connect();
    try {
      await Promise.all([
        a.query(`SELECT place_table_round($1, $2, $3::jsonb)`, [table, biz, lines(1)]),
        b.query(`SELECT place_table_round($1, $2, $3::jsonb)`, [table, biz, lines(1)]),
      ]);
    } finally {
      await a.end(); await b.end();
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
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @menu/api exec vitest run src/prisma/place-round.spec.ts
```

Expected: FAIL — round 1 reads `placed`, because the old function reset the order and the derivation pushed it back down.

- [ ] **Step 3: Write the migration**

Create `apps/api/prisma/migrations/20261005093000_place_round_per_round/migration.sql`. Start from the body in `20260928000000_order_round_fixes/migration.sql` and change four things; keep everything else — the availability checks, the price lookups, the `is_running` logic and the event payload — exactly as it is.

```sql
-- Rounds stop dragging each other backwards.
--
-- The old function ended every new round with
--   UPDATE orders SET status = 'placed'
-- so a table whose biryani was already ready was thrown back to New because
-- someone ordered a chai. Now the round carries its own status and the order's
-- is derived, so the reset is not only unnecessary, it is wrong.

CREATE OR REPLACE FUNCTION place_table_round(
  p_table_id    uuid,
  p_business_id uuid,
  p_lines       jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_id    uuid;
  v_round_id    uuid;
  v_seq         int;
  v_kot         int;
  v_day         date := CURRENT_DATE;
  v_daily       int;
  v_line        jsonb;
  v_item        record;
  v_variant     record;
  v_price       numeric(10,2);
  v_variant_name text;
  v_quantity    int;
  v_active      bool;
  v_running_enabled bool;
  v_window      int;
  v_is_running  bool := false;
BEGIN
  -- [unchanged: empty-lines guard, table lookup, is_active guard]

  PERFORM pg_advisory_xact_lock(hashtext(p_table_id::text));

  SELECT id INTO v_order_id
  FROM orders
  WHERE table_id = p_table_id
    AND status IN ('placed','accepted','preparing','ready');

  IF FOUND THEN
    SELECT COALESCE(MAX(seq), 0) + 1 INTO v_seq
    FROM order_rounds WHERE order_id = v_order_id;
    SELECT is_running INTO v_is_running FROM orders WHERE id = v_order_id;
    -- Deliberately absent: the UPDATE that used to reset orders.status.
  ELSE
    -- [unchanged: running-order window lookup setting v_is_running]
    v_daily := next_daily_number(p_business_id, v_day);
    v_seq   := 1;
    INSERT INTO orders (id, business_id, table_id, status, business_day, daily_number, is_running, placed_at, updated_at)
    VALUES (gen_random_uuid(), p_business_id, p_table_id, 'placed', v_day, v_daily,
            COALESCE(v_is_running, false), now(), now())
    RETURNING id INTO v_order_id;
  END IF;

  -- Safe as a plain MAX because the advisory lock above serialises every
  -- round for this table, and KOT numbers are only ever allocated here.
  v_kot := next_kot_number(p_business_id, v_day);

  INSERT INTO order_rounds
    (id, business_id, order_id, seq, business_day, kot_number, status, placed_at)
  VALUES
    (gen_random_uuid(), p_business_id, v_order_id, v_seq, v_day, v_kot, 'placed', now())
  RETURNING id INTO v_round_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    -- [unchanged: quantity guard, menu_items lookup, variant lookup, price]
    INSERT INTO order_items
      (id, order_id, business_id, menu_item_id, name_snapshot, variant_snapshot,
       unit_price, quantity, round_id, created_at)
    VALUES
      (gen_random_uuid(), v_order_id, p_business_id, v_item.id, v_item.name,
       v_variant_name, v_price, v_quantity, v_round_id, now());
  END LOOP;

  INSERT INTO order_events (order_id, business_id, round_id, kind, data)
  SELECT
    v_order_id, p_business_id, v_round_id,
    CASE WHEN v_seq = 1 THEN 'placed' ELSE 'round_added' END,
    jsonb_build_object(
      'seq', v_seq,
      'kotNumber', v_kot,
      'isRunning', COALESCE(v_is_running, false),
      'items', COALESCE(jsonb_agg(jsonb_build_object(
        'name', CASE WHEN i.variant_snapshot IS NULL
                     THEN i.name_snapshot
                     ELSE i.name_snapshot || ' (' || i.variant_snapshot || ')' END,
        'quantity', i.quantity
      ) ORDER BY i.created_at), '[]'::jsonb)
    )
  FROM order_items i
  WHERE i.round_id = v_round_id;

  UPDATE orders SET updated_at = now() WHERE id = v_order_id;

  RETURN get_table_order(p_table_id);
END;
$$;
```

The event `data` keeps `batch` as well as `seq` for one release, set to the same value, so `NotificationsService` and the diner timeline keep working until Task 11 switches them over. Add `'batch', v_seq,` beside `'seq', v_seq,`.

- [ ] **Step 4: Apply, run both specs, commit**

```bash
pnpm --filter @menu/api exec prisma migrate dev
pnpm --filter @menu/api exec vitest run src/prisma/place-round.spec.ts src/prisma/derive-order-status.spec.ts
git add apps/api/prisma/migrations/20261005093000_place_round_per_round apps/api/src/prisma/place-round.spec.ts
git commit -m "fix(db): a new round no longer resets the whole order"
```

---

### Task 6: Rounds in the payloads both screens read

**Files:**
- Create: `apps/api/prisma/migrations/20261005094000_rounds_in_payloads/migration.sql`
- Modify: `apps/api/src/orders/orders.service.ts` (`listForBusiness`, `setRunning`)

**Interfaces:**
- Produces: `get_table_order` returns a `rounds` array `[{ id, seq, kotNumber, status, placedAt, items: [...] }]`, keeping the flat `items` array alongside it; `listForBusiness` includes `rounds: { include: { items: true } }`

- [ ] **Step 1: Add `rounds` to `get_table_order`**

In the new migration, `CREATE OR REPLACE FUNCTION get_table_order` with the existing body plus one key, and the flat `items` ordering changed from `i.batch` to the round's `seq`:

```sql
    'rounds', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id',        r.id,
               'seq',       r.seq,
               'kotNumber', r.kot_number,
               'status',    r.status,
               'placedAt',  to_char(r.placed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
               'items', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                          'id', i.id, 'name', i.name_snapshot,
                          'variant', i.variant_snapshot,
                          'unitPrice', i.unit_price::text,
                          'quantity', i.quantity
                        ) ORDER BY i.created_at)
                 FROM order_items i WHERE i.round_id = r.id
               ), '[]'::jsonb)
             ) ORDER BY r.seq)
      FROM order_rounds r WHERE r.order_id = o.id
    ), '[]'::jsonb),
```

Keep the flat `items` key: the diner's order screen reads it and is not part of this change.

- [ ] **Step 2: Include rounds in the board query**

In `apps/api/src/orders/orders.service.ts`, every `include` that currently has `items: { orderBy: [{ batch: "asc" }, { createdAt: "asc" }] }` becomes:

```ts
      include: {
        table: { select: { id: true, label: true } },
        rounds: {
          orderBy: { seq: "asc" },
          include: { items: { orderBy: { createdAt: "asc" } } },
        },
        items: { orderBy: { createdAt: "asc" } },
        cancellations: { orderBy: { createdAt: "asc" } },
      },
```

There are three of these: `listForBusiness`, `setRunning` and `setStatus`. `stripPrices` walks the object recursively and needs no change — confirm by running its spec.

- [ ] **Step 3: Verify and commit**

```bash
pnpm --filter @menu/api exec prisma migrate dev
pnpm --filter @menu/api exec vitest run src/orders
pnpm --filter @menu/api lint
git add -A apps/api
git commit -m "feat(api): expose rounds on the board and the diner payload"
```

---

### Task 7: Cancellation asks the round, not the order

**Files:**
- Create: `apps/api/prisma/migrations/20261005095000_cancel_per_round/migration.sql`

**Interfaces:**
- Consumes: `order_rounds.status`
- Produces: `cancel_table_order` unchanged in signature; its status guard now reads the status of each line's own round

- [ ] **Step 1: Write the migration**

`CREATE OR REPLACE FUNCTION cancel_table_order` from `20260927120000_order_cancellation/migration.sql`, changing only where it reads the order's status. Every place it did:

```sql
  IF v_order.status NOT IN ('placed','preparing','ready') THEN
```

becomes a per-round check against the round the line belongs to:

```sql
  -- A diner may still call back a chai that has not been started while the
  -- biryani is being made. Asking the order would refuse both or allow both.
  SELECT r.status INTO v_round_status
  FROM order_rounds r
  JOIN order_items i ON i.round_id = r.id
  WHERE i.id = (v_line->>'orderItemId')::uuid;

  IF v_round_status NOT IN ('placed','preparing','ready') THEN
    RAISE EXCEPTION 'That is already being served' USING ERRCODE = 'check_violation';
  END IF;
```

Cancelling a whole order iterates its live rounds and sets each to `cancelled`; the derivation trigger takes the order to `cancelled` once the last one goes. Remove the direct `UPDATE orders SET status = 'cancelled'` — it is now the trigger's job, and two writers would fight.

- [ ] **Step 2: Apply, run the existing cancellation specs, commit**

```bash
pnpm --filter @menu/api exec prisma migrate dev
pnpm --filter @menu/api exec vitest run src/notifications/cancellation-events.spec.ts
pnpm --filter @menu/shared exec vitest run src/cancellation.spec.ts
git add apps/api/prisma/migrations/20261005095000_cancel_per_round
git commit -m "feat(db): judge cancellation against the round, not the order"
```

---

### Task 8: One bill line for the same dish ordered twice

**Files:**
- Create: `apps/api/prisma/migrations/20261005096000_bill_merge_rounds/migration.sql`
- Create: `apps/api/src/billing/bill-merge.spec.ts`

**Interfaces:**
- Produces: `generate_bill` unchanged in signature; its line loop groups on `(name_snapshot, variant_snapshot, unit_price, tax_rate)`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/billing/bill-merge.spec.ts`. Two cases: it merges, and it refuses to merge when the snapshot price differs.

```ts
it("merges the same dish ordered in two rounds into one line", async () => {
  // One biryani at 8:42, two more at 9:06. The customer ordered three and
  // expects to see three.
  const bill = await billFor(orderWithTwoRoundsOfTheSameDish);
  const lines = bill.filter((l) => l.name === "Dum Biryani");
  expect(lines).toHaveLength(1);
  expect(lines[0].quantity).toBe(3);
  expect(lines[0].line_total).toBe("960.00");
});

it("keeps the lines apart when the price changed between rounds", async () => {
  // Prices are snapshotted per round on purpose. Merging 320 and 330 would
  // print a price nobody was charged.
  const bill = await billFor(orderWherePriceRoseBetweenRounds);
  const lines = bill.filter((l) => l.name === "Dum Biryani");
  expect(lines.map((l) => l.unit_price)).toEqual(["320.00", "330.00"]);
});
```

Write one helper, `billLinesFor(priceSecondRound: number | null)`, inline in the spec. Copy the `beforeAll` seeding from `src/prisma/place-round.spec.ts` verbatim (business, table, category, menu item at 320.00), then:

```ts
async function billLinesFor(priceSecondRound: number | null) {
  const table = await freshTable();          // same helper as place-round.spec.ts
  const lines = JSON.stringify([{ itemId, variantId: null, quantity: 1 }]);
  await admin.query(`SELECT place_table_round($1, $2, $3::jsonb)`, [table, biz, lines]);

  if (priceSecondRound !== null) {
    await admin.query(`UPDATE menu_items SET price = $1 WHERE id = $2`, [priceSecondRound, itemId]);
  }
  const two = JSON.stringify([{ itemId, variantId: null, quantity: 2 }]);
  await admin.query(`SELECT place_table_round($1, $2, $3::jsonb)`, [table, biz, two]);

  const o = await admin.query(
    `SELECT id FROM orders WHERE table_id = $1 ORDER BY placed_at DESC LIMIT 1`, [table]);
  await admin.query(
    `UPDATE order_rounds SET status = 'completed', completed_at = now() WHERE order_id = $1`,
    [o.rows[0].id]);
  await admin.query(`SELECT generate_bill($1, $2)`, [o.rows[0].id, biz]);

  const r = await admin.query(
    `SELECT name, quantity, unit_price::text, line_total::text
     FROM bill_lines WHERE bill_id = (SELECT id FROM bills WHERE order_id = $1)
     ORDER BY position`, [o.rows[0].id]);
  return r.rows;
}
```

The first test calls `billLinesFor(null)`, the second `billLinesFor(330)`. Name the menu item `Dum Biryani` in the seeding so the assertions read as written.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @menu/api exec vitest run src/billing/bill-merge.spec.ts
```

Expected: FAIL — two `Dum Biryani` lines where one is expected.

- [ ] **Step 3: Write the migration**

`CREATE OR REPLACE FUNCTION generate_bill` from `20260830085723_billing/migration.sql`, replacing only the `FOR v_line IN` cursor:

```sql
  -- Grouped, so three biryanis ordered across two rounds print as one line.
  -- The grouping key is every column that could make two rows genuinely
  -- different things: a price change between rounds, a different size, or a
  -- different tax rate (a deleted dish falls back to the business rate).
  -- Ordered by first appearance so the bill still reads in the order the
  -- table ate.
  FOR v_line IN
    SELECT oi.name_snapshot,
           oi.variant_snapshot,
           oi.unit_price,
           SUM(oi.quantity)::int AS quantity,
           CASE WHEN NOT v_biz.tax_enabled THEN 0
                ELSE COALESCE(MAX(mi.tax_rate), v_biz.default_tax_rate) END AS item_rate,
           MIN(oi.created_at) AS first_at
    FROM order_items oi
    LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
    WHERE oi.order_id = p_order_id
    GROUP BY oi.name_snapshot, oi.variant_snapshot, oi.unit_price,
             CASE WHEN NOT v_biz.tax_enabled THEN 0
                  ELSE COALESCE(mi.tax_rate, v_biz.default_tax_rate) END
    ORDER BY first_at
  LOOP
```

Inside the loop, `v_rate := v_line.item_rate;` replaces the old `CASE` (the rate is now resolved in the query so it can be part of the grouping key).

- [ ] **Step 4: Apply, run, commit**

```bash
pnpm --filter @menu/api exec prisma migrate dev
pnpm --filter @menu/api exec vitest run src/billing
git add apps/api/prisma/migrations/20261005096000_bill_merge_rounds apps/api/src/billing/bill-merge.spec.ts
git commit -m "feat(db): merge identical bill lines across rounds"
```

---

### Task 9: Moving one round along

**Files:**
- Modify: `apps/api/src/orders/orders.service.ts` (add `setRoundStatus`)
- Modify: `apps/api/src/orders/orders.controller.ts`
- Create: `apps/api/src/orders/set-round-status-role.spec.ts`

**Interfaces:**
- Consumes: `canRoleSetStatus` from `@menu/shared`
- Produces: `OrdersService.setRoundStatus(userId, businessId, orderId, roundId, next): Promise<Order>`; route `PATCH /businesses/:bid/orders/:id/rounds/:rid/status`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/orders/set-round-status-role.spec.ts`, modelled on the existing `set-status-role.spec.ts` (read it first and copy its mocking style exactly).

```ts
// Review Focus #3
it("lets the kitchen move a round to ready", async () => {
  await expect(
    service.setRoundStatus(kitchenUser, biz, orderId, roundId, "ready"),
  ).resolves.toBeDefined();
});

it("refuses the kitchen `completed` on a round, as it does on an order", async () => {
  // completed is what closes an order for billing — a service act. The rule
  // does not get weaker because the thing being closed got smaller.
  await expect(
    service.setRoundStatus(kitchenUser, biz, orderId, roundId, "completed"),
  ).rejects.toThrow(ForbiddenException);
});

it("refuses a backwards move with a 409, not a 403", async () => {
  // Two different refusals on purpose: the state machine refusing is a fact
  // about the round; a role refusing is a fact about the person.
  roundStatus = "ready";
  await expect(
    service.setRoundStatus(ownerUser, biz, orderId, roundId, "accepted"),
  ).rejects.toThrow(ConflictException);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @menu/api exec vitest run src/orders/set-round-status-role.spec.ts
```

Expected: FAIL — `service.setRoundStatus is not a function`.

- [ ] **Step 3: Implement**

In `apps/api/src/orders/orders.service.ts`, add beside `setStatus`:

```ts
  /**
   * Moves one round along.
   *
   * The order's own status is not written here — the derivation trigger does
   * it, atomically, from every round. Writing both would be two authors for
   * one fact, and they would disagree the first time two rounds moved at
   * once.
   */
  async setRoundStatus(
    userId: string,
    businessId: string,
    orderId: string,
    roundId: string,
    next: OrderStatus,
  ) {
    const { role } = await this.businesses.assertAccess(userId, businessId, {
      allow: ["owner", "kitchen"],
    });

    const round = await this.prisma.db.orderRound.findFirst({
      where: { id: roundId, orderId, businessId },
      select: { id: true, status: true, seq: true },
    });
    if (!round) throw new NotFoundException("Round not found");

    if (!ALLOWED_TRANSITIONS[round.status].includes(next)) {
      throw new ConflictException(
        `Round ${round.seq} is ${round.status} and cannot be moved to ${next}`,
      );
    }
    if (!canRoleSetStatus(role, round.status, next)) {
      throw new ForbiddenException(`You cannot move a round to ${next}`);
    }

    await this.prisma.db.orderRound.update({
      where: { id: roundId },
      data: {
        status: next,
        acceptedAt: next === "accepted" ? new Date() : undefined,
        completedAt:
          next === "completed" || next === "cancelled" ? new Date() : undefined,
      },
    });

    return this.orderForBoard(businessId, orderId);
  }
```

Extract the `include` block repeated in `setStatus` / `setRunning` into a private `orderForBoard(businessId, orderId)` and use it from all three — it is now four copies of the same six lines.

In `apps/api/src/orders/orders.controller.ts`, add the route beside the existing status route, copying its guards and decorators verbatim:

```ts
  @Patch("orders/:id/rounds/:rid/status")
  setRoundStatus(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Param("id") id: string,
    @Param("rid") rid: string,
    @Body() body: { status: OrderStatus },
  ) {
    return this.orders.setRoundStatus(user.id, bid, id, rid, body.status);
  }
```

Validate `body.status` with the same Zod pipe the existing status route uses.

- [ ] **Step 4: Run and commit**

```bash
pnpm --filter @menu/api exec vitest run src/orders
pnpm --filter @menu/api lint
git add apps/api/src/orders
git commit -m "feat(api): move one round along without touching the others"
```

---

### Task 10: Closing the table

**Files:**
- Modify: `apps/api/src/orders/orders.service.ts` (`setStatus`)

**Interfaces:**
- Produces: `setStatus(..., "completed")` now completes every live round in one transaction rather than writing `orders.status`

- [ ] **Step 1: Implement**

`setStatus` keeps its route and signature — the board still calls it to close a table — but its body stops writing `orders.status`, which is now derived:

```ts
    // Closing a table means finishing everything still live on it. The order's
    // own status follows from the rounds; writing it here as well would be a
    // second author for one fact.
    const live = await this.prisma.db.orderRound.findMany({
      where: { orderId, status: { in: OPEN_STATUSES } },
      select: { id: true, status: true },
    });

    for (const round of live) {
      if (!canRoleSetStatus(role, round.status, next)) {
        throw new ForbiddenException(`You cannot move an order to ${next}`);
      }
    }

    await this.prisma.db.$transaction(
      live.map((round) =>
        this.prisma.db.orderRound.update({
          where: { id: round.id },
          data: {
            status: next,
            completedAt: new Date(),
          },
        }),
      ),
    );

    const updated = await this.orderForBoard(businessId, orderId);
```

Keep the existing guard that refuses to reopen a finished order — read `order.status` for it, which is still correct because it is derived.

- [ ] **Step 2: Run and commit**

```bash
pnpm --filter @menu/api exec vitest run src/orders
git add apps/api/src/orders/orders.service.ts
git commit -m "feat(api): closing a table completes every live round"
```

---

### Task 11: The board shows rounds

**Files:**
- Modify: `apps/web/lib/types.ts` (the `Order` type)
- Modify: `apps/web/lib/board-actions.ts`
- Create: `apps/web/lib/board-rounds.spec.ts`
- Modify: `apps/web/app/(app)/orders/page.tsx`

**Interfaces:**
- Consumes: `rounds` on the board payload (Task 6); `canRoleSetStatus`, `deriveOrderStatus` from `@menu/shared`
- Produces: `nextActionFor(role: AccessRole, status: OrderStatus): { status: OrderStatus; label: string } | null` in `apps/web/lib/board-actions.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/board-rounds.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { nextActionFor } from "./board-actions";

describe("nextActionFor", () => {
  it("offers Accept on a new round and Served on a ready one", () => {
    expect(nextActionFor("owner", "placed")?.label).toBe("Accept");
    expect(nextActionFor("owner", "ready")?.label).toBe("Served");
  });

  it("withholds Served from the kitchen but keeps Ready", () => {
    // The button is the permission. A screen that offers an action the API
    // will refuse is worse than a screen with no button.
    expect(nextActionFor("kitchen", "ready")).toBeNull();
    expect(nextActionFor("kitchen", "preparing")?.label).toBe("Ready");
  });

  it("offers nothing on a finished round", () => {
    expect(nextActionFor("owner", "completed")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @menu/web exec vitest run lib/board-rounds.spec.ts
```

- [ ] **Step 3: Implement**

Add to `apps/web/lib/board-actions.ts`, reusing the `COLUMNS` table already there so the labels cannot drift:

```ts
/**
 * The one move this role may make on a round in this state, or nothing.
 *
 * Drawn from the same COLUMNS table the columns are, so a label can never
 * disagree between the column header and the button inside a card.
 */
export function nextActionFor(
  role: AccessRole,
  status: OrderStatus,
): { status: OrderStatus; label: string } | null {
  const column = COLUMNS.find((c) => c.status === status);
  if (!column) return null;
  if (!canRoleSetStatus(role, status, column.next)) return null;
  return { status: column.next, label: column.nextLabel };
}
```

- [ ] **Step 4: Render rounds in the card**

In `apps/web/app/(app)/orders/page.tsx`, the card body currently lists `order.items` grouped by `batch`. Replace that grouping with `order.rounds.map(...)`, and for each round render:

- a header: `Round {seq}` and `KOT #{kotNumber}` (omit the header entirely when the order has one round — a card that says "Round 1" on every single-round order is noise)
- a status chip for `round.status`
- the round's items
- the button from `nextActionFor(role, round.status)`, calling `PATCH /businesses/:bid/orders/:id/rounds/:rid/status`

The card still sits in the column of `order.status`, which the API derives and the browser can check with `deriveOrderStatus(order.rounds.map(r => r.status))` without a refetch.

Update the `Order` type in `apps/web/lib/types.ts` to carry `rounds: OrderRound[]` and drop `batch` from the item type.

- [ ] **Step 5: Run everything and commit**

```bash
pnpm --filter @menu/shared build
pnpm --filter @menu/web exec vitest run
pnpm --filter @menu/web lint
git add apps/web
git commit -m "feat(web): work each round on its own on the board"
```

---

### Task 12: Prove it end to end

**Files:**
- Modify: `apps/web/e2e/kitchen.spec.ts`

- [ ] **Step 1: Add one Playwright case**

One case, because this is the behaviour the whole plan exists for and the only one worth paying a browser for:

```ts
test("a second round does not drag the first one backwards", async ({ page }) => {
  // Order, accept, mark ready.
  await placeOrder(page, ["Chicken Biryani"]);
  await acceptLatestRound(page);
  await markLatestRoundReady(page);
  await expect(page.getByTestId("round-1-status")).toHaveText("Ready");

  // The same table orders again.
  await placeOrder(page, ["Irani Chai"]);

  // Round 1 is still Ready. Round 2 is new, and the card has moved back to
  // the New column because something on this table is unstarted.
  await expect(page.getByTestId("round-1-status")).toHaveText("Ready");
  await expect(page.getByTestId("round-2-status")).toHaveText("New");
});
```

Reuse the helpers already in `apps/web/e2e/kitchen.spec.ts`; add `data-testid="round-{seq}-status"` to the chip in Task 11.

- [ ] **Step 2: Run the whole suite and commit**

```bash
pnpm db:up
pnpm --filter @menu/shared build
pnpm -r test
pnpm --filter @menu/web e2e
pnpm -r lint
git add apps/web/e2e/kitchen.spec.ts
git commit -m "test(web): a second round leaves the first alone"
```

Expected: everything green. If an older spec fails on `batch`, it is a real break — Task 6 kept the flat `items` array but removed the column, so any test reading `item.batch` must read `round.seq` instead.
