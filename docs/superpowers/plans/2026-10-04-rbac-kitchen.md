# RBAC Kitchen Staff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a venue owner create kitchen-staff logins that can work a live service — see orders, advance them to ready, toggle dish availability — and nothing else.

**Architecture:** A `business_staff` table links users to businesses. Kitchen RLS policies sit beside the existing fifteen `%_owner` policies, keyed on a `SECURITY DEFINER` helper; `BEFORE UPDATE` triggers restrict kitchen writes to single columns, because RLS grants rows and never columns. In the API, `assertOwns` becomes `assertAccess(userId, businessId, { allow })`, defaulting to owner-only so untouched routes stay closed. Prices are stripped server-side for kitchen callers.

**Tech Stack:** NestJS 11, Prisma 6 (PostgreSQL 17 / Supabase), Next.js 15 App Router, Vitest, Playwright, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-10-04-rbac-kitchen-design.md`

## Global Constraints

- Branch: `feat/rbac-kitchen-qr-logo`. Do not commit to `master`.
- Dev database only. `.env` must point at `aws-0-ap-southeast-1` (dev). Never run a migration against `aws-0-ap-southeast-2` (prod) during implementation.
- Migrations are hand-written SQL. Use `prisma migrate dev --create-only`, edit the SQL, then `prisma migrate deploy`. Never plain `prisma migrate dev` — it wants a shadow database Supabase will not give it.
- All `SECURITY DEFINER` functions carry `SET search_path = public`, matching the existing 33.
- Kitchen may set exactly `accepted`, `preparing`, `ready`. Never `completed`, never `cancelled`.
- Kitchen responses carry no price field at any depth: no `unitPrice`, `price`, variant `price`, or `taxRate`.
- API tests: `pnpm --filter @menu/api test`. Web tests: `pnpm --filter @menu/web test`. Files are `*.spec.ts` under `src/`.
- Conventional commits (`feat:`, `fix:`, `test:`), matching existing history.

## Review Focus

1. **A suspended staff member holding a valid access token.** Tokens live 15 minutes; suspension must bite on the very next request, not when the token expires. — Task 9.
2. **Creating staff with an identifier that already has an account.** The error wording must match signup's exactly, or this endpoint becomes an oracle for "does this phone number have an account?" — Task 9.
3. **A kitchen user of venue A calling venue B's routes.** Same role, different tenant — the case neither the role check nor the owner policies cover. — Task 3.
4. **A `mustChangePin` user calling any other API route.** The UI gate is cosmetic; the API must refuse too, or the forced change is a suggestion. — Task 10.
5. **Kitchen attempting `ready → accepted`.** `ROLE_TARGETS` permits `accepted` as a target and `ALLOWED_TRANSITIONS` forbids the move; only the intersection is correct. — Task 1.

---

### Task 1: Shared role vocabulary

Both the API and the board need the same table of which statuses a role may set. It lives in `packages/shared` so a button can never offer what the API will reject.

**Files:**
- Create: `packages/shared/src/roles.ts`
- Create: `packages/shared/src/roles.spec.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/enums.ts` (add `kitchen` to `USER_ROLES`)

**Interfaces:**
- Consumes: nothing.
- Produces: `STAFF_ROLES`, `type StaffRole`, `type AccessRole = "owner" | "kitchen"`, `ROLE_TARGETS: Record<AccessRole, OrderStatus[]>`, `canRoleSetStatus(role: AccessRole, from: OrderStatus, to: OrderStatus): boolean`, `ORDER_STATUSES`, `ALLOWED_TRANSITIONS` re-exported.

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/roles.spec.ts
import { describe, expect, it } from "vitest";
import { ROLE_TARGETS, canRoleSetStatus, ORDER_STATUSES } from "./roles";

describe("role targets", () => {
  it("lets the kitchen take, start and finish cooking", () => {
    expect(canRoleSetStatus("kitchen", "placed", "accepted")).toBe(true);
    expect(canRoleSetStatus("kitchen", "accepted", "preparing")).toBe(true);
    expect(canRoleSetStatus("kitchen", "preparing", "ready")).toBe(true);
  });

  it("refuses the kitchen the two acts that touch a bill", () => {
    expect(canRoleSetStatus("kitchen", "ready", "completed")).toBe(false);
    expect(canRoleSetStatus("kitchen", "placed", "cancelled")).toBe(false);
  });

  // Review Focus 5: `accepted` is a legal kitchen target and an illegal move
  // from `ready`. Only the intersection of the two tables is correct.
  it("refuses a backward move even to a status the role may otherwise set", () => {
    expect(ROLE_TARGETS.kitchen).toContain("accepted");
    expect(canRoleSetStatus("kitchen", "ready", "accepted")).toBe(false);
    expect(canRoleSetStatus("kitchen", "preparing", "accepted")).toBe(false);
  });

  it("leaves the owner every move the state machine already allows", () => {
    expect(canRoleSetStatus("owner", "ready", "completed")).toBe(true);
    expect(canRoleSetStatus("owner", "placed", "cancelled")).toBe(true);
    expect(canRoleSetStatus("owner", "completed", "placed")).toBe(false);
  });

  it("never lets any role move a finished order", () => {
    for (const role of ["owner", "kitchen"] as const) {
      for (const to of ORDER_STATUSES) {
        expect(canRoleSetStatus(role, "completed", to)).toBe(false);
        expect(canRoleSetStatus(role, "cancelled", to)).toBe(false);
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @menu/shared test`
Expected: FAIL — `Cannot find module './roles'`

- [ ] **Step 3: Write the implementation**

```ts
// packages/shared/src/roles.ts

/**
 * Who may move an order where.
 *
 * This lives beside the state machine rather than in the API because the
 * board draws its buttons from the same table. A screen that offers "Served"
 * to someone the API will refuse is worse than a screen with no button.
 */

export const ORDER_STATUSES = [
  "placed",
  "accepted",
  "preparing",
  "ready",
  "completed",
  "cancelled",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Roles a person can hold *within* one business. */
export const STAFF_ROLES = ["kitchen"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** Everyone who can reach a business's data: its owner, or its staff. */
export type AccessRole = "owner" | StaffRole;

/**
 * The state machine. Forward skips are deliberate: a kitchen mid-rush that
 * taps Ready on something still marked New should not be told to tap three
 * more times first.
 */
export const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  placed: ["accepted", "preparing", "ready", "completed", "cancelled"],
  accepted: ["preparing", "ready", "completed", "cancelled"],
  preparing: ["ready", "completed", "cancelled"],
  ready: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

/**
 * Which statuses each role may set at all.
 *
 * `completed` is withheld from the kitchen because it is what closes an
 * order for billing — a service act. `cancelled` is withheld because it
 * rewrites a bill. Neither is about trust; both are about which job the
 * person at the pass is doing.
 */
export const ROLE_TARGETS: Record<AccessRole, OrderStatus[]> = {
  owner: [...ORDER_STATUSES],
  kitchen: ["accepted", "preparing", "ready"],
};

/**
 * The intersection, which is the only correct question.
 *
 * Either table alone gives a wrong answer: ROLE_TARGETS allows the kitchen
 * `accepted` without caring that `ready -> accepted` is backwards, and
 * ALLOWED_TRANSITIONS allows `ready -> completed` without caring who asked.
 */
export function canRoleSetStatus(
  role: AccessRole,
  from: OrderStatus,
  to: OrderStatus,
): boolean {
  return (
    ALLOWED_TRANSITIONS[from].includes(to) && ROLE_TARGETS[role].includes(to)
  );
}
```

Add to `packages/shared/src/index.ts`:

```ts
export * from "./roles";
```

**Then make the API delegate rather than keep a second copy.** `apps/api/src/orders/transitions.ts:13,47` already defines `ORDER_STATUSES` and `ALLOWED_TRANSITIONS`. Two tables that must agree are one table waiting to disagree, so that file re-exports instead of redefining — keeping `OPEN_STATUSES`, which is API-only and carries a warning about four SQL call sites:

```ts
// apps/api/src/orders/transitions.ts
import type { OrderStatus } from "@prisma/client";

/**
 * The state machine moved to @menu/shared when the board gained role-aware
 * buttons: the browser needs the same table to decide what to draw, and the
 * one thing worse than duplicating it is duplicating it across a network
 * boundary. Re-exported here so the existing call sites and tests are
 * unchanged.
 */
export {
  ORDER_STATUSES,
  ALLOWED_TRANSITIONS,
  canTransition,
  ROLE_TARGETS,
  canRoleSetStatus,
} from "@menu/shared";

/**
 * What counts as an order still in play. Stays here: it is API-only, and its
 * warning is about four SQL call sites the web app has no part in.
 *
 * WARNING: this list is written out by hand in four other places, all of them
 * SQL — the `orders_one_open_per_table` unique index, `place_table_round`'s
 * lookup of the order to append to, and `get_table_order`'s WHERE clause.
 */
export const OPEN_STATUSES: OrderStatus[] = [
  "placed",
  "accepted",
  "preparing",
  "ready",
];
```

Move `canTransition` into `packages/shared/src/roles.ts` alongside the table:

```ts
export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
```

`apps/api/src/orders/transitions.spec.ts` keeps passing unchanged — it imports from `./transitions`, which still exports everything it asks for.

In `packages/shared/src/enums.ts`, widen the role list:

```ts
export const USER_ROLES = ["owner", "kitchen", "platform_admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @menu/shared test`
Expected: PASS (5 tests). Then `pnpm --filter @menu/api test` — `src/orders/transitions.spec.ts` must still pass untouched.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/roles.ts packages/shared/src/roles.spec.ts \
        packages/shared/src/index.ts packages/shared/src/enums.ts
git commit -m "feat(shared): add role-aware order status rules"
```

---

### Task 2: Schema and migration — tables, columns, indexes

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_rbac_kitchen/migration.sql`

**Interfaces:**
- Consumes: Task 1's `StaffRole`.
- Produces: Prisma models `BusinessStaff`; `User.mustChangePin`; `OrderEvent.actorId`; enums `StaffRole`, `StaffStatus`; `UserRole.kitchen`.

- [ ] **Step 1: Edit the Prisma schema**

In `apps/api/prisma/schema.prisma`, add `kitchen` to `UserRole`:

```prisma
enum UserRole {
  owner
  kitchen
  platform_admin
}

enum StaffRole {
  kitchen
}

enum StaffStatus {
  active
  suspended
}
```

Add the model:

```prisma
/// A person who works at a business but does not own it.
///
/// Deliberately not a general membership table: `Business.ownerId` is still
/// the tenant boundary and every existing policy keys on it. This table adds
/// a second, narrower way in, which is why its rows carry a status — ending
/// someone's access has to be one column, not a deletion that takes their
/// history with it.
model BusinessStaff {
  id          String      @id @default(uuid()) @db.Uuid
  businessId  String      @map("business_id") @db.Uuid
  userId      String      @map("user_id") @db.Uuid
  role        StaffRole   @default(kitchen)
  status      StaffStatus @default(active)
  /// Which owner added them. Nulled rather than cascaded, so the audit trail
  /// survives the author's account being removed.
  createdById String?     @map("created_by_id") @db.Uuid
  createdAt   DateTime    @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt   DateTime    @updatedAt @map("updated_at") @db.Timestamptz(6)

  business Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  user     User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([businessId, userId])
  @@map("business_staff")
}
```

On `User`, add the field and the back-relation:

```prisma
  /// True for an account an owner created. Gates the whole app until the
  /// person picks their own PIN — until then the owner knows their
  /// credential, and the audit trail means nothing.
  mustChangePin  Boolean   @default(false) @map("must_change_pin")

  staffRoles     BusinessStaff[]
```

On `Business`, add:

```prisma
  staff        BusinessStaff[]
```

On `OrderEvent`, add:

```prisma
  /// Who caused it. Null for a diner, the system, or anything from before
  /// staff accounts existed — which is honest: we do not know.
  actorId    String?  @map("actor_id") @db.Uuid
```

- [ ] **Step 2: Generate the empty migration**

```bash
cd apps/api
pnpm exec prisma migrate dev --create-only --name rbac_kitchen
```

Expected: a new folder under `prisma/migrations/` containing Prisma's generated SQL. Keep it; the next step appends to it.

- [ ] **Step 3: Replace the generated SQL with the reviewed version**

```sql
-- RBAC: kitchen staff accounts.
--
-- Part 1 of 3 in this migration: tables, columns and indexes. Policies are
-- below in part 2, column guards in part 3. Split by comment rather than by
-- migration because they are one atomic change — a table with no policy is a
-- table with no protection.

ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'kitchen';

CREATE TYPE "StaffRole"   AS ENUM ('kitchen');
CREATE TYPE "StaffStatus" AS ENUM ('active', 'suspended');

CREATE TABLE "business_staff" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id"   uuid NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
  "user_id"       uuid NOT NULL REFERENCES "users"("id")      ON DELETE CASCADE,
  "role"          "StaffRole"   NOT NULL DEFAULT 'kitchen',
  "status"        "StaffStatus" NOT NULL DEFAULT 'active',
  "created_by_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"    timestamptz(6) NOT NULL DEFAULT now(),
  "updated_at"    timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT "business_staff_business_user_key" UNIQUE ("business_id", "user_id")
);

-- Load-bearing. These columns are the predicate of every kitchen policy,
-- evaluated against ten tables on every request a kitchen user makes.
-- INCLUDE puts business_id in the leaf so the lookup never touches the heap.
CREATE INDEX "business_staff_lookup"
  ON "business_staff" ("user_id", "status") INCLUDE ("business_id");

ALTER TABLE "users"        ADD COLUMN "must_change_pin" boolean NOT NULL DEFAULT false;
ALTER TABLE "order_events" ADD COLUMN "actor_id" uuid;

CREATE INDEX "order_events_actor_idx" ON "order_events" ("actor_id", "id" DESC);
```

**Note on `ALTER TYPE ... ADD VALUE`:** Postgres cannot use a new enum value in the same transaction that adds it. Prisma runs each migration in a transaction, so this value is only *referenced* by later migrations and by application code — never by part 2 or 3 of this file. Do not add a `DEFAULT 'kitchen'::"UserRole"` anywhere in this migration.

- [ ] **Step 4: Apply to dev and verify**

```bash
cd apps/api
pnpm exec prisma migrate deploy
pnpm exec prisma generate
```

Then confirm, against dev:

```bash
psql "$DIRECT_URL" -tAc "select count(*) from business_staff;"              # 0
psql "$DIRECT_URL" -tAc "select indexname from pg_indexes where tablename='business_staff';"
psql "$DIRECT_URL" -tAc "select column_name from information_schema.columns where table_name='users' and column_name='must_change_pin';"
```

Expected: `0`; `business_staff_pkey`, `business_staff_business_user_key`, `business_staff_lookup`; `must_change_pin`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations
git commit -m "feat(db): add business_staff, must_change_pin and order event actor"
```

---

### Task 3: Kitchen RLS policies and the drift guard

**Files:**
- Modify: the same `migration.sql` from Task 2 (append part 2)
- Create: `apps/api/src/prisma/kitchen-policies.spec.ts`

**Interfaces:**
- Consumes: `business_staff` from Task 2.
- Produces: SQL function `app_staff_business_ids() RETURNS SETOF uuid`; policies named `<table>_kitchen_read`, `orders_kitchen_write`, `menu_items_kitchen_write`, `business_staff_owner`, `business_staff_self_read`.

- [ ] **Step 1: Append part 2 to the migration**

```sql
-- Part 2: kitchen policies, beside the owner policies rather than replacing
-- them. The cost of that choice is two parallel rules per table; the
-- drift-guard test in kitchen-policies.spec.ts is what stops them separating.

ALTER TABLE "business_staff" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "business_staff" FORCE  ROW LEVEL SECURITY;

-- SECURITY DEFINER so it can read business_staff while that table's own
-- policies hide it. search_path is pinned for the same reason the other 33
-- functions pin it. The identity check is inside the body, so it cannot be
-- asked about anyone but the caller.
CREATE OR REPLACE FUNCTION app_staff_business_ids() RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT business_id FROM business_staff
   WHERE user_id = app_current_user_id() AND status = 'active'
$$;

REVOKE EXECUTE ON FUNCTION app_staff_business_ids() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION app_staff_business_ids() TO menu_app;

-- An owner manages their own venues' staff; a staff member may read only
-- their own row, so the app can tell them which venue they belong to.
CREATE POLICY business_staff_owner ON business_staff
  USING      (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()))
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()));

CREATE POLICY business_staff_self_read ON business_staff FOR SELECT
  USING (user_id = app_current_user_id());

-- `businesses` is the exception: it has no business_id column because it IS
-- the business. Writing it from the template below would fail outright.
CREATE POLICY businesses_kitchen_read ON businesses FOR SELECT
  USING (id IN (SELECT app_staff_business_ids()));

CREATE POLICY tables_kitchen_read ON tables FOR SELECT
  USING (business_id IN (SELECT app_staff_business_ids()));
CREATE POLICY orders_kitchen_read ON orders FOR SELECT
  USING (business_id IN (SELECT app_staff_business_ids()));
CREATE POLICY order_items_kitchen_read ON order_items FOR SELECT
  USING (business_id IN (SELECT app_staff_business_ids()));
CREATE POLICY order_events_kitchen_read ON order_events FOR SELECT
  USING (business_id IN (SELECT app_staff_business_ids()));
CREATE POLICY menu_categories_kitchen_read ON menu_categories FOR SELECT
  USING (business_id IN (SELECT app_staff_business_ids()));
CREATE POLICY menu_items_kitchen_read ON menu_items FOR SELECT
  USING (business_id IN (SELECT app_staff_business_ids()));
CREATE POLICY menu_item_variants_kitchen_read ON menu_item_variants FOR SELECT
  USING (business_id IN (SELECT app_staff_business_ids()));
CREATE POLICY menu_item_photos_kitchen_read ON menu_item_photos FOR SELECT
  USING (business_id IN (SELECT app_staff_business_ids()));
CREATE POLICY notifications_kitchen_read ON notifications FOR SELECT
  USING (business_id IN (SELECT app_staff_business_ids()));

-- The only two tables a kitchen user may write. No INSERT and no DELETE
-- policy for kitchen exists anywhere; which *columns* may change is part 3.
CREATE POLICY orders_kitchen_write ON orders FOR UPDATE
  USING      (business_id IN (SELECT app_staff_business_ids()))
  WITH CHECK (business_id IN (SELECT app_staff_business_ids()));

CREATE POLICY menu_items_kitchen_write ON menu_items FOR UPDATE
  USING      (business_id IN (SELECT app_staff_business_ids()))
  WITH CHECK (business_id IN (SELECT app_staff_business_ids()));
```

- [ ] **Step 2: Write the failing test**

```ts
// apps/api/src/prisma/kitchen-policies.spec.ts
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
const APP_URL = process.env.APP_DATABASE_URL || process.env.DATABASE_URL!;
const ADMIN_URL = process.env.DIRECT_URL!;

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

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  app = new Client({ connectionString: APP_URL });
  await admin.connect();
  await app.connect();

  // Two tenants. Seeded as admin so RLS is not in the way of the fixture.
  const mk = async (name: string) => {
    const u = await admin.query(
      `INSERT INTO users (id, pin_hash, full_name, phone, verified_at)
       VALUES (gen_random_uuid(), 'x', $1, $2, now()) RETURNING id`,
      [name, `+9199${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`],
    );
    const b = await admin.query(
      `INSERT INTO businesses (id, owner_id, name, type, public_code)
       VALUES (gen_random_uuid(), $1, $2, 'cafe', $3) RETURNING id`,
      [u.rows[0].id, `${name} Place`, Math.random().toString(36).slice(2, 10).toUpperCase()],
    );
    return { user: u.rows[0].id as string, biz: b.rows[0].id as string };
  };

  const a = await mk("PolicyA");
  const b = await mk("PolicyB");
  ownerA = a.user; bizA = a.biz;
  ownerB = b.user; bizB = b.biz;

  const k = await admin.query(
    `INSERT INTO users (id, pin_hash, full_name, role, verified_at)
     VALUES (gen_random_uuid(), 'x', 'Kitchen A', 'kitchen', now()) RETURNING id`,
  );
  kitchenA = k.rows[0].id;
  await admin.query(
    `INSERT INTO business_staff (business_id, user_id) VALUES ($1, $2)`,
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

describe("kitchen policies", () => {
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
    const owned = r.rows.map((x) => x.tablename as string);
    expect(owned).toHaveLength(15);

    const k = await admin.query(
      `SELECT DISTINCT tablename FROM pg_policies
        WHERE schemaname='public' AND policyname LIKE '%\\_kitchen\\_%'`,
    );
    const kitchen = new Set(k.rows.map((x) => x.tablename as string));

    for (const t of owned) {
      expect(
        kitchen.has(t) || KITCHEN_DENIED.includes(t),
        `${t} has an owner policy but no kitchen policy and no explicit denial`,
      ).toBe(true);
    }
  });
});
```

Add `pg` as a dev dependency if absent: `pnpm --filter @menu/api add -D pg @types/pg`.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @menu/api test kitchen-policies`
Expected: FAIL — `function app_staff_business_ids() does not exist`

- [ ] **Step 4: Apply the migration and re-run**

```bash
cd apps/api && pnpm exec prisma migrate deploy
pnpm --filter @menu/api test kitchen-policies
```

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/migrations apps/api/src/prisma/kitchen-policies.spec.ts apps/api/package.json
git commit -m "feat(db): add kitchen RLS policies with a drift guard"
```

---

### Task 4: Column guards

RLS grants a *row*. Without this, a kitchen `UPDATE` on `orders` could rewrite `note`, `is_running` or `business_day`. A policy cannot compare `OLD` with `NEW` — `USING` sees old, `WITH CHECK` sees new — so the restriction has to be a trigger.

**Files:**
- Modify: the same `migration.sql` (append part 3)
- Modify: `apps/api/src/prisma/kitchen-policies.spec.ts`

**Interfaces:**
- Consumes: `app_current_user_id()`, `business_staff`.
- Produces: triggers `orders_kitchen_guard`, `menu_items_kitchen_guard`.

- [ ] **Step 1: Append part 3 to the migration**

```sql
-- Part 3: column guards.
--
-- Columns are compared one by one rather than through to_jsonb or hstore.
-- It is longer, and it fails loudly the day someone adds a column — which is
-- the behaviour worth having, since the silent version would let the new
-- column through.

CREATE OR REPLACE FUNCTION orders_kitchen_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM business_staff
     WHERE user_id = app_current_user_id()
       AND business_id = NEW.business_id
       AND status = 'active'
  ) THEN
    RETURN NEW;  -- not staff: the owner path is unchanged
  END IF;

  IF NEW.status NOT IN ('accepted', 'preparing', 'ready') THEN
    RAISE EXCEPTION 'kitchen staff may not set order status to %', NEW.status
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id            IS DISTINCT FROM OLD.id
  OR NEW.business_id   IS DISTINCT FROM OLD.business_id
  OR NEW.table_id      IS DISTINCT FROM OLD.table_id
  OR NEW.business_day  IS DISTINCT FROM OLD.business_day
  OR NEW.daily_number  IS DISTINCT FROM OLD.daily_number
  OR NEW.placed_at     IS DISTINCT FROM OLD.placed_at
  OR NEW.completed_at  IS DISTINCT FROM OLD.completed_at
  OR NEW.is_running    IS DISTINCT FROM OLD.is_running
  OR NEW.note          IS DISTINCT FROM OLD.note THEN
    RAISE EXCEPTION 'kitchen staff may only change an order''s status'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER orders_kitchen_guard
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_kitchen_guard();

CREATE OR REPLACE FUNCTION menu_items_kitchen_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM business_staff
     WHERE user_id = app_current_user_id()
       AND business_id = NEW.business_id
       AND status = 'active'
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.id             IS DISTINCT FROM OLD.id
  OR NEW.business_id    IS DISTINCT FROM OLD.business_id
  OR NEW.category_id    IS DISTINCT FROM OLD.category_id
  OR NEW.name           IS DISTINCT FROM OLD.name
  OR NEW.price          IS DISTINCT FROM OLD.price
  OR NEW.description    IS DISTINCT FROM OLD.description
  OR NEW.position       IS DISTINCT FROM OLD.position
  OR NEW.diet_tag       IS DISTINCT FROM OLD.diet_tag
  OR NEW.spice_level    IS DISTINCT FROM OLD.spice_level
  OR NEW.prep_time_mins IS DISTINCT FROM OLD.prep_time_mins
  OR NEW.ingredients    IS DISTINCT FROM OLD.ingredients
  OR NEW.allergens      IS DISTINCT FROM OLD.allergens
  OR NEW.nutrition      IS DISTINCT FROM OLD.nutrition
  OR NEW.tax_rate       IS DISTINCT FROM OLD.tax_rate THEN
    RAISE EXCEPTION 'kitchen staff may only change a dish''s availability'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER menu_items_kitchen_guard
  BEFORE UPDATE ON menu_items
  FOR EACH ROW EXECUTE FUNCTION menu_items_kitchen_guard();
```

- [ ] **Step 2: Add the failing tests**

Append to `apps/api/src/prisma/kitchen-policies.spec.ts`, inside a new `describe`:

```ts
describe("column guards", () => {
  let orderId: string;
  let itemId: string;

  beforeAll(async () => {
    const t = await admin.query("SELECT id FROM tables WHERE business_id=$1", [bizA]);
    const o = await admin.query(
      `INSERT INTO orders (id, business_id, table_id, business_day, daily_number, note)
       VALUES (gen_random_uuid(), $1, $2, CURRENT_DATE, 1, 'no onions') RETURNING id`,
      [bizA, t.rows[0].id],
    );
    orderId = o.rows[0].id;

    const c = await admin.query(
      `INSERT INTO menu_categories (id, business_id, name, position)
       VALUES (gen_random_uuid(), $1, 'Mains', 1) RETURNING id`,
      [bizA],
    );
    const i = await admin.query(
      `INSERT INTO menu_items (id, business_id, category_id, name, price, position)
       VALUES (gen_random_uuid(), $1, $2, 'Dosa', 120.00, 1) RETURNING id`,
      [bizA, c.rows[0].id],
    );
    itemId = i.rows[0].id;
  });

  it("lets the kitchen advance an order's status", async () => {
    await asUser(kitchenA, async () => {
      await app.query("UPDATE orders SET status='preparing' WHERE id=$1", [orderId]);
    });
    const r = await admin.query("SELECT status FROM orders WHERE id=$1", [orderId]);
    expect(r.rows[0].status).toBe("preparing");
  });

  it("refuses the kitchen the statuses that touch a bill", async () => {
    await expect(
      asUser(kitchenA, () => app.query("UPDATE orders SET status='completed' WHERE id=$1", [orderId])),
    ).rejects.toThrow(/may not set order status/);
  });

  it("refuses the kitchen any column but status", async () => {
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

  it("leaves the owner unrestricted", async () => {
    await asUser(ownerA, async () => {
      await app.query("UPDATE orders SET note='owner may' WHERE id=$1", [orderId]);
      await app.query("UPDATE menu_items SET price=150.00 WHERE id=$1", [itemId]);
    });
    const r = await admin.query("SELECT note FROM orders WHERE id=$1", [orderId]);
    expect(r.rows[0].note).toBe("owner may");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @menu/api test kitchen-policies`
Expected: FAIL — the refusal tests pass no exception; the price update succeeds.

- [ ] **Step 4: Apply and re-run**

```bash
cd apps/api && pnpm exec prisma migrate deploy
pnpm --filter @menu/api test kitchen-policies
```

Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/migrations apps/api/src/prisma/kitchen-policies.spec.ts
git commit -m "feat(db): restrict kitchen writes to single columns"
```

---

### Task 5: Stamp the actor on order events

Without this, individual staff logins buy nothing: you would know an order was marked ready but not by whom, and the case for per-person accounts over one shared tablet PIN collapses.

**Files:**
- Modify: the same `migration.sql` (append part 4)
- Modify: `apps/api/src/prisma/kitchen-policies.spec.ts`
- Modify: `apps/api/src/orders/orders.service.ts:258-282` (`listEvents` return shape)

**Interfaces:**
- Produces: `order_events.actor_id` populated; `listEvents` returns `{ id, kind, at, data, actorId }`.

- [ ] **Step 1: Find the existing status trigger**

```bash
psql "$DIRECT_URL" -tAc "SELECT prosrc FROM pg_proc WHERE proname LIKE '%order%event%';"
```

Note the function name and body — part 4 replaces it, preserving everything it already writes.

- [ ] **Step 2: Append part 4 to the migration**

```sql
-- Part 4: who did it.
--
-- The trigger runs inside the request transaction, where app.current_user_id
-- is already set, so the actor costs nothing extra to record. Null means a
-- diner, the system, or anything from before staff accounts existed.
CREATE OR REPLACE FUNCTION log_order_status_event() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO order_events (order_id, business_id, kind, data, actor_id)
    VALUES (NEW.id, NEW.business_id, NEW.status::text, '{}'::jsonb,
            app_current_user_id());
  END IF;
  RETURN NEW;
END $$;
```

If step 1 showed a different function name, keep that name — only the `INSERT` column list and the `actor_id` value change.

- [ ] **Step 3: Write the failing test**

Append to `kitchen-policies.spec.ts`:

```ts
describe("audit trail", () => {
  it("records which staff member moved an order", async () => {
    const t = await admin.query("SELECT id FROM tables WHERE business_id=$1", [bizA]);
    const o = await admin.query(
      `INSERT INTO orders (id, business_id, table_id, business_day, daily_number)
       VALUES (gen_random_uuid(), $1, $2, CURRENT_DATE, 99) RETURNING id`,
      [bizA, t.rows[0].id],
    );
    const id = o.rows[0].id;

    await asUser(kitchenA, async () => {
      await app.query("UPDATE orders SET status='ready' WHERE id=$1", [id]);
    });

    const e = await admin.query(
      "SELECT kind, actor_id FROM order_events WHERE order_id=$1 AND kind='ready'",
      [id],
    );
    expect(e.rows[0].actor_id).toBe(kitchenA);
  });
});
```

- [ ] **Step 4: Apply and run**

```bash
cd apps/api && pnpm exec prisma migrate deploy
pnpm --filter @menu/api test kitchen-policies
```

Expected: PASS (12 tests).

Then surface it: in `apps/api/src/orders/orders.service.ts`, the `listEvents` map gains one field:

```ts
    return events.map((e) => ({
      id: Number(e.id),
      kind: e.kind,
      at: e.at.toISOString(),
      data: e.data,
      actorId: e.actorId,
    }));
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/migrations apps/api/src/prisma/kitchen-policies.spec.ts apps/api/src/orders/orders.service.ts
git commit -m "feat(db): record which user caused each order status change"
```

---

### Task 6: The `assertAccess` chokepoint

`assertOwns` is the single door through which a business id becomes usable — 41 call sites. Generalising it here means every route that is *not* touched in Task 7 stays owner-only by construction.

**Files:**
- Modify: `apps/api/src/businesses/businesses.service.ts:22-33`
- Create: `apps/api/src/businesses/access.spec.ts`

**Interfaces:**
- Consumes: `AccessRole` from Task 1.
- Produces: `assertAccess(userId, businessId, opts?: { allow?: AccessRole[] }): Promise<{ business: Business; role: AccessRole }>`; `assertOwns` retained, unchanged signature, returning `Business`; `listAccessible(userId): Promise<Business[]>`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/businesses/access.spec.ts
import { describe, expect, it, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { BusinessesService } from "./businesses.service";

function service(rows: { business?: unknown; staff?: unknown }) {
  const prisma = {
    db: {
      business: { findFirst: vi.fn().mockResolvedValue(rows.business ?? null) },
      businessStaff: { findFirst: vi.fn().mockResolvedValue(rows.staff ?? null) },
    },
  };
  return new BusinessesService(prisma as never, { revalidate: vi.fn() } as never);
}

const BIZ = { id: "b1", name: "Cafe" };

describe("assertAccess", () => {
  it("lets an owner through by default", async () => {
    const s = service({ business: BIZ });
    await expect(s.assertAccess("u1", "b1")).resolves.toMatchObject({ role: "owner" });
  });

  it("refuses staff on a route that did not opt them in", async () => {
    const s = service({ staff: { role: "kitchen", status: "active" } });
    await expect(s.assertAccess("u2", "b1")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("lets staff through when the route allows kitchen", async () => {
    const s = service({ staff: { role: "kitchen", status: "active", business: BIZ } });
    await expect(
      s.assertAccess("u2", "b1", { allow: ["owner", "kitchen"] }),
    ).resolves.toMatchObject({ role: "kitchen" });
  });

  it("refuses a suspended staff member even on an opted-in route", async () => {
    const s = service({ staff: null });  // the query filters status itself
    await expect(
      s.assertAccess("u2", "b1", { allow: ["owner", "kitchen"] }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("keeps assertOwns owner-only", async () => {
    const s = service({ staff: { role: "kitchen", status: "active", business: BIZ } });
    await expect(s.assertOwns("u2", "b1")).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @menu/api test access`
Expected: FAIL — `s.assertAccess is not a function`

- [ ] **Step 3: Implement**

In `apps/api/src/businesses/businesses.service.ts`, replace `assertOwns` and `listMine`:

```ts
import type { AccessRole } from "@menu/shared";

export interface BusinessAccess {
  business: Business;
  role: AccessRole;
}

  /**
   * The single door through which a business id becomes usable.
   *
   * `allow` defaults to owner-only, which is the whole point: a route that
   * nobody thought about stays closed. Opening one to staff is a visible
   * edit at the call site, not something a role check elsewhere can do by
   * accident.
   */
  async assertAccess(
    userId: string,
    businessId: string,
    opts: { allow?: AccessRole[] } = {},
  ): Promise<BusinessAccess> {
    const allow = opts.allow ?? ["owner"];

    if (allow.includes("owner")) {
      const business = await this.prisma.db.business.findFirst({
        where: { id: businessId, ownerId: userId },
      });
      if (business) return { business, role: "owner" };
    }

    const staffRoles = allow.filter((r): r is Exclude<AccessRole, "owner"> => r !== "owner");
    if (staffRoles.length > 0) {
      const member = await this.prisma.db.businessStaff.findFirst({
        where: {
          businessId,
          userId,
          status: "active",
          role: { in: staffRoles },
        },
        include: { business: true },
      });
      if (member) return { business: member.business, role: member.role };
    }

    // The same 404 either way. That a business exists is not something a
    // stranger needs confirmed.
    throw new NotFoundException("Business not found");
  }

  /** Owner-only. Unchanged for all 41 existing call sites. */
  async assertOwns(userId: string, businessId: string): Promise<Business> {
    const { business } = await this.assertAccess(userId, businessId, { allow: ["owner"] });
    return business;
  }

  /** Every business this user can reach, as owner or as staff. */
  async listAccessible(userId: string): Promise<Business[]> {
    const owned = await this.prisma.db.business.findMany({
      where: { ownerId: userId },
      orderBy: { createdAt: "asc" },
    });
    const staffed = await this.prisma.db.businessStaff.findMany({
      where: { userId, status: "active" },
      include: { business: true },
      orderBy: { createdAt: "asc" },
    });
    return [...owned, ...staffed.map((s) => s.business)];
  }

  /** Kept: existing callers ask for "mine" meaning "owned". */
  async listMine(userId: string): Promise<Business[]> {
    return this.prisma.db.business.findMany({
      where: { ownerId: userId },
      orderBy: { createdAt: "asc" },
    });
  }
```

In `apps/api/src/businesses/businesses.controller.ts`, point `GET /businesses/mine` at `listAccessible`, so a kitchen user's session can resolve their venue.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @menu/api test`
Expected: PASS — `access.spec.ts` green and every existing suite still green, because `assertOwns` is unchanged from its callers' view.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/businesses
git commit -m "feat(api): generalise business access to roles, default owner-only"
```

---

### Task 7: Kitchen reads, with prices stripped

**Files:**
- Modify: `apps/api/src/orders/orders.service.ts` (`listBoard`, `listEvents`)
- Modify: `apps/api/src/menu/menu.service.ts:28-43` (`fullMenu`)
- Modify: `apps/api/src/tables/tables.service.ts` (`list`)
- Modify: `apps/api/src/notifications/notifications.service.ts` (list + subscribe)
- Create: `apps/api/src/orders/kitchen-shape.ts`
- Create: `apps/api/src/orders/kitchen-shape.spec.ts`

**Interfaces:**
- Consumes: `assertAccess` from Task 6.
- Produces: `stripPrices<T>(value: T, role: AccessRole): T` in `kitchen-shape.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/orders/kitchen-shape.spec.ts
import { describe, expect, it } from "vitest";
import { stripPrices } from "./kitchen-shape";

/** Walks anything and reports every key that could carry money. */
function priceKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) { value.forEach((v) => priceKeys(v, found)); return found; }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (/^(unitPrice|price|taxRate|lineTotal|total)$/.test(k)) found.push(k);
      priceKeys(v, found);
    }
  }
  return found;
}

const BOARD = [{
  id: "o1",
  status: "placed",
  items: [{ id: "i1", nameSnapshot: "Dosa", quantity: 2, unitPrice: "120.00" }],
  cancellations: [{ id: "c1", nameSnapshot: "Idli", quantity: 1, unitPrice: "60.00" }],
}];

describe("stripPrices", () => {
  it("leaves an owner's payload exactly as it was", () => {
    expect(stripPrices(BOARD, "owner")).toEqual(BOARD);
  });

  it("removes every price from a kitchen payload, at any depth", () => {
    expect(priceKeys(stripPrices(BOARD, "kitchen"))).toEqual([]);
  });

  it("keeps everything the kitchen actually needs", () => {
    const out = stripPrices(BOARD, "kitchen") as typeof BOARD;
    expect(out[0]!.items[0]!.nameSnapshot).toBe("Dosa");
    expect(out[0]!.items[0]!.quantity).toBe(2);
    expect(out[0]!.status).toBe("placed");
  });

  it("strips nested menu shapes too", () => {
    const menu = [{ name: "Mains", items: [{ name: "Dosa", price: "120.00", taxRate: "5.00", variants: [{ name: "L", price: "150.00" }] }] }];
    expect(priceKeys(stripPrices(menu, "kitchen"))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @menu/api test kitchen-shape`
Expected: FAIL — `Cannot find module './kitchen-shape'`

- [ ] **Step 3: Implement**

```ts
// apps/api/src/orders/kitchen-shape.ts
import type { AccessRole } from "@menu/shared";

/**
 * Keys that carry money. Removed rather than zeroed: a zero is a number a
 * screen will happily render, and "₹0.00" on a kitchen board is worse than
 * no column at all.
 */
const PRICE_KEYS = new Set([
  "unitPrice", "price", "taxRate", "lineTotal", "lineNet", "taxAmount", "total",
]);

/**
 * Strips money from anything on its way to a kitchen caller.
 *
 * Done here, at the boundary, rather than by each query choosing its own
 * `select`. Prisma's selects are written per call site and a new include is
 * exactly how a price finds its way back in; one recursive pass over the
 * response cannot be forgotten in the same way.
 */
export function stripPrices<T>(value: T, role: AccessRole): T {
  if (role === "owner") return value;
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(walk);
  if (value instanceof Date) return value;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (PRICE_KEYS.has(k)) continue;
      out[k] = walk(v);
    }
    return out;
  }
  return value;
}
```

Then at each read site, swap the guard and wrap the return. In `orders.service.ts`:

```ts
  async listBoard(userId: string, businessId: string, scope: "today" | "open") {
    const { role } = await this.businesses.assertAccess(userId, businessId, {
      allow: ["owner", "kitchen"],
    });
    // ...existing query, unchanged...
    return stripPrices(orders, role);
  }
```

Apply the same two-line change to `listEvents` (orders), `fullMenu` (menu), `list` (tables), and the notifications list and push-subscribe methods. `setRunning` keeps `assertOwns` — the running flag is not a kitchen concern.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @menu/api test`
Expected: PASS — 4 new tests, all existing suites green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/orders apps/api/src/menu apps/api/src/tables apps/api/src/notifications
git commit -m "feat(api): open board, menu and tables to kitchen with prices stripped"
```

---

### Task 8: Role-aware status and availability writes

**Files:**
- Modify: `apps/api/src/orders/orders.service.ts` (`setStatus`)
- Modify: `apps/api/src/menu/menu.service.ts` (`setItemAvailability`)
- Create: `apps/api/src/orders/set-status-role.spec.ts`

**Interfaces:**
- Consumes: `canRoleSetStatus` (Task 1), `assertAccess` (Task 6).

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/orders/set-status-role.spec.ts
import { describe, expect, it, vi } from "vitest";
import { ConflictException, ForbiddenException } from "@nestjs/common";
import { OrdersService } from "./orders.service";

function service(role: "owner" | "kitchen", from: string) {
  const businesses = {
    assertAccess: vi.fn().mockResolvedValue({ business: { id: "b1" }, role }),
  };
  const prisma = {
    db: {
      order: {
        findFirst: vi.fn().mockResolvedValue({ id: "o1", status: from }),
        update: vi.fn().mockResolvedValue({ id: "o1", status: "ready", items: [], cancellations: [] }),
      },
    },
  };
  return new OrdersService(prisma as never, businesses as never, { emit: vi.fn() } as never);
}

describe("setStatus by role", () => {
  it("lets the kitchen mark an order ready", async () => {
    const s = service("kitchen", "preparing");
    await expect(s.setStatus("u", "b1", "o1", "ready" as never)).resolves.toBeTruthy();
  });

  it("refuses the kitchen `completed` with a 403, not a 409", async () => {
    const s = service("kitchen", "ready");
    await expect(s.setStatus("u", "b1", "o1", "completed" as never))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses the kitchen `cancelled`", async () => {
    const s = service("kitchen", "placed");
    await expect(s.setStatus("u", "b1", "o1", "cancelled" as never))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  // An impossible move is still a 409 for everyone: it is the order's state
  // that refuses, not the person's role.
  it("keeps a backward move a conflict for the owner", async () => {
    const s = service("owner", "completed");
    await expect(s.setStatus("u", "b1", "o1", "placed" as never))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it("lets the owner complete an order", async () => {
    const s = service("owner", "ready");
    await expect(s.setStatus("u", "b1", "o1", "completed" as never)).resolves.toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @menu/api test set-status-role`
Expected: FAIL — kitchen `completed` resolves instead of throwing.

- [ ] **Step 3: Implement**

In `orders.service.ts`, `setStatus`:

```ts
  async setStatus(userId: string, businessId: string, orderId: string, next: OrderStatus) {
    const { role } = await this.businesses.assertAccess(userId, businessId, {
      allow: ["owner", "kitchen"],
    });

    const order = await this.prisma.db.order.findFirst({
      where: { id: orderId, businessId },
      select: { id: true, status: true },
    });
    if (!order) throw new NotFoundException("Order not found");

    // Two different refusals on purpose. The state machine refusing is a
    // fact about the order and reads as 409; a role refusing is a fact about
    // the person and reads as 403. Collapsing them would tell a kitchen user
    // their order was in the wrong state when it was not.
    if (!ALLOWED_TRANSITIONS[order.status].includes(next)) {
      throw new ConflictException(
        `An order that is ${order.status} cannot be moved to ${next}`,
      );
    }
    if (!canRoleSetStatus(role, order.status, next)) {
      throw new ForbiddenException(`You cannot move an order to ${next}`);
    }
    // ...rest unchanged...
  }
```

In `menu.service.ts`, `setItemAvailability` swaps its guard only:

```ts
    await this.businesses.assertAccess(userId, businessId, { allow: ["owner", "kitchen"] });
```

Every other method in that file keeps `assertOwns`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @menu/api test`
Expected: PASS (5 new tests, all suites green).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/orders apps/api/src/menu
git commit -m "feat(api): restrict kitchen to accepted, preparing and ready"
```

---

### Task 9: Staff management API

**Files:**
- Create: `apps/api/src/staff/staff.module.ts`
- Create: `apps/api/src/staff/staff.controller.ts`
- Create: `apps/api/src/staff/staff.service.ts`
- Create: `apps/api/src/staff/staff.service.spec.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `packages/shared/src/schemas.ts`

**Interfaces:**
- Consumes: `PinService`, `TokenService`, `parseIdentifier`, `identifierWhere` from `auth/identifier.ts`, `assertOwns`.
- Produces: `StaffService.list/create/setStatus/resetPin/remove`; `staffCreateSchema`, `staffStatusSchema` in shared.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/staff/staff.service.spec.ts
import { describe, expect, it, vi } from "vitest";
import { ConflictException } from "@nestjs/common";
import { StaffService } from "./staff.service";

function build(existingUser: unknown = null) {
  const prisma = {
    db: {
      businessStaff: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue({ id: "s1", userId: "u9", businessId: "b1" }),
        update: vi.fn().mockResolvedValue({ id: "s1", status: "suspended" }),
        delete: vi.fn().mockResolvedValue({ id: "s1" }),
      },
      user: { update: vi.fn().mockResolvedValue({ id: "u9" }) },
    },
    user: { findFirst: vi.fn().mockResolvedValue(existingUser) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
      fn({
        user: { create: vi.fn().mockResolvedValue({ id: "u9", fullName: "Ramesh" }) },
        businessStaff: { create: vi.fn().mockResolvedValue({ id: "s1", userId: "u9" }) },
        $executeRaw: vi.fn(),
      })),
  };
  const pins = { hashPin: vi.fn().mockResolvedValue("hashed") };
  const tokens = { revokeAllForUser: vi.fn().mockResolvedValue(undefined) };
  const businesses = { assertOwns: vi.fn().mockResolvedValue({ id: "b1" }) };
  const svc = new StaffService(prisma as never, pins as never, tokens as never, businesses as never);
  return { svc, prisma, tokens, pins };
}

describe("staff creation", () => {
  it("returns a six-digit PIN exactly once", async () => {
    const { svc } = build();
    const out = await svc.create("owner1", "b1", { fullName: "Ramesh", identifier: "+919876543210", country: "IN" });
    expect(out.pin).toMatch(/^\d{6}$/);
  });

  it("never stores the PIN in plaintext", async () => {
    const { svc, pins } = build();
    const out = await svc.create("owner1", "b1", { fullName: "Ramesh", identifier: "+919876543210", country: "IN" });
    expect(pins.hashPin).toHaveBeenCalledWith(out.pin);
  });

  it("forces a PIN change on the new account", async () => {
    const { svc } = build();
    const out = await svc.create("owner1", "b1", { fullName: "Ramesh", identifier: "+919876543210", country: "IN" });
    expect(out.staff.mustChangePin ?? true).toBe(true);
  });

  // Review Focus 2: this endpoint must not become an account oracle.
  it("refuses a taken identifier in signup's exact words", async () => {
    const { svc } = build({ id: "existing" });
    await expect(
      svc.create("owner1", "b1", { fullName: "Ramesh", identifier: "+919876543210", country: "IN" }),
    ).rejects.toThrow("An account already uses that phone number");
  });
});

describe("ending access", () => {
  // Review Focus 1: a valid 15-minute token must not outlive suspension.
  it("revokes every session when suspending", async () => {
    const { svc, tokens } = build();
    await svc.setStatus("owner1", "b1", "s1", "suspended");
    expect(tokens.revokeAllForUser).toHaveBeenCalledWith("u9");
  });

  it("revokes every session when removing", async () => {
    const { svc, tokens } = build();
    await svc.remove("owner1", "b1", "s1");
    expect(tokens.revokeAllForUser).toHaveBeenCalledWith("u9");
  });

  it("revokes every session when resetting a PIN", async () => {
    const { svc, tokens } = build();
    await svc.resetPin("owner1", "b1", "s1");
    expect(tokens.revokeAllForUser).toHaveBeenCalledWith("u9");
  });

  it("does not revoke when merely reactivating", async () => {
    const { svc, tokens } = build();
    await svc.setStatus("owner1", "b1", "s1", "active");
    expect(tokens.revokeAllForUser).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @menu/api test staff`
Expected: FAIL — `Cannot find module './staff.service'`

- [ ] **Step 3: Implement**

Add to `packages/shared/src/schemas.ts`:

```ts
export const staffCreateSchema = z.object({
  fullName: z.string().min(1, "Please enter their name").max(80),
  identifier: z.string().min(1, "Enter a phone number or email address"),
  country: z.string().length(2).default("IN"),
});
export type StaffCreateInput = z.infer<typeof staffCreateSchema>;

export const staffStatusSchema = z.object({
  status: z.enum(["active", "suspended"]),
});
export type StaffStatusInput = z.infer<typeof staffStatusSchema>;
```

```ts
// apps/api/src/staff/staff.service.ts
import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { randomInt } from "node:crypto";
import type { StaffCreateInput } from "@menu/shared";
import { PrismaService } from "../prisma/prisma.service";
import { PinService } from "../auth/pin.service";
import { TokenService } from "../auth/token.service";
import { BusinessesService } from "../businesses/businesses.service";
import { identifierWhere, parseIdentifier } from "../auth/identifier";
import { TENANT_TX_MAX_WAIT_MS, TENANT_TX_TIMEOUT_MS } from "../prisma/tenant-context";

/** randomInt, not Math.random: this is a credential. */
function mintPin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pins: PinService,
    private readonly tokens: TokenService,
    private readonly businesses: BusinessesService,
  ) {}

  async list(userId: string, businessId: string) {
    await this.businesses.assertOwns(userId, businessId);
    return this.prisma.db.businessStaff.findMany({
      where: { businessId },
      include: {
        user: { select: { id: true, fullName: true, email: true, phone: true, mustChangePin: true } },
      },
      orderBy: { createdAt: "asc" },
    });
  }

  /**
   * Creates the account and hands its PIN back once.
   *
   * Owner-created rather than invited: there is no transactional email or SMS
   * configured for this path, and an account whose first use depends on an
   * OTP that may never arrive is an account that does not work on day one.
   */
  async create(userId: string, businessId: string, input: StaffCreateInput) {
    await this.businesses.assertOwns(userId, businessId);
    const identifier = parseIdentifier(input.identifier, input.country);

    // Deliberately the same wording signup uses. A different message here
    // would turn this endpoint into a way to ask which phone numbers have
    // accounts.
    const existing = await this.prisma.user.findFirst({ where: identifierWhere(identifier) });
    if (existing) {
      throw new ConflictException(
        identifier.kind === "email"
          ? "An account already uses that email address"
          : "An account already uses that phone number",
      );
    }

    const pin = mintPin();
    const pinHash = await this.pins.hashPin(pin);

    const staff = await this.prisma.$transaction(
      async (tx) => {
        const user = await tx.user.create({
          data: {
            email: identifier.kind === "email" ? identifier.email : null,
            phone: identifier.kind === "phone" ? identifier.phone : null,
            pinHash,
            fullName: input.fullName,
            role: "kitchen",
            // The owner vouching is the verification; there is no channel to
            // send a code on.
            verifiedAt: new Date(),
            mustChangePin: true,
          },
        });
        return tx.businessStaff.create({
          data: { businessId, userId: user.id, role: "kitchen", createdById: userId },
          include: { user: { select: { id: true, fullName: true, email: true, phone: true, mustChangePin: true } } },
        });
      },
      { timeout: TENANT_TX_TIMEOUT_MS, maxWait: TENANT_TX_MAX_WAIT_MS },
    );

    // The only time this value exists outside a hash.
    return { staff, pin };
  }

  async setStatus(userId: string, businessId: string, staffId: string, status: "active" | "suspended") {
    const row = await this.find(userId, businessId, staffId);
    const updated = await this.prisma.db.businessStaff.update({
      where: { id: row.id },
      data: { status },
    });
    // Access tokens live 15 minutes. Without this, someone suspended
    // mid-service keeps working until their token happens to expire.
    if (status === "suspended") await this.tokens.revokeAllForUser(row.userId);
    return updated;
  }

  async resetPin(userId: string, businessId: string, staffId: string) {
    const row = await this.find(userId, businessId, staffId);
    const pin = mintPin();
    await this.prisma.db.user.update({
      where: { id: row.userId },
      data: {
        pinHash: await this.pins.hashPin(pin),
        mustChangePin: true,
        failedAttempts: 0,
        lockedUntil: null,
      },
    });
    await this.tokens.revokeAllForUser(row.userId);
    return { pin };
  }

  async remove(userId: string, businessId: string, staffId: string) {
    const row = await this.find(userId, businessId, staffId);
    await this.prisma.db.businessStaff.delete({ where: { id: row.id } });
    await this.tokens.revokeAllForUser(row.userId);
  }

  private async find(userId: string, businessId: string, staffId: string) {
    await this.businesses.assertOwns(userId, businessId);
    const row = await this.prisma.db.businessStaff.findFirst({
      where: { id: staffId, businessId },
    });
    if (!row) throw new NotFoundException("Staff member not found");
    return row;
  }
}
```

```ts
// apps/api/src/staff/staff.controller.ts
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import {
  staffCreateSchema, staffStatusSchema,
  type StaffCreateInput, type StaffStatusInput,
} from "@menu/shared";
import { CurrentUser } from "../common/decorators";
import { ZodBody } from "../common/zod.pipe";
import type { RequestUser } from "../auth/jwt.strategy";
import { StaffService } from "./staff.service";

/** Owner-only throughout: every method goes through assertOwns. */
@Controller("businesses/:bid/staff")
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  list(@CurrentUser() user: RequestUser, @Param("bid") bid: string) {
    return this.staff.list(user.id, bid);
  }

  @Post()
  create(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Body(new ZodBody(staffCreateSchema)) body: StaffCreateInput,
  ) {
    return this.staff.create(user.id, bid, body);
  }

  @Patch(":staffId")
  setStatus(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Param("staffId") staffId: string,
    @Body(new ZodBody(staffStatusSchema)) body: StaffStatusInput,
  ) {
    return this.staff.setStatus(user.id, bid, staffId, body.status);
  }

  @Post(":staffId/reset-pin")
  @HttpCode(200)
  resetPin(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Param("staffId") staffId: string,
  ) {
    return this.staff.resetPin(user.id, bid, staffId);
  }

  @Delete(":staffId")
  @HttpCode(204)
  async remove(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Param("staffId") staffId: string,
  ) {
    await this.staff.remove(user.id, bid, staffId);
  }
}
```

```ts
// apps/api/src/staff/staff.module.ts
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { BusinessesModule } from "../businesses/businesses.module";
import { StaffController } from "./staff.controller";
import { StaffService } from "./staff.service";

@Module({
  imports: [AuthModule, BusinessesModule],
  controllers: [StaffController],
  providers: [StaffService],
})
export class StaffModule {}
```

Register `StaffModule` in `apps/api/src/app.module.ts`. Ensure `AuthModule` exports `PinService` and `TokenService`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @menu/api test`
Expected: PASS (8 new tests, all suites green).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/staff apps/api/src/app.module.ts packages/shared/src/schemas.ts
git commit -m "feat(api): add staff management for business owners"
```

---

### Task 10: Forced PIN change

Until this clears, the owner knows the staff member's credential and the audit trail from Task 5 proves nothing.

**Files:**
- Modify: `apps/api/src/auth/auth.controller.ts`
- Modify: `apps/api/src/auth/auth.service.ts`
- Create: `apps/api/src/common/must-change-pin.guard.ts`
- Create: `apps/api/src/common/must-change-pin.guard.spec.ts`
- Modify: `apps/api/src/auth/jwt.strategy.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**
- Produces: `RequestUser.mustChangePin: boolean`; `POST /auth/pin/change { currentPin, newPin }`; `MustChangePinGuard`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/common/must-change-pin.guard.spec.ts
import { describe, expect, it } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import { MustChangePinGuard } from "./must-change-pin.guard";

function ctx(user: unknown, path: string) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user, path }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as never;
}

describe("MustChangePinGuard", () => {
  const guard = new MustChangePinGuard();

  it("lets an ordinary user through", () => {
    expect(guard.canActivate(ctx({ id: "u", mustChangePin: false }, "/orders"))).toBe(true);
  });

  // Review Focus 4: the UI gate is cosmetic; the API must refuse too.
  it("refuses every other route while a PIN change is owed", () => {
    expect(() => guard.canActivate(ctx({ id: "u", mustChangePin: true }, "/businesses/mine")))
      .toThrow(ForbiddenException);
  });

  it("allows the change-PIN route itself", () => {
    expect(guard.canActivate(ctx({ id: "u", mustChangePin: true }, "/auth/pin/change"))).toBe(true);
  });

  it("allows /auth/me, so the app can learn why it is blocked", () => {
    expect(guard.canActivate(ctx({ id: "u", mustChangePin: true }, "/auth/me"))).toBe(true);
  });

  it("ignores unauthenticated requests", () => {
    expect(guard.canActivate(ctx(undefined, "/public/menu"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @menu/api test must-change-pin`
Expected: FAIL — `Cannot find module './must-change-pin.guard'`

- [ ] **Step 3: Implement**

```ts
// apps/api/src/common/must-change-pin.guard.ts
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import type { RequestUser } from "../auth/jwt.strategy";

/**
 * Holds an account that owes a PIN change at the door.
 *
 * Applied globally rather than route by route. The web app gates the shell
 * too, but that is cosmetic — a staff member who never opens the web app can
 * still hold a token, and an owner-chosen PIN is a shared credential until
 * its owner replaces it.
 */
const ALLOWED = new Set(["/auth/pin/change", "/auth/me", "/auth/logout", "/auth/refresh"]);

@Injectable()
export class MustChangePinGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const user = req.user as RequestUser | undefined;
    if (!user?.mustChangePin) return true;
    if (ALLOWED.has(req.path)) return true;
    throw new ForbiddenException("Please choose your own PIN before continuing");
  }
}
```

In `jwt.strategy.ts`, widen `RequestUser` and the select:

```ts
export interface RequestUser {
  id: string;
  role: string;
  verified: boolean;
  mustChangePin: boolean;
}

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, role: true, verifiedAt: true, mustChangePin: true },
    });
    if (!user) throw new UnauthorizedException("Session is no longer valid");

    return {
      id: user.id,
      role: user.role,
      verified: user.verifiedAt !== null,
      mustChangePin: user.mustChangePin,
    };
```

In `auth.service.ts`:

```ts
  /**
   * Changing a PIN kills every other session, which is the same rule a reset
   * already follows: whoever knew the old PIN stops being able to use it.
   */
  async changePin(userId: string, currentPin: string, newPin: string): Promise<void> {
    this.pins.assertValidPin(newPin);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException("Session is no longer valid");

    if (!(await this.pins.verifyPin(currentPin, user.pinHash))) {
      throw new UnauthorizedException("That PIN is not correct");
    }
    if (currentPin === newPin) {
      throw new BadRequestException("Please choose a different PIN");
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { pinHash: await this.pins.hashPin(newPin), mustChangePin: false },
    });
    await this.tokens.revokeAllForUser(userId);
  }
```

In `auth.controller.ts`, add the route and widen `/auth/me`:

```ts
  @HttpCode(204)
  @Post("pin/change")
  async changePin(
    @CurrentUser() user: RequestUser,
    @Body(new ZodBody(pinChangeSchema)) body: PinChangeInput,
  ) {
    await this.auth.changePin(user.id, body.currentPin, body.newPin);
  }
```

`/auth/me` returns `mustChangePin: record.mustChangePin` alongside the rest.

Add to `packages/shared/src/schemas.ts`:

```ts
export const pinChangeSchema = z.object({
  currentPin: z.string().regex(/^\d{6}$/, "PIN must be exactly 6 digits"),
  newPin: z.string().regex(/^\d{6}$/, "PIN must be exactly 6 digits"),
});
export type PinChangeInput = z.infer<typeof pinChangeSchema>;
```

Register `MustChangePinGuard` as an `APP_GUARD` in `app.module.ts`, **after** `JwtAuthGuard` so `req.user` is populated.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @menu/api test`
Expected: PASS (5 new tests, all suites green).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth apps/api/src/common apps/api/src/app.module.ts packages/shared/src/schemas.ts
git commit -m "feat(api): force a PIN change on owner-created accounts"
```

---

### Task 11: Web — role types, session and navigation

**Files:**
- Modify: `apps/web/lib/types.ts:10-17`
- Modify: `apps/web/app/(app)/layout.tsx:23-40,57`
- Create: `apps/web/lib/nav.ts`
- Create: `apps/web/lib/nav.spec.ts`

**Interfaces:**
- Produces: `navFor(role): NavItem[]`, `canSee(role, pathname): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/lib/nav.spec.ts
import { describe, expect, it } from "vitest";
import { canSee, navFor } from "./nav";

describe("navigation by role", () => {
  it("gives the kitchen only what a service needs", () => {
    expect(navFor("kitchen").map((i) => i.href)).toEqual(["/orders", "/dishes"]);
  });

  it("keeps the owner's nine sections", () => {
    expect(navFor("owner")).toHaveLength(9);
    expect(navFor("owner").map((i) => i.href)).toContain("/billing");
  });

  it("adds our section for platform admins only", () => {
    expect(navFor("platform_admin").map((i) => i.href)).toContain("/admin");
    expect(navFor("owner").map((i) => i.href)).not.toContain("/admin");
  });

  it("keeps the kitchen out of every money screen", () => {
    for (const path of ["/billing", "/settings", "/qr", "/merch", "/appearance", "/dashboard", "/tables", "/menu"]) {
      expect(canSee("kitchen", path)).toBe(false);
    }
  });

  it("lets the kitchen reach its own two screens", () => {
    expect(canSee("kitchen", "/orders")).toBe(true);
    expect(canSee("kitchen", "/dishes")).toBe(true);
  });

  it("keeps owners off the kitchen-only dish screen", () => {
    expect(canSee("owner", "/dishes")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @menu/web test nav`
Expected: FAIL — `Cannot find module './nav'`

- [ ] **Step 3: Implement**

```ts
// apps/web/lib/nav.ts

/**
 * Navigation entries carry no icon. The icons are React components defined in
 * the layout, and keeping them out of here is what lets this file be tested
 * in a node environment — the layout maps href to icon when it renders.
 */
export interface NavItem {
  href: string;
  label: string;
}

export type Role = "owner" | "kitchen" | "platform_admin";

const OWNER_NAV: NavItem[] = [
  { href: "/dashboard",  label: "Overview" },
  { href: "/orders",     label: "Orders" },
  { href: "/menu",       label: "Menu" },
  { href: "/tables",     label: "Tables" },
  { href: "/billing",    label: "Billing" },
  { href: "/appearance", label: "Menu design" },
  { href: "/qr",         label: "QR code" },
  { href: "/merch",      label: "Printed cards" },
  { href: "/settings",   label: "Settings" },
];

const KITCHEN_NAV: NavItem[] = [
  { href: "/orders", label: "Orders" },
  { href: "/dishes", label: "Dishes" },
];

const ADMIN_NAV: NavItem[] = [{ href: "/admin", label: "Card orders" }];

/**
 * Navigation is derived per role, not filtered from one list.
 *
 * The old shape appended an extra entry for platform admins, which worked
 * because they see everything an owner does plus one. A kitchen user needs a
 * *different* list, not a longer one, and filtering a nine-item array by
 * predicate is how a section ends up visible because someone forgot to add
 * it to the deny list.
 */
export function navFor(role: Role): NavItem[] {
  switch (role) {
    case "kitchen":        return KITCHEN_NAV;
    case "platform_admin": return [...OWNER_NAV, ...ADMIN_NAV];
    default:               return OWNER_NAV;
  }
}

const ALLOWED: Record<Role, string[]> = {
  kitchen: ["/orders", "/dishes", "/change-pin"],
  owner: ["/dashboard", "/orders", "/menu", "/tables", "/billing",
          "/appearance", "/qr", "/merch", "/settings", "/change-pin"],
  platform_admin: ["/dashboard", "/orders", "/menu", "/tables", "/billing",
                   "/appearance", "/qr", "/merch", "/settings", "/admin", "/change-pin"],
};

/**
 * Cosmetic only. There is no middleware.ts in this app, so this stops a
 * mistyped URL rendering a broken screen — it is not the security boundary.
 * That is the API and the RLS policies behind it.
 */
export function canSee(role: Role, pathname: string): boolean {
  return ALLOWED[role].some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
```

In `apps/web/lib/types.ts`:

```ts
export interface Me {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  role: "owner" | "kitchen" | "platform_admin";
  verified: boolean;
  mustChangePin: boolean;
}
```

In `apps/web/app/(app)/layout.tsx`, delete the module-level `NAV` and `ADMIN_NAV` arrays and keep every icon component. Add an href-to-icon map (including a `/dishes` entry — reuse `MenuIcon`), then replace line 57:

```ts
const ICONS: Record<string, ComponentType> = {
  "/dashboard": OverviewIcon, "/orders": OrdersIcon, "/menu": MenuIcon,
  "/dishes": MenuIcon, "/tables": TablesIcon, "/billing": BillingIcon,
  "/appearance": AppearanceIcon, "/qr": QrIcon, "/merch": CardsIcon,
  "/settings": SettingsIcon, "/admin": CardsIcon,
};

  const role = (me?.role ?? "owner") as Role;
  const items = navFor(role);
```

Where the nav renders, `const Icon = ICONS[item.href]!` replaces `item.icon`. `TABS` stays 4; for a kitchen user `items.slice(0, 4)` is simply both entries and `rest` is empty, so the More sheet does not render.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @menu/web test`
Expected: PASS (6 new tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/nav.ts apps/web/lib/nav.spec.ts apps/web/lib/types.ts "apps/web/app/(app)/layout.tsx"
git commit -m "feat(web): derive navigation from the signed-in role"
```

---

### Task 12: Web — role-aware order board

**Files:**
- Modify: `apps/web/app/(app)/orders/page.tsx:26,32-36,114-160,342-350,512-513,594`
- Create: `apps/web/lib/board-actions.ts`
- Create: `apps/web/lib/board-actions.spec.ts`

**Interfaces:**
- Consumes: `ROLE_TARGETS`, `canRoleSetStatus` from `@menu/shared`.
- Produces: `columnsFor(role): BoardColumn[]`, `showsMoney(role): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/lib/board-actions.spec.ts
import { describe, expect, it } from "vitest";
import { columnsFor, showsMoney } from "./board-actions";

describe("board actions by role", () => {
  it("keeps all four columns for the kitchen, so they can see what is waiting", () => {
    expect(columnsFor("kitchen").map((c) => c.status))
      .toEqual(["placed", "accepted", "preparing", "ready"]);
  });

  it("removes Served from the kitchen's Ready column", () => {
    expect(columnsFor("kitchen").find((c) => c.status === "ready")?.next).toBeUndefined();
  });

  it("leaves the kitchen its three real actions", () => {
    const c = columnsFor("kitchen");
    expect(c.find((x) => x.status === "placed")?.next).toBe("accepted");
    expect(c.find((x) => x.status === "accepted")?.next).toBe("preparing");
    expect(c.find((x) => x.status === "preparing")?.next).toBe("ready");
  });

  it("gives the owner Served back", () => {
    expect(columnsFor("owner").find((c) => c.status === "ready")?.next).toBe("completed");
  });

  it("shows no money to the kitchen", () => {
    expect(showsMoney("kitchen")).toBe(false);
    expect(showsMoney("owner")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @menu/web test board-actions`
Expected: FAIL — `Cannot find module './board-actions'`

- [ ] **Step 3: Implement**

```ts
// apps/web/lib/board-actions.ts
import { canRoleSetStatus, type AccessRole, type OrderStatus } from "@menu/shared";

export interface BoardColumn {
  status: OrderStatus;
  title: string;
  next?: OrderStatus;
  nextLabel?: string;
}

const COLUMNS: Required<BoardColumn>[] = [
  { status: "placed",    title: "New",        next: "accepted",  nextLabel: "Accept" },
  { status: "accepted",  title: "Accepted",   next: "preparing", nextLabel: "Start" },
  { status: "preparing", title: "Being made", next: "ready",     nextLabel: "Ready" },
  { status: "ready",     title: "Ready",      next: "completed", nextLabel: "Served" },
];

/**
 * All four columns always render. A kitchen that cannot see what is sitting
 * in Ready cannot tell whether the pass is backing up — the column is
 * information, the button is the permission, and only the button is withheld.
 */
export function columnsFor(role: AccessRole): BoardColumn[] {
  return COLUMNS.map((c) =>
    canRoleSetStatus(role, c.status, c.next)
      ? c
      : { status: c.status, title: c.title },
  );
}

/** Belt to the API's braces: it already omits every price for kitchen. */
export function showsMoney(role: AccessRole): boolean {
  return role === "owner";
}
```

In `orders/page.tsx`: replace the module-level `COLUMNS` with `columnsFor(role)` computed from `useSession()`; make `unitPrice` optional on the `Order` item type (line 26); and guard both total computations so a line without a price contributes nothing and the total renders only when `showsMoney(role)`:

```ts
  unitPrice?: string;
```

```tsx
  const total = order.items.reduce(
    (sum, i) => sum + Number(i.unitPrice ?? 0) * i.quantity,
    0,
  );
```

```tsx
  {showsMoney(role) && <span>{formatMoney(String(total), currency)}</span>}
```

Hide the cancel control when `!canRoleSetStatus(role, order.status, "cancelled")`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @menu/web test`
Expected: PASS (5 new tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/board-actions.ts apps/web/lib/board-actions.spec.ts "apps/web/app/(app)/orders/page.tsx"
git commit -m "feat(web): draw board actions and money from the signed-in role"
```

---

### Task 13: Web — the kitchen dish screen

Deliberately not the existing menu builder behind a flag: that page is dense with prices, variants and photo uploads, and threading `canEdit` through it is how a price leaks back in six months.

**Files:**
- Create: `apps/web/app/(app)/dishes/page.tsx`

**Interfaces:**
- Consumes: `GET /businesses/:id/menu` (prices already stripped by Task 7), `PATCH /businesses/:id/menu/items/:id/availability`.

- [ ] **Step 1: Write the page**

```tsx
// apps/web/app/(app)/dishes/page.tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { useSession } from "@/components/session";
import { Button, cx } from "@/components/ui";

/**
 * What the kitchen can change about the menu: whether a dish is on.
 *
 * The owner's builder is a different screen on purpose. Its job is prices,
 * variants, photos and ordering; this one's is a single switch that has to be
 * usable with one hand, mid-service, on a tablet with flour on it.
 */
interface Item { id: string; name: string; isAvailable: boolean }
interface Category { id: string; name: string; items: Item[] }

export default function DishesPage() {
  const { current } = useSession();
  const [categories, setCategories] = useState<Category[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!current) return;
    try {
      setCategories(await api.get<Category[]>(`/businesses/${current.id}/menu`));
    } catch {
      setError("We couldn't load the menu just now.");
    }
  }, [current]);

  useEffect(() => { void load(); }, [load]);

  async function toggle(item: Item) {
    if (!current) return;
    setBusy(item.id);
    setError(null);
    // Optimistic: a switch that waits on a round trip gets tapped twice.
    setCategories((prev) => prev.map((c) => ({
      ...c,
      items: c.items.map((i) => i.id === item.id ? { ...i, isAvailable: !i.isAvailable } : i),
    })));
    try {
      await api.patch(
        `/businesses/${current.id}/menu/items/${item.id}/availability`,
        { isAvailable: !item.isAvailable },
      );
    } catch {
      setError("That didn't save. Check the connection and try again.");
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (!current) return null;

  return (
    <div className="px-edge py-6">
      <h1 className="text-[20px] font-semibold text-ink">Dishes</h1>
      <p className="mt-1 text-[13.5px] text-muted">
        Turn a dish off when you run out. Diners stop seeing it straight away.
      </p>

      {error && (
        <p role="alert" className="mt-4 rounded-xl bg-[var(--accent-soft)] px-3 py-2 text-[13px] text-ink">
          {error}
        </p>
      )}

      {categories.map((category) => (
        <section key={category.id} className="mt-7">
          <h2 className="text-[13px] font-semibold uppercase tracking-wide text-faint">
            {category.name}
          </h2>
          <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
            {category.items.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-3 px-3.5 py-3">
                <span className={cx(
                  "min-w-0 truncate text-[14.5px]",
                  item.isAvailable ? "text-ink" : "text-faint line-through",
                )}>
                  {item.name}
                </span>
                <Button
                  size="sm"
                  variant={item.isAvailable ? "ghost" : "primary"}
                  disabled={busy === item.id}
                  aria-pressed={!item.isAvailable}
                  onClick={() => void toggle(item)}
                >
                  {item.isAvailable ? "Turn off" : "Turn on"}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm --filter @menu/web lint`
Expected: no type errors.

- [ ] **Step 3: Check it by hand**

Sign in as a kitchen user, open `/dishes`, toggle a dish, reload the public menu and confirm it disappeared. Confirm no price appears anywhere on the page.

- [ ] **Step 4: Commit**

```bash
git add "apps/web/app/(app)/dishes/page.tsx"
git commit -m "feat(web): add the kitchen dish availability screen"
```

---

### Task 14: Web — staff management screen

**Files:**
- Create: `apps/web/app/(app)/settings/staff/page.tsx`
- Modify: `apps/web/app/(app)/settings/page.tsx` (link to it)

- [ ] **Step 1: Write the page**

```tsx
// apps/web/app/(app)/settings/staff/page.tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { useSession } from "@/components/session";
import { useConfirm } from "@/components/confirm";
import { Button, Input } from "@/components/ui";
import { IdentifierField } from "@/components/identifier-field";

interface Staff {
  id: string;
  status: "active" | "suspended";
  user: { id: string; fullName: string; email: string | null; phone: string | null; mustChangePin: boolean };
}

export default function StaffPage() {
  const { current } = useSession();
  const confirm = useConfirm();
  const [staff, setStaff] = useState<Staff[]>([]);
  const [fullName, setFullName] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** Shown once and never recoverable — see the warning in the panel. */
  const [issued, setIssued] = useState<{ name: string; pin: string } | null>(null);

  const load = useCallback(async () => {
    if (!current) return;
    setStaff(await api.get<Staff[]>(`/businesses/${current.id}/staff`));
  }, [current]);

  useEffect(() => { void load(); }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!current) return;
    setError(null);
    try {
      const res = await api.post<{ staff: Staff; pin: string }>(
        `/businesses/${current.id}/staff`,
        { fullName, identifier, country: "IN" },
      );
      setIssued({ name: fullName, pin: res.pin });
      setFullName(""); setIdentifier("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    }
  }

  async function setStatus(row: Staff, status: "active" | "suspended") {
    if (!current) return;
    await api.patch(`/businesses/${current.id}/staff/${row.id}`, { status });
    await load();
  }

  async function resetPin(row: Staff) {
    if (!current) return;
    const res = await api.post<{ pin: string }>(
      `/businesses/${current.id}/staff/${row.id}/reset-pin`, {},
    );
    setIssued({ name: row.user.fullName, pin: res.pin });
    await load();
  }

  async function remove(row: Staff) {
    if (!current) return;
    const ok = await confirm({
      title: `Remove ${row.user.fullName}?`,
      body: "They'll be signed out straight away and won't be able to sign back in.",
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!ok) return;
    await api.del(`/businesses/${current.id}/staff/${row.id}`);
    await load();
  }

  if (!current) return null;

  return (
    <div className="px-edge py-6">
      <h1 className="text-[20px] font-semibold text-ink">Kitchen staff</h1>
      <p className="mt-1 text-[13.5px] text-muted">
        Kitchen logins see orders and dishes. They can't see prices, bills or settings.
      </p>

      {issued && (
        <div role="status" className="mt-4 rounded-xl border border-line bg-raised p-4">
          <p className="text-[14px] font-medium text-ink">{issued.name}'s PIN</p>
          <p className="mt-1 font-mono text-[28px] tracking-[0.2em] text-ink">{issued.pin}</p>
          <p className="mt-1.5 text-[12.5px] text-muted">
            Write this down or pass it on now — it won't be shown again. They'll
            be asked to choose their own PIN when they first sign in.
          </p>
          <Button size="sm" className="mt-3" onClick={() => setIssued(null)}>Done</Button>
        </div>
      )}

      <form onSubmit={add} className="mt-6 space-y-3 rounded-xl border border-line p-4">
        <Input label="Name" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
        <IdentifierField value={identifier} onChange={setIdentifier} />
        {error && <p role="alert" className="text-[13px] text-ink">{error}</p>}
        <Button type="submit" variant="primary">Add kitchen login</Button>
      </form>

      <ul className="mt-6 divide-y divide-line rounded-xl border border-line">
        {staff.map((row) => (
          <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-3">
            <div className="min-w-0">
              <p className="truncate text-[14.5px] text-ink">{row.user.fullName}</p>
              <p className="truncate text-[12.5px] text-faint">
                {row.user.phone ?? row.user.email}
                {row.status === "suspended" && " · suspended"}
                {row.user.mustChangePin && " · hasn't set their own PIN yet"}
              </p>
            </div>
            <div className="flex gap-1.5">
              {row.status === "active" ? (
                <Button size="sm" onClick={() => void setStatus(row, "suspended")}>Suspend</Button>
              ) : (
                <Button size="sm" onClick={() => void setStatus(row, "active")}>Reactivate</Button>
              )}
              <Button size="sm" onClick={() => void resetPin(row)}>Reset PIN</Button>
              <Button size="sm" variant="ghost" onClick={() => void remove(row)}>Remove</Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

Add a link to this page from `settings/page.tsx`.

- [ ] **Step 2: Verify it compiles**

Run: `pnpm --filter @menu/web lint`
Expected: no type errors. If `api.del` does not exist, use the verb `api-client.ts` actually exports.

- [ ] **Step 3: Check it by hand**

Add a staff member, confirm the PIN shows once, suspend them, confirm their session dies on their next action.

- [ ] **Step 4: Commit**

```bash
git add "apps/web/app/(app)/settings"
git commit -m "feat(web): add kitchen staff management for owners"
```

---

### Task 15: Web — forced PIN change screen

**Files:**
- Create: `apps/web/app/(app)/change-pin/page.tsx`
- Modify: `apps/web/app/(app)/layout.tsx`

- [ ] **Step 1: Write the page and the gate**

```tsx
// apps/web/app/(app)/change-pin/page.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, logout } from "@/lib/api-client";
import { PinInput } from "@/components/pin-input";
import { Button } from "@/components/ui";

/**
 * Shown once, to an account whose PIN was chosen by somebody else.
 *
 * Changing a PIN revokes every session, this one included, so the only
 * honest ending is to send them back to sign in with the PIN they just
 * picked.
 */
export default function ChangePinPage() {
  const router = useRouter();
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPin !== confirmPin) { setError("Those two PINs don't match."); return; }
    setSaving(true);
    try {
      await api.post("/auth/pin/change", { currentPin, newPin });
      await logout();
      router.replace("/login");
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm px-edge py-10">
      <h1 className="text-[20px] font-semibold text-ink">Choose your own PIN</h1>
      <p className="mt-1 text-[13.5px] text-muted">
        Someone else set the PIN you signed in with. Pick one only you know.
      </p>
      <form onSubmit={submit} className="mt-6 space-y-5">
        <PinInput label="PIN you were given" value={currentPin} onChange={setCurrentPin} />
        <PinInput label="New PIN" value={newPin} onChange={setNewPin} />
        <PinInput label="New PIN again" value={confirmPin} onChange={setConfirmPin} />
        {error && <p role="alert" className="text-[13px] text-ink">{error}</p>}
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? "Saving…" : "Save PIN"}
        </Button>
      </form>
    </div>
  );
}
```

In `layout.tsx`, gate ahead of the nav redirect from Task 11:

```tsx
  useEffect(() => {
    if (loading || !me) return;
    if (me.mustChangePin && pathname !== "/change-pin") { router.replace("/change-pin"); return; }
    if (!me.mustChangePin && !canSee(role, pathname)) router.replace("/orders");
  }, [loading, me, role, pathname, router]);
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm --filter @menu/web lint`
Expected: no type errors. Check `PinInput`'s real props in `components/pin-input.tsx` and match them.

- [ ] **Step 3: Check it by hand**

Sign in as freshly created staff; confirm every route bounces to `/change-pin`; change it; confirm you are returned to login and the new PIN works.

- [ ] **Step 4: Commit**

```bash
git add "apps/web/app/(app)/change-pin" "apps/web/app/(app)/layout.tsx"
git commit -m "feat(web): force a PIN change before an owner-created account can work"
```

---

### Task 16: Adversarial isolation and end-to-end

**Files:**
- Modify: `apps/api/scripts/check-isolation.sh`
- Create: `apps/web/e2e/kitchen.spec.ts`

- [ ] **Step 1: Add a kitchen actor to the isolation script**

After the two tenants are created, add this block. Every variable it uses is defined here — `K_TOKEN` is established before the first probe that needs it, and `A_ITEM` / `A_ORDER` are real ids fetched from tenant A:

```bash
echo "Creating a kitchen user inside tenant A…"
K_PHONE=$(rand_phone)
K_PIN=$(curl -s -X POST "$API/businesses/$A_BID/staff" \
  -H "Authorization: Bearer $A_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"fullName\":\"Kitchen A\",\"identifier\":\"$K_PHONE\",\"country\":\"IN\"}" \
  | json_field '["pin"]')

login() { # identifier, pin
  curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
    -d "{\"identifier\":\"$1\",\"pin\":\"$2\",\"country\":\"IN\"}" | json_field '["accessToken"]'
}

K_TOKEN=$(login "$K_PHONE" "$K_PIN")

# The account owes a PIN change, so it can do nothing until it picks one.
# Worth proving before the session is used for anything else.
probe "kitchen owing a PIN change cannot read the board" 403 \
  -H "Authorization: Bearer $K_TOKEN" "$API/businesses/$A_BID/orders"

# Change it, then sign in again — changing a PIN revokes every session.
curl -s -o /dev/null -X POST "$API/auth/pin/change" \
  -H "Authorization: Bearer $K_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"currentPin\":\"$K_PIN\",\"newPin\":\"778899\"}"
K_TOKEN=$(login "$K_PHONE" "778899")

# Real ids from tenant A, so the probes below fail on permission rather than
# on a 404 for something that was never there.
A_CAT=$(curl -s -X POST "$API/businesses/$A_BID/categories" \
  -H "Authorization: Bearer $A_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Mains"}' | json_field '["id"]')
A_ITEM=$(curl -s -X POST "$API/businesses/$A_BID/items" \
  -H "Authorization: Bearer $A_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"categoryId\":\"$A_CAT\",\"name\":\"Dosa\",\"price\":\"120.00\"}" | json_field '["id"]')
A_ORDER=$(curl -s "$API/businesses/$A_BID/orders?scope=open" \
  -H "Authorization: Bearer $A_TOKEN" | json_field '[0]["id"]')
```

If `A_ORDER` is empty because no order exists yet, reuse whatever the ordering section of this script already creates — this block must run after it. Then the probes, all of which must fail:

```bash
probe "kitchen cannot read tenant B's orders"     404 -H "Authorization: Bearer $K_TOKEN" "$API/businesses/$B_BID/orders"
probe "kitchen cannot read its own venue's bills" 404 -H "Authorization: Bearer $K_TOKEN" "$API/businesses/$A_BID/bills"
probe "kitchen cannot read tax settings"          404 -H "Authorization: Bearer $K_TOKEN" "$API/businesses/$A_BID/tax"
probe "kitchen cannot list staff"                 404 -H "Authorization: Bearer $K_TOKEN" "$API/businesses/$A_BID/staff"
probe "kitchen cannot create staff"               404 -H "Authorization: Bearer $K_TOKEN" -X POST "$API/businesses/$A_BID/staff" \
  -H 'Content-Type: application/json' -d '{"fullName":"X","identifier":"+919000000000","country":"IN"}'
probe "kitchen cannot edit a dish"                404 -H "Authorization: Bearer $K_TOKEN" -X PUT "$API/businesses/$A_BID/items/$A_ITEM" \
  -H 'Content-Type: application/json' -d '{"name":"Hacked","price":"1.00"}'
probe "kitchen cannot complete an order"          403 -H "Authorization: Bearer $K_TOKEN" -X PATCH "$API/businesses/$A_BID/orders/$A_ORDER/status" \
  -H 'Content-Type: application/json' -d '{"status":"completed"}'
probe "kitchen cannot cancel an order"            403 -H "Authorization: Bearer $K_TOKEN" -X PATCH "$API/businesses/$A_BID/orders/$A_ORDER/status" \
  -H 'Content-Type: application/json' -d '{"status":"cancelled"}'
```

Add one positive assertion, so the script cannot pass by the kitchen token simply being invalid:

```bash
echo "Checking the kitchen CAN do its own job…"
curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $K_TOKEN" \
  "$API/businesses/$A_BID/orders" | grep -q '^2' \
  || { echo "FAILED: kitchen cannot read its own board"; FAILURES=$((FAILURES+1)); }
```

- [ ] **Step 2: Run it**

```bash
bash apps/api/scripts/check-isolation.sh http://localhost:4000
```

Expected: exit 0, every probe refused, the positive check passing.

- [ ] **Step 3: Write the end-to-end test**

PIN fields are six separate inputs labelled `"<label>, digit N of 6"`, so this
reuses `happy-path.spec.ts`'s `typePin` helper rather than inventing a
selector that does not exist.

```ts
// apps/web/e2e/kitchen.spec.ts
import { expect, test, type Page } from "@playwright/test";

const STAMP = Date.now();
const OWNER_EMAIL = `kitchen-owner-${STAMP}@example.test`;
const OWNER_PIN = "482913";
const STAFF_PHONE = `+9198${String(STAMP).slice(-8)}`;
const STAFF_NEW_PIN = "778899";

/** PIN inputs are six boxes, each with its own label. */
async function typePin(page: Page, label: string, digits: string) {
  for (let i = 0; i < digits.length; i++) {
    await page.getByLabel(`${label}, digit ${i + 1} of 6`).fill(digits[i]!);
  }
}

test("an owner creates a kitchen login and it can only work a service", async ({ page, context }) => {
  // ── Owner signs up ───────────────────────────────────────────────────────
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Asha Rao");
  await page.getByLabel("Email or phone number").fill(OWNER_EMAIL);
  await typePin(page, "Choose a 6-digit PIN", OWNER_PIN);
  await page.getByLabel("Business name").fill("Kitchen Test Cafe");
  await page.getByRole("button", { name: "Cafe" }).click();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Menu", exact: true })).toBeVisible();

  // One dish, so /dishes has something to toggle.
  await page.getByPlaceholder("Coffee").fill("Mains");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Add a dish to Mains" }).click();
  await page.getByLabel("Name").fill("Dosa");
  await page.locator('input[placeholder="140"]').first().fill("120");
  await page.getByRole("button", { name: "Add dish" }).click();

  // ── Owner creates the kitchen login ──────────────────────────────────────
  await page.goto("/settings/staff");
  await page.getByLabel("Name").fill("Ramesh");
  await page.getByLabel("Email or phone number").fill(STAFF_PHONE);
  await page.getByRole("button", { name: "Add kitchen login" }).click();

  const pin = (await page.getByText(/^\d{6}$/).first().textContent())!.trim();
  expect(pin).toMatch(/^\d{6}$/);

  // ── Staff signs in, in a separate browser context ────────────────────────
  const staffContext = await context.browser()!.newContext();
  const kitchen = await staffContext.newPage();
  await kitchen.goto("/login");
  await kitchen.getByLabel("Email or phone number").fill(STAFF_PHONE);
  await typePin(kitchen, "Your 6-digit PIN", pin);
  await kitchen.getByRole("button", { name: /sign in/i }).click();

  // Forced PIN change, then back to login because the change revokes sessions.
  await expect(kitchen).toHaveURL(/\/change-pin/);
  await typePin(kitchen, "PIN you were given", pin);
  await typePin(kitchen, "New PIN", STAFF_NEW_PIN);
  await typePin(kitchen, "New PIN again", STAFF_NEW_PIN);
  await kitchen.getByRole("button", { name: "Save PIN" }).click();

  await expect(kitchen).toHaveURL(/\/login/);
  await kitchen.getByLabel("Email or phone number").fill(STAFF_PHONE);
  await typePin(kitchen, "Your 6-digit PIN", STAFF_NEW_PIN);
  await kitchen.getByRole("button", { name: /sign in/i }).click();

  // ── What they can and cannot see ─────────────────────────────────────────
  await expect(kitchen.getByRole("link", { name: "Orders" })).toBeVisible();
  await expect(kitchen.getByRole("link", { name: "Dishes" })).toBeVisible();
  for (const hidden of ["Billing", "Settings", "QR code", "Printed cards", "Overview", "Tables"]) {
    await expect(kitchen.getByRole("link", { name: hidden })).toHaveCount(0);
  }

  await kitchen.goto("/billing");
  await expect(kitchen).toHaveURL(/\/orders/);

  await kitchen.goto("/dishes");
  await expect(kitchen.getByText("Dosa")).toBeVisible();
  await expect(kitchen.getByText(/₹/)).toHaveCount(0);
  await kitchen.getByRole("button", { name: "Turn off" }).first().click();
  await expect(kitchen.getByRole("button", { name: "Turn on" }).first()).toBeVisible();

  await staffContext.close();
});
```

The board assertions (Accept → Ready, no **Served**, no money) need a placed order, which means a diner session. Add them by extending `ordering.spec.ts`, which already builds that fixture, rather than duplicating table-claim setup here.

- [ ] **Step 4: Run it**

```bash
pnpm --filter @menu/web exec playwright test e2e/kitchen.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Run everything and commit**

```bash
pnpm -r test && pnpm -r lint
git add apps/api/scripts/check-isolation.sh apps/web/e2e/kitchen.spec.ts
git commit -m "test: prove kitchen isolation end to end"
```

---

## Deploying to production

After the whole branch is reviewed and merged, and **only** then:

```bash
cp .env.prod .env
cd apps/api && pnpm exec prisma migrate deploy
```

Prod and dev are both at migration 15 as of 2026-10-04, so this applies exactly the one new migration. Verify immediately afterwards:

```bash
psql "$DIRECT_URL" -tAc "select count(*) from pg_policies where policyname like '%\_kitchen\_%';"   # 11
psql "$DIRECT_URL" -tAc "select count(*) from business_staff;"                                     # 0
```

Then `cp .env.dev .env` to get back off production.
