# Order Acceptance and Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `accepted` order status between `placed` and `preparing`, and a per-order event log rendered as a timestamped timeline for both diners and owners.

**Architecture:** Two Prisma migrations (the enum value alone, then everything that names it as a literal). A new `order_events` table written by two authors — `place_table_round` for round contents, a Postgres trigger for every status change. The diner reads events embedded in `get_table_order`; the owner board fetches them from a dedicated endpoint only when a card is expanded. One pure TypeScript module turns an event array into rendered steps; one React component renders them in two tones.

**Tech Stack:** NestJS + Prisma + Postgres (Supabase), Next.js App Router + Tailwind, vitest (unit), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-09-27-order-acceptance-timeline-design.md`

## Global Constraints

- The enum value is added **`BEFORE 'preparing'`**, never appended — `listForBusiness` sorts by `status: "asc"` and Postgres sorts enums by declaration order.
- `ALTER TYPE ... ADD VALUE` lives **alone** in its own migration folder. Postgres refuses to use a new enum value in the transaction that added it, and Prisma wraps each migration in one.
- Migration folder names must sort with the `ALTER TYPE` first: `20260927100000_order_accepted_status`, then `20260927110000_order_events`.
- All five hard-coded "open status" lists change together: `orders_one_open_per_table`, `place_table_round`, `get_table_order`, `OPEN_STATUSES`, `ALLOWED_TRANSITIONS`.
- `order_events` is ordered by `id` (bigserial), never by `at`.
- Comments follow the house voice already in this repo: explain *why*, name the failure being prevented, no restating of what the code says.
- `pnpm lint` is `tsc --noEmit` in both apps and must pass at every commit.

## Review Focus

These are exercised by tests in the tasks named, not left to a reviewer's eye:

1. **A round added to an `accepted` order** must land on the existing order, not create a second one — the index and `place_table_round` bug. Task 9 (e2e) and Task 3 (SQL assertion).
2. **An order that skipped a stage** (`placed → ready`) must not render a fabricated "Accepted" step, nor list `accepted` as upcoming. Task 5.
3. **A backfilled order** with only `placed` and `completed` events must render a two-entry timeline, not a crash or five empty rows. Task 5.
4. **A cancelled order** must show no upcoming stages — "Ready" and "Served" are never coming. Task 5.
5. **Gap arithmetic across an hour boundary and between same-second events** must read `+1h 4m` and `+<1m`, not `+64m` and `+0m`. Task 5.

---

### Task 1: The `accepted` enum value

**Files:**
- Create: `apps/api/prisma/migrations/20260927100000_order_accepted_status/migration.sql`
- Modify: `apps/api/prisma/schema.prisma:273-279`

**Interfaces:**
- Consumes: nothing.
- Produces: `OrderStatus` from `@prisma/client` gains the member `"accepted"`, positioned between `placed` and `preparing`.

- [ ] **Step 1: Write the migration**

```sql
-- The `accepted` status.
--
-- Alone in its own migration on purpose. Postgres will not let a new enum
-- value be *used* in the transaction that added it, and Prisma runs each
-- migration in one — so the table, trigger and functions that name
-- 'accepted' as a literal live in the next folder. Collapsing the two fails
-- at deploy time rather than at review time.
--
-- BEFORE 'preparing', not appended. listForBusiness orders by status ASC and
-- Postgres sorts an enum by declaration order; appending would sort accepted
-- orders after cancelled ones.
ALTER TYPE "OrderStatus" ADD VALUE 'accepted' BEFORE 'preparing';
```

- [ ] **Step 2: Update the Prisma enum to match**

In `apps/api/prisma/schema.prisma`:

```prisma
enum OrderStatus {
  placed
  /// Staff have seen it and taken it on. The diner's screen says so within a
  /// second; the kitchen has not necessarily started work.
  accepted
  preparing
  ready
  completed
  cancelled
}
```

- [ ] **Step 3: Apply the migration and regenerate the client**

Run: `cd apps/api && pnpm db:migrate && pnpm db:generate`
Expected: migration applies cleanly; client regenerates.

- [ ] **Step 4: Run the typecheck to see it fail**

Run: `cd apps/api && pnpm lint`
Expected: FAIL — `Property 'accepted' is missing in type` for `ALLOWED_TRANSITIONS`, which is declared `Record<OrderStatus, OrderStatus[]>` at `src/orders/orders.service.ts:22`. This failure is the point: it proves the compiler will find every exhaustive map over the status union. Do not fix it here — Task 2 does.

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/migrations/20260927100000_order_accepted_status apps/api/prisma/schema.prisma
git commit -m "feat(api): add the accepted order status to the enum"
```

---

### Task 2: The transition table, lifted out and tested

**Files:**
- Create: `apps/api/src/orders/transitions.ts`
- Create: `apps/api/src/orders/transitions.spec.ts`
- Modify: `apps/api/src/orders/orders.service.ts:22-30` (remove the two consts, import them instead)
- Modify: `apps/api/src/orders/orders.controller.ts:44-46` (widen the zod enum)

**Interfaces:**
- Consumes: `OrderStatus` with `accepted` (Task 1).
- Produces:
  - `OPEN_STATUSES: OrderStatus[]`
  - `ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]>`
  - `canTransition(from: OrderStatus, to: OrderStatus): boolean`
  - `ORDER_STATUSES: readonly [string, ...string[]]` — the zod-friendly tuple of every status.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/orders/transitions.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { OrderStatus } from "@prisma/client";
import {
  ALLOWED_TRANSITIONS,
  OPEN_STATUSES,
  ORDER_STATUSES,
  canTransition,
} from "./transitions";

/** Declaration order, which is also the order Postgres sorts the enum in. */
const FLOW: OrderStatus[] = ["placed", "accepted", "preparing", "ready", "completed"];

describe("order transitions", () => {
  it("lets every stage move to the one after it", () => {
    for (let i = 0; i < FLOW.length - 1; i++) {
      expect(canTransition(FLOW[i]!, FLOW[i + 1]!)).toBe(true);
    }
  });

  it("allows skipping forward, because a rush should not be four forced taps", () => {
    expect(canTransition("placed", "ready")).toBe(true);
    expect(canTransition("placed", "completed")).toBe(true);
    expect(canTransition("accepted", "ready")).toBe(true);
  });

  it("refuses every backward move", () => {
    for (let i = 0; i < FLOW.length; i++) {
      for (let j = 0; j < i; j++) {
        expect(canTransition(FLOW[i]!, FLOW[j]!)).toBe(false);
      }
    }
  });

  it("refuses to reopen a finished order", () => {
    expect(ALLOWED_TRANSITIONS.completed).toEqual([]);
    expect(ALLOWED_TRANSITIONS.cancelled).toEqual([]);
  });

  it("lets anything unfinished be cancelled", () => {
    for (const status of OPEN_STATUSES) {
      expect(canTransition(status, "cancelled")).toBe(true);
    }
  });

  it("counts accepted as open, so the order stays on the board", () => {
    expect(OPEN_STATUSES).toEqual(["placed", "accepted", "preparing", "ready"]);
  });

  it("never lets a status move to itself", () => {
    for (const status of ORDER_STATUSES) {
      expect(canTransition(status as OrderStatus, status as OrderStatus)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/api && pnpm vitest run src/orders/transitions.spec.ts`
Expected: FAIL — `Cannot find module './transitions'`.

- [ ] **Step 3: Write the module**

Create `apps/api/src/orders/transitions.ts`:

```ts
import type { OrderStatus } from "@prisma/client";

/**
 * The order state machine, in one place.
 *
 * Lifted out of the service so it can be asserted directly. The rules are
 * short enough to look obvious and subtle enough to get wrong — "can a ready
 * order go back to preparing" has a right answer, and it is the kind of thing
 * a refactor quietly changes.
 */

/** Every value of the enum, in declaration order. */
export const ORDER_STATUSES = [
  "placed",
  "accepted",
  "preparing",
  "ready",
  "completed",
  "cancelled",
] as const satisfies readonly OrderStatus[];

/**
 * What counts as an order still in play.
 *
 * WARNING: this list is written out by hand in four other places, all of them
 * SQL — the `orders_one_open_per_table` unique index, `place_table_round`'s
 * lookup of the order to append to, and `get_table_order`'s WHERE clause.
 * Adding a status here without adding it there does not fail loudly: the
 * index silently stops constraining accepted orders, and a table ends up with
 * two open orders and two bills. See the 20260927110000_order_events
 * migration.
 */
export const OPEN_STATUSES: OrderStatus[] = [
  "placed",
  "accepted",
  "preparing",
  "ready",
];

/**
 * What a diner is allowed to move an order to: nothing. Staff only.
 *
 * Forward skips are deliberate. The board only ever offers the next step, but
 * a kitchen mid-rush that taps Ready on something still marked New should not
 * be told to tap three more times first.
 */
export const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  placed: ["accepted", "preparing", "ready", "completed", "cancelled"],
  accepted: ["preparing", "ready", "completed", "cancelled"],
  preparing: ["ready", "completed", "cancelled"],
  ready: ["completed", "cancelled"],
  // A finished order stays finished. Reopening one would put two open orders
  // on a table that has since seated new diners.
  completed: [],
  cancelled: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `cd apps/api && pnpm vitest run src/orders/transitions.spec.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Wire it into the service**

In `apps/api/src/orders/orders.service.ts`, delete the local `ALLOWED_TRANSITIONS` and `OPEN_STATUSES` consts (lines 21-30) and add to the imports:

```ts
import { ALLOWED_TRANSITIONS, OPEN_STATUSES } from "./transitions";
```

- [ ] **Step 6: Widen the controller's zod enum**

In `apps/api/src/orders/orders.controller.ts`, replace the hard-coded list:

```ts
import { ORDER_STATUSES } from "./transitions";

const statusSchema = z.object({
  status: z.enum(ORDER_STATUSES),
});
```

- [ ] **Step 7: Typecheck and run the whole suite**

Run: `cd apps/api && pnpm lint && pnpm test`
Expected: both PASS. The `Property 'accepted' is missing` error from Task 1 is gone.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/orders/transitions.ts apps/api/src/orders/transitions.spec.ts apps/api/src/orders/orders.service.ts apps/api/src/orders/orders.controller.ts
git commit -m "feat(api): let staff accept an order before starting it"
```

---

### Task 3: The event log — table, trigger, functions, backfill

**Files:**
- Create: `apps/api/prisma/migrations/20260927110000_order_events/migration.sql`
- Modify: `apps/api/prisma/schema.prisma` (add `OrderEvent`, add the relation to `Order` and `Business`)

**Interfaces:**
- Consumes: the `accepted` enum value (Task 1).
- Produces:
  - table `order_events (id bigserial, order_id uuid, business_id uuid, kind text, data jsonb, at timestamptz)`
  - `get_table_order(uuid)` jsonb gains an `events` array: `[{ id, kind, at, data }]`
  - Prisma model `OrderEvent` with fields `id: BigInt`, `orderId`, `businessId`, `kind: String`, `data: Json`, `at: DateTime`

- [ ] **Step 1: Write the migration**

Create `apps/api/prisma/migrations/20260927110000_order_events/migration.sql`:

```sql
-- The order timeline.
--
-- Everything here names 'accepted' as a literal, which is why it cannot share
-- a transaction with the ALTER TYPE that added it — see the previous folder.

-- ── The log ──────────────────────────────────────────────────────────────

CREATE TABLE order_events (
  -- bigserial, and reads order by it rather than by `at`. Accepting an order
  -- and starting it 200ms apart must render in the order they happened, which
  -- a timestamp comparison does not guarantee and insertion order does.
  id          bigserial PRIMARY KEY,
  order_id    uuid NOT NULL REFERENCES orders(id)     ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  -- text, not OrderStatus. Half the kinds are not statuses — 'round_added'
  -- today, a bill or a rating next — and an enum would mean a migration per
  -- new kind for a column nothing joins on.
  kind        text NOT NULL,
  -- { batch, items: [{ name, quantity }] } for the kinds that carry a round.
  -- Empty for status changes, which say everything in `kind` and `at`.
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  at          timestamptz(6) NOT NULL DEFAULT now()
);

-- The only read either screen does: one order, oldest first.
CREATE INDEX order_events_order_id_id_idx ON order_events (order_id, id);

ALTER TABLE order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_events FORCE  ROW LEVEL SECURITY;

-- Owners only. Diners reach their own events through get_table_order, which
-- is SECURITY DEFINER, so there is no diner-facing policy here to get wrong.
CREATE POLICY order_events_owner ON order_events
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()))
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()));

GRANT SELECT, INSERT ON order_events TO menu_app;
GRANT USAGE, SELECT ON SEQUENCE order_events_id_seq TO menu_app;

-- ── Status changes are logged by the database itself ─────────────────────

-- A trigger rather than an insert next to every UPDATE.
--
-- Order *creation* has exactly one writer, so place_table_round logs that
-- itself — it is also the only thing that knows the round's contents. Order
-- *status* is written by OrdersService.setStatus today and by whatever
-- admin tooling or bulk close-out exists later. A caller that forgets to log
-- produces a timeline that is wrong rather than absent, and nothing fails.
CREATE OR REPLACE FUNCTION log_order_status_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO order_events (order_id, business_id, kind)
  VALUES (NEW.id, NEW.business_id, NEW.status::text);
  RETURN NULL;
END;
$$;

CREATE TRIGGER orders_log_status
  AFTER UPDATE OF status ON orders
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION log_order_status_event();

-- ── The open-order invariant has to learn about 'accepted' ───────────────

-- Without this the index stops constraining an order the moment staff accept
-- it: 'accepted' falls outside the WHERE clause, the partial index no longer
-- covers the row, and a diner placing a second round gets a brand-new order
-- that nothing refuses. The table then has two open orders and two bills —
-- the exact state this index exists to prevent.
DROP INDEX orders_one_open_per_table;

CREATE UNIQUE INDEX orders_one_open_per_table
  ON orders (table_id)
  WHERE status IN ('placed', 'accepted', 'preparing', 'ready');

-- ── place_table_round: find accepted orders, and log the round ───────────

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
  v_batch       int;
  v_day         date := CURRENT_DATE;
  v_daily       int;
  v_line        jsonb;
  v_item        record;
  v_variant     record;
  v_price       numeric(10,2);
  v_variant_name text;
  v_quantity    int;
  v_active      bool;
BEGIN
  IF jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Add something to the order first' USING ERRCODE = 'check_violation';
  END IF;

  SELECT is_active INTO v_active
  FROM tables WHERE id = p_table_id AND business_id = p_business_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That table no longer exists' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT v_active THEN
    RAISE EXCEPTION 'This table is no longer taking orders' USING ERRCODE = 'check_violation';
  END IF;

  -- Serialise rounds for this table only. Other tables are unaffected.
  PERFORM pg_advisory_xact_lock(hashtext(p_table_id::text));

  -- 'accepted' belongs here for the same reason it belongs in the index
  -- above: without it, a second round at an accepted table starts a second
  -- order instead of appending to the one the kitchen is already working on.
  SELECT id INTO v_order_id
  FROM orders
  WHERE table_id = p_table_id
    AND status IN ('placed','accepted','preparing','ready');

  IF FOUND THEN
    SELECT COALESCE(MAX(batch), 0) + 1 INTO v_batch
    FROM order_items WHERE order_id = v_order_id;
  ELSE
    v_daily := next_daily_number(p_business_id, v_day);
    v_batch := 1;
    INSERT INTO orders (id, business_id, table_id, status, business_day, daily_number, placed_at, updated_at)
    VALUES (gen_random_uuid(), p_business_id, p_table_id, 'placed', v_day, v_daily, now(), now())
    RETURNING id INTO v_order_id;
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_quantity := (v_line->>'quantity')::int;
    IF v_quantity IS NULL OR v_quantity < 1 OR v_quantity > 99 THEN
      RAISE EXCEPTION 'Choose a quantity between 1 and 99' USING ERRCODE = 'check_violation';
    END IF;

    SELECT id, name, price INTO v_item
    FROM menu_items
    WHERE id = (v_line->>'itemId')::uuid
      AND business_id = p_business_id
      AND is_available;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'One of those dishes is no longer available'
        USING ERRCODE = 'check_violation';
    END IF;

    v_variant_name := NULL;

    IF v_line->>'variantId' IS NOT NULL THEN
      SELECT name, price INTO v_variant
      FROM menu_item_variants
      WHERE id = (v_line->>'variantId')::uuid AND item_id = v_item.id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'That size is no longer available' USING ERRCODE = 'check_violation';
      END IF;

      v_price := v_variant.price;
      v_variant_name := v_variant.name;
    ELSE
      IF v_item.price IS NULL THEN
        RAISE EXCEPTION 'Choose a size for %', v_item.name USING ERRCODE = 'check_violation';
      END IF;
      v_price := v_item.price;
    END IF;

    -- name, variant and price are copied in as they are right now. A price
    -- change later must not alter what this table is charged.
    INSERT INTO order_items
      (id, order_id, business_id, menu_item_id, name_snapshot, variant_snapshot,
       unit_price, quantity, batch, created_at)
    VALUES
      (gen_random_uuid(), v_order_id, p_business_id, v_item.id, v_item.name,
       v_variant_name, v_price, v_quantity, v_batch, now());
  END LOOP;

  -- Logged here rather than by a trigger because this is the only thing that
  -- knows what was in the round, and the timeline's whole job on a second
  -- round is to explain a total that grew.
  INSERT INTO order_events (order_id, business_id, kind, data)
  SELECT
    v_order_id,
    p_business_id,
    CASE WHEN v_batch = 1 THEN 'placed' ELSE 'round_added' END,
    jsonb_build_object(
      'batch', v_batch,
      'items', COALESCE(jsonb_agg(jsonb_build_object(
        -- The variant is what was actually ordered: a large dosa and a small
        -- one are different lines on a bill.
        'name', CASE WHEN i.variant_snapshot IS NULL
                     THEN i.name_snapshot
                     ELSE i.name_snapshot || ' (' || i.variant_snapshot || ')' END,
        'quantity', i.quantity
      ) ORDER BY i.created_at), '[]'::jsonb)
    )
  FROM order_items i
  WHERE i.order_id = v_order_id AND i.batch = v_batch;

  UPDATE orders SET updated_at = now() WHERE id = v_order_id;

  RETURN get_table_order(p_table_id);
END;
$$;

-- ── get_table_order: accepted orders are still the table's order ─────────

CREATE OR REPLACE FUNCTION get_table_order(p_table_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'id',          o.id,
    'status',      o.status,
    'dailyNumber', o.daily_number,
    'placedAt',    to_char(o.placed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'tableLabel',  t.label,
    'currency',    b.currency,
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id',       i.id,
               'name',     i.name_snapshot,
               'variant',  i.variant_snapshot,
               'unitPrice', i.unit_price::text,
               'quantity', i.quantity,
               'batch',    i.batch
             ) ORDER BY i.batch, i.created_at)
      FROM order_items i WHERE i.order_id = o.id
    ), '[]'::jsonb),
    -- Embedded rather than fetched separately. The diner's screen shows this
    -- timeline the whole time they are waiting, the database is ~400ms away,
    -- and their existing 5s poll and the Realtime ping already refetch this
    -- exact endpoint — so the timeline becomes live with no new plumbing.
    'events', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id',   e.id,
               'kind', e.kind,
               'at',   to_char(e.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
               'data', e.data
             ) ORDER BY e.id)
      FROM order_events e WHERE e.order_id = o.id
    ), '[]'::jsonb),
    'total', COALESCE((
      SELECT SUM(i.unit_price * i.quantity)::text
      FROM order_items i WHERE i.order_id = o.id
    ), '0')
  )
  FROM orders o
  JOIN tables t     ON t.id = o.table_id
  JOIN businesses b ON b.id = o.business_id
  WHERE o.table_id = p_table_id
    AND o.status IN ('placed', 'accepted', 'preparing', 'ready');
$$;

-- ── Backfill ─────────────────────────────────────────────────────────────

-- Synthesised from the columns that already hold the truth. An order that was
-- mid-service when this deployed gets a two-entry timeline, which is honest:
-- those intermediate timestamps were never recorded. It beats an empty panel.
--
-- Inserted in `at` order so the bigserial ids ascend with time rather than
-- with table scan order — reads sort by id.
INSERT INTO order_events (order_id, business_id, kind, at)
SELECT order_id, business_id, kind, at FROM (
  SELECT id AS order_id, business_id, 'placed' AS kind, placed_at AS at
  FROM orders
  UNION ALL
  SELECT id, business_id, status::text, completed_at
  FROM orders
  WHERE completed_at IS NOT NULL
    AND status IN ('completed', 'cancelled')
) seed
ORDER BY at, order_id;
```

- [ ] **Step 2: Add the Prisma model**

In `apps/api/prisma/schema.prisma`, after the `OrderItem` model:

```prisma
/// One thing that happened to an order, in the order it happened.
///
/// Written by two authors: `place_table_round` logs the round (it is the only
/// thing that knows its contents), and an AFTER UPDATE trigger on `orders`
/// logs every status change. Read by both screens and never updated.
model OrderEvent {
  id         BigInt   @id @default(autoincrement())
  orderId    String   @map("order_id") @db.Uuid
  businessId String   @map("business_id") @db.Uuid
  /// A status name, or "round_added". Text rather than the enum: most future
  /// kinds are not statuses.
  kind       String
  data       Json     @default("{}")
  at         DateTime @default(now()) @db.Timestamptz(6)

  order    Order    @relation(fields: [orderId], references: [id], onDelete: Cascade)
  business Business @relation(fields: [businessId], references: [id], onDelete: Cascade)

  @@index([orderId, id])
  @@map("order_events")
}
```

Add the back-relations — `events OrderEvent[]` to `model Order`, and `orderEvents OrderEvent[]` to `model Business`.

- [ ] **Step 3: Apply and regenerate**

Run: `cd apps/api && pnpm db:migrate && pnpm db:generate && pnpm lint`
Expected: migration applies, client regenerates, typecheck passes.

If `prisma migrate dev` reports drift because the SQL was written by hand, resolve with `pnpm prisma migrate resolve --applied 20260927110000_order_events` after confirming the SQL ran, or reset the dev database with `pnpm db:reset`.

- [ ] **Step 4: Prove the invariant holds — the test that matters most**

This is the check that catches the bug the spec is built around. Run against the dev database:

```bash
cd apps/api && psql "$DIRECT_URL" -v ON_ERROR_STOP=1 <<'SQL'
-- The index must now cover accepted orders. Inserting a second open order for
-- a table that already has an accepted one must be refused.
SELECT indexdef FROM pg_indexes WHERE indexname = 'orders_one_open_per_table';
SQL
```

Expected: the printed `indexdef` contains `'accepted'`. If it does not, the migration did not run and everything downstream is unsafe.

- [ ] **Step 5: Prove the backfill produced rows**

```bash
cd apps/api && psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -c \
  "SELECT (SELECT count(*) FROM orders) AS orders,
          (SELECT count(*) FROM order_events WHERE kind = 'placed') AS placed_events;"
```

Expected: `placed_events` equals `orders`. Every order has exactly one `placed` event.

- [ ] **Step 6: Commit**

```bash
git add apps/api/prisma/migrations/20260927110000_order_events apps/api/prisma/schema.prisma
git commit -m "feat(api): keep a timestamped event log for every order"
```

---

### Task 4: The owner's events endpoint

**Files:**
- Modify: `apps/api/src/orders/orders.service.ts` (add `listEvents`, refetch events after `setStatus` is not needed — the client refetches)
- Modify: `apps/api/src/orders/orders.controller.ts` (add the route)

**Interfaces:**
- Consumes: `OrderEvent` from the Prisma client (Task 3); `businesses.assertOwns` (existing).
- Produces: `GET /businesses/:bid/orders/:id/events` returning `{ id: number; kind: string; at: string; data: unknown }[]`, oldest first.

- [ ] **Step 1: Add `listEvents` to the service**

In `apps/api/src/orders/orders.service.ts`, after `listForBusiness`:

```ts
/**
 * One order's timeline.
 *
 * A route of its own rather than a field on the board's response. The board
 * polls both scopes every five seconds; embedding six-ish rows per order in
 * both, forever, to fill a panel that is collapsed by default is a poor
 * trade. This is called when a card is expanded and after it advances.
 */
async listEvents(userId: string, businessId: string, orderId: string) {
  await this.businesses.assertOwns(userId, businessId);

  const order = await this.prisma.db.order.findFirst({
    where: { id: orderId, businessId },
    select: { id: true },
  });
  if (!order) throw new NotFoundException("Order not found");

  const events = await this.prisma.db.orderEvent.findMany({
    where: { orderId },
    // By id, not by `at`: two events in the same millisecond must still
    // render in the order they happened.
    orderBy: { id: "asc" },
  });

  // BigInt does not survive JSON.stringify, and the id is only ever a React
  // key on the way out.
  return events.map((e) => ({
    id: Number(e.id),
    kind: e.kind,
    at: e.at.toISOString(),
    data: e.data,
  }));
}
```

- [ ] **Step 2: Add the route**

In `apps/api/src/orders/orders.controller.ts`, inside `OrdersController`:

```ts
@Get(":id/events")
events(
  @CurrentUser() user: RequestUser,
  @Param("bid") bid: string,
  @Param("id") id: string,
) {
  return this.orders.listEvents(user.id, bid, id);
}
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/api && pnpm lint && pnpm test`
Expected: both PASS.

- [ ] **Step 4: Verify against a running API**

Start the API (`cd apps/api && pnpm dev`), then with an owner access token and a real order id:

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:4000/businesses/$BID/orders/$OID/events" | jq
```

Expected: a JSON array, oldest first, whose first element has `"kind": "placed"` and a `data.items` array.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/orders/orders.service.ts apps/api/src/orders/orders.controller.ts
git commit -m "feat(api): serve one order's timeline to its owner"
```

---

### Task 5: `buildTimeline` — the pure module the UI leans on

**Files:**
- Create: `apps/web/lib/order-timeline.ts`
- Create: `apps/web/lib/order-timeline.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type OrderStatus = "placed" | "accepted" | "preparing" | "ready" | "completed" | "cancelled"`
  - `interface OrderEvent { id: number; kind: string; at: string; data?: { batch?: number; items?: { name: string; quantity: number }[] } | null }`
  - `interface TimelineStep { key: string; kind: string; label: string; at: string | null; state: "done" | "current" | "upcoming"; sincePreviousMs: number | null; detail: string | null }`
  - `buildTimeline(events: OrderEvent[], options: { status: OrderStatus; showUpcoming: boolean }): TimelineStep[]`
  - `formatClock(iso: string, timeZone?: string): string`
  - `formatGap(ms: number): string`

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/order-timeline.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildTimeline,
  formatClock,
  formatGap,
  type OrderEvent,
} from "./order-timeline";

/** Events are built by hand so each test states exactly what happened. */
function event(id: number, kind: string, at: string, data?: OrderEvent["data"]): OrderEvent {
  return { id, kind, at, data: data ?? {} };
}

const PLACED = event(1, "placed", "2026-09-27T14:30:00Z", {
  batch: 1,
  items: [
    { name: "Masala Dosa", quantity: 2 },
    { name: "Filter Coffee", quantity: 1 },
  ],
});

describe("formatClock", () => {
  it("renders a 12-hour clock with a lowercase meridiem", () => {
    expect(formatClock("2026-09-27T14:32:00Z", "UTC")).toBe("2:32pm");
    expect(formatClock("2026-09-27T08:05:00Z", "UTC")).toBe("8:05am");
  });

  it("renders midnight and noon the way a person reads them", () => {
    expect(formatClock("2026-09-27T00:00:00Z", "UTC")).toBe("12:00am");
    expect(formatClock("2026-09-27T12:00:00Z", "UTC")).toBe("12:00pm");
  });
});

describe("formatGap", () => {
  it("does not round a real wait down to nothing", () => {
    expect(formatGap(0)).toBe("+<1m");
    expect(formatGap(45_000)).toBe("+<1m");
  });

  it("counts whole minutes", () => {
    expect(formatGap(2 * 60_000)).toBe("+2m");
    expect(formatGap(59 * 60_000)).toBe("+59m");
  });

  it("breaks an hour out rather than reading +64m", () => {
    expect(formatGap(64 * 60_000)).toBe("+1h 4m");
    expect(formatGap(120 * 60_000)).toBe("+2h");
  });
});

describe("buildTimeline", () => {
  it("marks the latest status current and the rest done", () => {
    const steps = buildTimeline(
      [
        PLACED,
        event(2, "accepted", "2026-09-27T14:32:00Z"),
        event(3, "preparing", "2026-09-27T14:34:00Z"),
      ],
      { status: "preparing", showUpcoming: false },
    );

    expect(steps.map((s) => [s.label, s.state])).toEqual([
      ["Placed", "done"],
      ["Accepted", "done"],
      ["Being made", "current"],
    ]);
  });

  it("names the round's size on the placed step", () => {
    const [placed] = buildTimeline([PLACED], { status: "placed", showUpcoming: false });
    expect(placed!.detail).toBe("3 items");
  });

  it("says 1 item, not 1 items", () => {
    const one = event(1, "placed", "2026-09-27T14:30:00Z", {
      batch: 1,
      items: [{ name: "Filter Coffee", quantity: 1 }],
    });
    const [placed] = buildTimeline([one], { status: "placed", showUpcoming: false });
    expect(placed!.detail).toBe("1 item");
  });

  it("shows what has not happened yet when asked", () => {
    const steps = buildTimeline(
      [PLACED, event(2, "accepted", "2026-09-27T14:32:00Z")],
      { status: "accepted", showUpcoming: true },
    );

    expect(steps.map((s) => [s.label, s.state])).toEqual([
      ["Placed", "done"],
      ["Accepted", "current"],
      ["Being made", "upcoming"],
      ["Ready", "upcoming"],
      ["Served", "upcoming"],
    ]);
    expect(steps.at(-1)!.at).toBeNull();
  });

  it("does not invent a stage the kitchen skipped", () => {
    // Staff tapped Ready on an order still marked New.
    const steps = buildTimeline(
      [PLACED, event(2, "ready", "2026-09-27T14:41:00Z")],
      { status: "ready", showUpcoming: true },
    );

    expect(steps.map((s) => s.label)).toEqual(["Placed", "Ready", "Served"]);
    expect(steps.map((s) => s.state)).toEqual(["done", "current", "upcoming"]);
  });

  it("promises nothing further once an order is cancelled", () => {
    const steps = buildTimeline(
      [PLACED, event(2, "cancelled", "2026-09-27T14:35:00Z")],
      { status: "cancelled", showUpcoming: true },
    );

    expect(steps.map((s) => [s.label, s.state])).toEqual([
      ["Placed", "done"],
      ["Cancelled", "current"],
    ]);
  });

  it("promises nothing further once an order is served", () => {
    const steps = buildTimeline(
      [PLACED, event(2, "completed", "2026-09-27T15:00:00Z")],
      { status: "completed", showUpcoming: true },
    );
    expect(steps.every((s) => s.state !== "upcoming")).toBe(true);
  });

  it("explains a total that grew, in the order it grew", () => {
    const steps = buildTimeline(
      [
        PLACED,
        event(2, "accepted", "2026-09-27T14:32:00Z"),
        event(3, "preparing", "2026-09-27T14:34:00Z"),
        event(4, "round_added", "2026-09-27T14:41:00Z", {
          batch: 2,
          items: [{ name: "Gulab Jamun", quantity: 2 }],
        }),
        event(5, "ready", "2026-09-27T14:49:00Z"),
      ],
      { status: "ready", showUpcoming: false },
    );

    expect(steps.map((s) => s.label)).toEqual([
      "Placed",
      "Accepted",
      "Being made",
      "Round 2 added",
      "Ready",
    ]);
    // A round is a fact, never the thing the order is waiting on.
    expect(steps[3]!.state).toBe("done");
    expect(steps[3]!.detail).toBe("2 items");
    expect(steps[4]!.state).toBe("current");
  });

  it("renders a backfilled order rather than crashing on its gaps", () => {
    // Orders that predate the event log have only these two rows, and the
    // placed event carries no items at all.
    const steps = buildTimeline(
      [
        event(1, "placed", "2026-09-27T14:30:00Z"),
        event(2, "completed", "2026-09-27T15:02:00Z"),
      ],
      { status: "completed", showUpcoming: true },
    );

    expect(steps.map((s) => s.label)).toEqual(["Placed", "Served"]);
    expect(steps[0]!.detail).toBeNull();
    expect(steps[1]!.sincePreviousMs).toBe(32 * 60_000);
  });

  it("measures each gap from the step before it", () => {
    const steps = buildTimeline(
      [
        PLACED,
        event(2, "accepted", "2026-09-27T14:32:00Z"),
        event(3, "preparing", "2026-09-27T14:34:00Z"),
      ],
      { status: "preparing", showUpcoming: false },
    );

    expect(steps.map((s) => s.sincePreviousMs)).toEqual([null, 2 * 60_000, 2 * 60_000]);
  });

  it("survives an empty log", () => {
    expect(buildTimeline([], { status: "placed", showUpcoming: false })).toEqual([]);
  });

  it("ignores a kind it has never heard of", () => {
    // A future event kind must not break a diner's screen mid-meal.
    const steps = buildTimeline(
      [PLACED, event(2, "bill_generated", "2026-09-27T15:00:00Z")],
      { status: "placed", showUpcoming: false },
    );
    expect(steps.map((s) => s.label)).toEqual(["Placed"]);
  });

  it("reads the log in id order, not the order it arrived in", () => {
    const steps = buildTimeline(
      [event(2, "accepted", "2026-09-27T14:32:00Z"), PLACED],
      { status: "accepted", showUpcoming: false },
    );
    expect(steps.map((s) => s.label)).toEqual(["Placed", "Accepted"]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/web && pnpm vitest run lib/order-timeline.spec.ts`
Expected: FAIL — `Cannot find module './order-timeline'`.

- [ ] **Step 3: Write the module**

Create `apps/web/lib/order-timeline.ts`:

```ts
/**
 * Turning an order's event log into the steps a screen draws.
 *
 * Kept out of JSX deliberately. The interesting decisions here — which stage
 * is current, which never happened, how far apart two of them were — are the
 * kind that need a test each, and they are the same decisions on the diner's
 * phone and the owner's board.
 */

export type OrderStatus =
  | "placed"
  | "accepted"
  | "preparing"
  | "ready"
  | "completed"
  | "cancelled";

export interface OrderEvent {
  id: number;
  kind: string;
  /** ISO 8601, UTC. */
  at: string;
  data?: { batch?: number; items?: { name: string; quantity: number }[] } | null;
}

export interface TimelineStep {
  key: string;
  kind: string;
  label: string;
  /** ISO of when it happened; null for a stage still to come. */
  at: string | null;
  state: "done" | "current" | "upcoming";
  /** Milliseconds since the previous step that actually happened. */
  sincePreviousMs: number | null;
  /** "3 items" on a round, null on a bare status change. */
  detail: string | null;
}

/** The happy path, in the order Postgres sorts the enum. */
const FLOW: OrderStatus[] = ["placed", "accepted", "preparing", "ready", "completed"];

const LABELS: Record<OrderStatus, string> = {
  placed: "Placed",
  accepted: "Accepted",
  preparing: "Being made",
  ready: "Ready",
  completed: "Served",
  cancelled: "Cancelled",
};

function isStatus(kind: string): kind is OrderStatus {
  return kind in LABELS;
}

export function buildTimeline(
  events: OrderEvent[],
  options: { status: OrderStatus; showUpcoming: boolean },
): TimelineStep[] {
  // By id, not by `at`. Accepting an order and starting it 200ms apart must
  // render in the order they happened, and the server may hand these back in
  // any order a future query planner likes.
  const ordered = [...events].sort((a, b) => a.id - b.id);

  // Anything this version has never heard of is dropped rather than rendered
  // as a blank row. A future event kind must not break a diner's screen.
  const known = ordered.filter((e) => isStatus(e.kind) || e.kind === "round_added");

  const lastStatusId = known.reduce(
    (id, e) => (isStatus(e.kind) ? e.id : id),
    null as number | null,
  );

  const steps: TimelineStep[] = [];
  let previousAt: number | null = null;

  for (const e of known) {
    const at = new Date(e.at).getTime();
    const label = isStatus(e.kind)
      ? LABELS[e.kind]
      : `Round ${e.data?.batch ?? "?"} added`;

    steps.push({
      key: `e${e.id}`,
      kind: e.kind,
      label,
      at: e.at,
      // A round is a fact about the order, never the thing it is waiting on,
      // so only a status event is ever current.
      state: e.id === lastStatusId ? "current" : "done",
      sincePreviousMs: previousAt === null ? null : at - previousAt,
      detail: describeRound(e),
    });

    previousAt = at;
  }

  if (!options.showUpcoming) return steps;

  // Nothing further is coming for an order that is finished either way, and
  // showing "Ready" as pending under "Cancelled" would be a small lie.
  if (options.status === "completed" || options.status === "cancelled") return steps;

  // Only stages *after* the current one. A stage the kitchen skipped past is
  // in neither list, which is exactly right: it is not history and it is not
  // going to happen.
  const from = FLOW.indexOf(options.status);
  for (const stage of FLOW.slice(from + 1)) {
    steps.push({
      key: `u-${stage}`,
      kind: stage,
      label: LABELS[stage],
      at: null,
      state: "upcoming",
      sincePreviousMs: null,
      detail: null,
    });
  }

  return steps;
}

/** "3 items" — the size of a round, for the steps that carry one. */
function describeRound(e: OrderEvent): string | null {
  const items = e.data?.items;
  if (!items || items.length === 0) return null;
  const count = items.reduce((n, i) => n + i.quantity, 0);
  return count === 1 ? "1 item" : `${count} items`;
}

/**
 * "8:32pm".
 *
 * en-US rather than the visitor's locale: this is a 12-hour clock beside a
 * short label in a narrow column, and a locale that renders "20:32" or pads
 * the hour changes the column width under it. `timeZone` exists for tests —
 * in the browser it is omitted, which is the device's own zone, which is the
 * restaurant's.
 */
export function formatClock(iso: string, timeZone?: string): string {
  const text = new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  });
  return text.replace(/\s*([AP])M$/i, (_, meridiem: string) =>
    `${meridiem.toLowerCase()}m`,
  );
}

/**
 * "+2m" — how long the previous stage took.
 *
 * Rounds down to whole minutes but never to zero: a stage that took forty
 * seconds reads "+<1m", because "+0m" invites the reader to believe two
 * things happened at once.
 */
export function formatGap(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "+<1m";
  if (minutes < 60) return `+${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `+${hours}h` : `+${hours}h ${rest}m`;
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `cd apps/web && pnpm vitest run lib/order-timeline.spec.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/order-timeline.ts apps/web/lib/order-timeline.spec.ts
git commit -m "feat(web): turn an order's event log into timeline steps"
```

---

### Task 6: The timeline component

**Files:**
- Create: `apps/web/components/order/timeline.tsx`

**Interfaces:**
- Consumes: `TimelineStep`, `formatClock`, `formatGap` (Task 5).
- Produces: `<OrderTimeline steps={TimelineStep[]} tone="diner" | "staff" showGaps?={boolean} />`

- [ ] **Step 1: Write the component**

Create `apps/web/components/order/timeline.tsx`:

```tsx
import { formatClock, formatGap, type TimelineStep } from "@/lib/order-timeline";
import { cx } from "../ui";

/**
 * One order's history as a vertical rail.
 *
 * One component for both screens rather than two that look alike. The diner's
 * tree is themed per business through --menu-* variables and the owner's uses
 * the product's own achromatic tokens, so the difference is a palette, not a
 * layout — and two near-identical steppers drifting apart is the predictable
 * way this ends up inconsistent.
 */
const TONES = {
  diner: {
    ink: "text-[color:var(--menu-ink)]",
    muted: "text-[color:var(--menu-muted)]",
    rail: "bg-[color:var(--menu-line)]",
    dot: "bg-[color:var(--accent-strong)]",
    hollow: "border-[color:var(--menu-line)]",
  },
  staff: {
    ink: "text-ink",
    muted: "text-faint",
    rail: "bg-line",
    dot: "bg-[color:var(--accent)]",
    hollow: "border-line",
  },
} as const;

export function OrderTimeline({
  steps,
  tone,
  showGaps = false,
}: {
  steps: TimelineStep[];
  tone: keyof typeof TONES;
  /** How long the previous stage took. Useful to an owner, noise to a diner. */
  showGaps?: boolean;
}) {
  if (steps.length === 0) return null;
  const t = TONES[tone];

  return (
    <ol className="relative">
      {steps.map((step, i) => {
        const last = i === steps.length - 1;
        const upcoming = step.state === "upcoming";

        return (
          <li key={step.key} className="relative flex gap-3 pb-3.5 last:pb-0">
            {/* The rail is drawn per row rather than as one absolute line so
                it stops at the last dot instead of running past it. */}
            {!last && (
              <span
                aria-hidden
                className={cx("absolute left-[3.5px] top-3 h-full w-px", t.rail)}
              />
            )}

            <span
              aria-hidden
              className={cx(
                "relative mt-[5px] h-2 w-2 shrink-0 rounded-full",
                upcoming ? cx("border bg-transparent", t.hollow) : t.dot,
                // The current stage gets a halo rather than a bigger dot, so
                // the rail's spacing stays even down the column.
                step.state === "current" &&
                  "ring-4 ring-[color:currentColor] ring-opacity-10",
              )}
            />

            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span
                  className={cx(
                    "text-[13.5px]",
                    upcoming ? t.muted : t.ink,
                    step.state === "current" && "font-semibold",
                  )}
                >
                  {step.label}
                </span>

                {step.at && (
                  <time
                    dateTime={step.at}
                    className={cx("tnum text-[12.5px]", t.muted)}
                  >
                    {formatClock(step.at)}
                  </time>
                )}

                {showGaps && step.sincePreviousMs !== null && (
                  <span className={cx("tnum text-[12.5px]", t.muted)}>
                    {formatGap(step.sincePreviousMs)}
                  </span>
                )}
              </span>

              {step.detail && (
                <span className={cx("block text-[12.5px]", t.muted)}>
                  {step.detail}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && pnpm lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/order/timeline.tsx
git commit -m "feat(web): draw an order's timeline as a vertical rail"
```

---

### Task 7: The diner's screen

**Files:**
- Modify: `apps/web/components/order/ordering.tsx:16-47` (the `CurrentOrder` type and `STATUS_COPY`)
- Modify: `apps/web/components/order/ordering.tsx:430-500` (the order panel)

**Interfaces:**
- Consumes: `buildTimeline`, `OrderEvent` (Task 5); `OrderTimeline` (Task 6).
- Produces: nothing other tasks consume.

- [ ] **Step 1: Widen the order type**

In `apps/web/components/order/ordering.tsx`, change the `CurrentOrder` interface:

```ts
import { buildTimeline, type OrderEvent, type OrderStatus } from "@/lib/order-timeline";
import { OrderTimeline } from "./timeline";

interface CurrentOrder {
  id: string;
  status: OrderStatus;
  dailyNumber: number;
  placedAt: string;
  total: string;
  events: OrderEvent[];
  items: {
    id: string;
    name: string;
    variant: string | null;
    unitPrice: string;
    quantity: number;
    batch: number;
  }[];
}
```

- [ ] **Step 2: Rewrite the status copy**

`placed` no longer means "they have it" — `accepted` does:

```ts
const STATUS_COPY: Record<CurrentOrder["status"], { label: string; hint: string }> = {
  placed: { label: "Sent to the kitchen", hint: "Waiting for them to accept." },
  accepted: { label: "Accepted", hint: "They're on it." },
  preparing: { label: "Being made", hint: "Won't be long." },
  ready: { label: "Ready", hint: "On its way over." },
  completed: { label: "Served", hint: "Enjoy." },
  cancelled: { label: "Cancelled", hint: "Ask a member of staff." },
};
```

- [ ] **Step 3: Render the timeline under the status card**

In the order panel, immediately after the `<div className="rounded-2xl bg-[color:var(--accent-soft)] ...">` block that renders `status.label` and `status.hint`, insert:

```tsx
      {/* Always on, never behind a tap. This is the thing they are waiting
          on, and the whole point of the accept step is that a diner sees it
          happen. */}
      <div className="mt-4 px-1">
        <OrderTimeline
          steps={buildTimeline(order.events ?? [], {
            status: order.status,
            showUpcoming: true,
          })}
          tone="diner"
        />
      </div>
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/web && pnpm lint && pnpm test`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/order/ordering.tsx
git commit -m "feat(web): show the diner their order's timeline while they wait"
```

---

### Task 8: The owner's board

**Files:**
- Modify: `apps/web/app/(app)/orders/page.tsx`

**Interfaces:**
- Consumes: `buildTimeline`, `OrderEvent` (Task 5); `OrderTimeline` (Task 6); `GET /businesses/:bid/orders/:id/events` (Task 4).
- Produces: nothing other tasks consume.

- [ ] **Step 1: Add the status and the column**

```ts
import { buildTimeline, type OrderEvent, type OrderStatus } from "@/lib/order-timeline";
import { OrderTimeline } from "@/components/order/timeline";

type Status = OrderStatus;

const COLUMNS: { status: Status; title: string; next?: Status; nextLabel?: string }[] = [
  { status: "placed", title: "New", next: "accepted", nextLabel: "Accept" },
  { status: "accepted", title: "Accepted", next: "preparing", nextLabel: "Start" },
  { status: "preparing", title: "Being made", next: "ready", nextLabel: "Ready" },
  { status: "ready", title: "Ready", next: "completed", nextLabel: "Served" },
];
```

Delete the now-redundant local `type Status = "placed" | ...` union.

- [ ] **Step 2: Widen the board to four columns**

Change the grid class on the columns container:

```tsx
<div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
```

- [ ] **Step 3: Add the timeline to the card**

Add to `OrderCard`'s props and body. The header becomes a button; events load on first expand:

```tsx
function OrderCard({ /* …existing props… */, businessId }: { /* … */; businessId: string }) {
  const [openTimeline, setOpenTimeline] = useState(false);
  const [events, setEvents] = useState<OrderEvent[] | null>(null);

  // Fetched on expand rather than embedded in the board's response: this
  // screen polls two scopes every five seconds, and carrying six rows per
  // order in both — forever, for a panel that is usually shut — is a poor
  // trade. Refetched when the order advances so an open panel stays true.
  useEffect(() => {
    if (!openTimeline) return;
    let live = true;
    void api
      .get<OrderEvent[]>(`/businesses/${businessId}/orders/${order.id}/events`)
      .then((rows) => live && setEvents(rows))
      // Left null on failure: a timeline that will not load is worth less
      // than the card it is attached to, and the card still works.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [openTimeline, businessId, order.id, order.status]);
```

Replace the card's `<header>` with a toggle:

```tsx
      <header className="flex items-baseline justify-between gap-3">
        <button
          type="button"
          onClick={() => setOpenTimeline((o) => !o)}
          aria-expanded={openTimeline}
          className="flex min-w-0 flex-1 items-baseline justify-between gap-3 text-left"
        >
          <h3 className="font-display text-[16px] font-semibold">
            Table {order.table.label}
          </h3>
          <span className="tnum shrink-0 text-[13px] text-faint">
            #{order.dailyNumber} · {minutes === 0 ? "just now" : `${minutes}m`}
            <span aria-hidden className="ml-1.5">{openTimeline ? "▴" : "▾"}</span>
          </span>
        </button>
      </header>

      {openTimeline && (
        <div className="mt-3 border-t border-line pt-3">
          {events === null ? (
            <p className="text-[12.5px] text-faint">Loading…</p>
          ) : (
            <OrderTimeline
              steps={buildTimeline(events, {
                status: order.status,
                // Staff know what comes next — the button says so. What they
                // are reading for is how long each stage actually took.
                showUpcoming: false,
              })}
              tone="staff"
              showGaps
            />
          )}
        </div>
      )}
```

Pass `businessId={current.id}` where `OrderCard` is rendered.

- [ ] **Step 4: Let `Earlier today` rows expand too**

This is where the timeline earns the most — answering how long table six actually waited. In `ServedToday`, give each `<li>` the same toggle, using `buildTimeline(events, { status: order.status, showUpcoming: false })` with `tone="staff"` and `showGaps`.

- [ ] **Step 5: Check the segmented control at 360px**

Run `cd apps/web && pnpm dev`, open `/orders` at a 360px viewport, and confirm the four-option `Segmented` control does not clip its labels. If it does, shorten the phone labels to `New / Taken / Making / Ready` rather than changing the layout.

- [ ] **Step 6: Typecheck and test**

Run: `cd apps/web && pnpm lint && pnpm test`
Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add "apps/web/app/(app)/orders/page.tsx"
git commit -m "feat(web): accept orders on the board and show each one's timeline"
```

---

### Task 9: End-to-end, including the bug the index would have hidden

**Files:**
- Modify: `apps/web/e2e/ordering.spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Read the existing spec**

Run: `cat apps/web/e2e/ordering.spec.ts`
Understand how it seeds a business, resolves a table token, and reaches the board. The new assertions reuse that setup rather than building their own.

- [ ] **Step 2: Extend the happy path through Accept**

The existing flow taps Start → Ready → Served. It now taps **Accept** first. Add an assertion that the diner's screen shows the accepted state and a timeline entry:

```ts
await staff.getByRole("button", { name: "Accept" }).first().click();
await expect(diner.getByText("Accepted")).toBeVisible();
await expect(diner.getByText("Placed")).toBeVisible();
```

- [ ] **Step 3: Write the test that catches the two-open-orders bug**

```ts
test("a round added to an accepted order joins it rather than starting another", async ({ page, context }) => {
  // …existing seed + table-session setup…

  // Diner orders, staff accept, diner orders again.
  await placeRound(diner, ["Masala Dosa"]);
  await staff.getByRole("button", { name: "Accept" }).first().click();
  await placeRound(diner, ["Filter Coffee"]);

  // One card, not two. If `orders_one_open_per_table` or place_table_round
  // missed 'accepted', this is two cards and two bills.
  await expect(staff.getByRole("heading", { name: /^Table / })).toHaveCount(1);

  // And the second round is on the timeline.
  await staff.getByRole("button", { name: /^Table / }).click();
  await expect(staff.getByText("Round 2 added")).toBeVisible();
});
```

- [ ] **Step 4: Run the e2e suite**

Run: `cd apps/web && pnpm e2e`
Expected: PASS. A failure on the count assertion means Task 3's migration did not take — check the index definition before touching the test.

- [ ] **Step 5: Run everything**

```bash
cd apps/api && pnpm lint && pnpm test
cd ../web && pnpm lint && pnpm test
```
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/e2e/ordering.spec.ts
git commit -m "test(web): cover accepting an order and adding a round to it"
```
