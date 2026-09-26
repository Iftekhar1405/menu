# Order acceptance and timeline — design

**Date:** 2026-09-27
**Status:** approved, implementing

## What this is for

An order today arrives on the board as "New" and the only thing a diner
learns is that it was sent. Nobody has told them a human has *seen* it. The
gap between tapping "Place order" and the kitchen starting work is the part
of a meal where a diner most wants reassurance, and right now the screen has
nothing to say.

Two changes close that gap:

1. **Staff accept an order** before they start making it — an explicit "we
   have this" that the diner's screen can show within a second.
2. **Every order keeps a timestamped timeline** — placed, accepted, being
   made, ready, served, plus rounds added mid-meal — shown to the diner
   while they wait and to the owner on demand.

Success: a diner who has just ordered sees "Accepted · 8:32pm" without
asking anyone; an owner looking at a served order can see exactly how long it
sat in each stage; and no existing order in the database renders as a blank
timeline.

## The state machine

`accepted` becomes a real status between `placed` and `preparing`:

```
placed  →  accepted  →  preparing  →  ready  →  completed
  New       Accepted    Being made    Ready     Served
                     ↘      ↓      ↙
                        cancelled
```

The board grows a fourth column and the diner's order tab grows a stage.
Forward skips stay legal exactly as they are today — `placed` may still jump
straight to `ready` or `completed` — because the board only ever offers the
next step, and a rush should not become four forced taps. Backward moves stay
blocked: a finished order stays finished, or a table that has since seated
new diners ends up with two open orders.

`ALLOWED_TRANSITIONS` in `apps/api/src/orders/orders.service.ts:22` becomes:

| from | may move to |
|---|---|
| `placed` | `accepted`, `preparing`, `ready`, `completed`, `cancelled` |
| `accepted` | `preparing`, `ready`, `completed`, `cancelled` |
| `preparing` | `ready`, `completed`, `cancelled` |
| `ready` | `completed`, `cancelled` |
| `completed`, `cancelled` | — |

### "Open" is spelled out in five places, and all five must change

This is the part of the change most likely to be shipped half-done. The set
of statuses that count as *open* is not defined anywhere central — it is
written out by hand five times, four of them in SQL:

| where | what it does | if it is missed |
|---|---|---|
| `orders_one_open_per_table` (unique index, `20260830083311_ordering:98`) | enforces one open order per table | **the invariant silently stops holding** |
| `place_table_round:60` | finds the order to append a round to | a round on an accepted order starts a *second* order |
| `get_table_order` (redefined in `20260927000000:177`) | the diner's whole view | the diner's order vanishes the moment staff accept it |
| `OPEN_STATUSES` (`orders.service.ts:30`) | the board's `?scope=open` | accepted orders disappear off the board |
| `ALLOWED_TRANSITIONS` | the state machine | accepting is rejected as an illegal move |

The first two deserve spelling out. Once an order moves to `accepted`, it
leaves the partial index's `WHERE` clause, so the index no longer constrains
it — and `place_table_round` no longer finds it either. The two failures
compound: a diner ordering a second round at an accepted table creates a
brand-new order, and nothing in the database refuses it. The table now has
two open orders, which is the exact state the index exists to prevent, and
`get_table_order`'s single-row `SELECT` starts returning one arbitrarily.

So the second migration drops and recreates the index, and replaces both
functions. All three name `'accepted'` as a literal, which is the reason the
`ALTER TYPE` cannot share their transaction.

A comment on the index and on `OPEN_STATUSES` points at this table, because
the next status anyone adds will hit the same five places.

### Where the enum value goes, and why it needs two migrations

The value is added **before** `preparing`:

```sql
ALTER TYPE "OrderStatus" ADD VALUE 'accepted' BEFORE 'preparing';
```

Position is load-bearing, not cosmetic. `listForBusiness` orders by
`[{ status: "asc" }, { placedAt: "asc" }]`, and Postgres sorts an enum by
declaration order. Appending `accepted` at the end would sort accepted orders
after cancelled ones.

Postgres will not let a new enum value be *used* in the same transaction that
added it, and Prisma runs each migration in a transaction. So this ships as
**two migration folders**:

- `..._order_accepted_status` — the `ALTER TYPE` alone, nothing else.
- `..._order_events` — everything that names `'accepted'` as a literal: the
  `order_events` table, the trigger, the backfill, the rebuilt
  `orders_one_open_per_table` index, and replacements for
  `place_table_round` and `get_table_order`. See the table below for why
  those last three are not optional.

Collapsing these into one folder fails at deploy time, not at review time,
which is the worst way to find out.

## The timeline: an event log

```sql
CREATE TABLE order_events (
  id          bigserial PRIMARY KEY,
  order_id    uuid NOT NULL REFERENCES orders(id)     ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  at          timestamptz(6) NOT NULL DEFAULT now()
);

CREATE INDEX order_events_order_id_id_idx ON order_events (order_id, id);
```

`kind` is `text`, not `OrderStatus`. Half the events are not statuses —
`round_added` is the obvious one — and a bill generated or a rating left are
the next things that will want a row here. An enum would mean a migration per
new kind, for a column nothing joins on.

**Ordered by `id`, never by `at`.** Accepting an order and starting it two
hundred milliseconds apart must render in the order they happened, and
`bigserial` guarantees that where a timestamp comparison does not.

`data` carries what the stage needs and nothing more — `{ batch, items: [{
name, quantity }] }` for `placed` and `round_added`, empty for the rest.

Isolation follows `notifications` exactly: RLS enabled and forced, one
`order_events_owner` policy keyed on `business_id`. Diners never read this
table directly — their events arrive inside `get_table_order`, which is
already `SECURITY DEFINER` — so no diner-facing policy exists to get wrong.

### Two writers, split by what they know

**`place_table_round` writes `placed` and `round_added`.** Only that function
knows the round's contents, and it is the only thing in the system that
creates an order. Batch 1 writes `placed`; batch 2 and up write
`round_added`.

**A trigger writes every status change.**

```sql
CREATE TRIGGER orders_log_status
  AFTER UPDATE OF status ON orders
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION log_order_status_event();
```

This is where the trigger earns its keep. Order *creation* has exactly one
writer; order *status* is written by `setStatus` today and by whatever admin
tooling or bulk close-out exists later. A trigger cannot be forgotten by a
future caller, and the alternative — an insert next to every
`order.update` — is missed silently, producing a timeline that is wrong
rather than absent.

### Backfilling what already exists

Orders already in the database get rows synthesised from the columns that
already hold the truth: `placed_at` for every order, and `completed_at` for
those that reached `completed` or `cancelled`. Inserted in `at` order so the
`bigserial` ids ascend with time rather than with table scan order.

An order that was mid-service when this deployed shows a two-entry timeline.
That is honest — those intermediate timestamps were never recorded — and it
beats an empty panel.

## Getting the timeline to each screen

The two audiences have opposite shapes, so they get opposite mechanisms.

**Diner — embedded in `get_table_order`.** One table, one order, timeline
always on screen. Adding an `events` array to the jsonb the function already
builds costs one correlated subquery on a query that already runs, and
crucially no second round trip on a connection that is ~400ms away. The
diner's existing 5s poll and the Realtime ping from `announceStatus` both
already refetch this exact endpoint, so the timeline becomes live with no new
plumbing at all.

**Owner — a separate `GET /businesses/:bid/orders/:id/events`.** The board
polls `?scope=open` *and* `?scope=today` every five seconds. Embedding events
would add roughly six rows per order to both responses, forever, to fill a
panel that is collapsed by default. The endpoint is called when a card is
expanded and again after that card's status changes; the poll payload stays
exactly the size it is today.

`listEvents(userId, businessId, orderId)` goes on `OrdersService` behind the
same `businesses.assertOwns` check every other staff read uses.

## UI

### Diner — always visible

The order tab's status pill becomes a vertical stepper: completed stages with
filled dots and clock times, the current stage emphasised, upcoming stages as
hollow dots with no time. It is the thing they are waiting on, so it does not
hide behind a tap.

```
┌────────────────────────┐
│  Being made            │
│  Won't be long.        │
│                        │
│  ●  Placed      8:30pm │
│  │     3 items         │
│  ●  Accepted    8:32pm │
│  │                     │
│  ●  Being made  8:34pm │
│  ○  Ready              │
│  ○  Served             │
└────────────────────────┘
```

Status copy gains a stage and `placed` is rewritten, because "They've got it"
is now the thing `accepted` says:

| status | label | hint |
|---|---|---|
| `placed` | Sent to the kitchen | Waiting for them to accept. |
| `accepted` | Accepted | They're on it. |
| `preparing` | Being made | Won't be long. |
| `ready` | Ready | On its way over. |
| `completed` | Served | Enjoy. |
| `cancelled` | Cancelled | Ask a member of staff. |

A `round_added` event renders inline between stages — "Round 2 added ·
8:41pm" — so the timeline explains a total that grew.

### Owner — on tap

Cards stay the size they are. The card header becomes a button
(`aria-expanded`) that reveals the timeline inline; `Earlier today` rows
expand the same way, which is the case where this is most useful — answering
how long table six actually waited. Events load on first expand and
re-fetch after that card advances.

Staff see history only, no upcoming stages: the button already says what is
next. Each entry shows the clock time and the gap from the previous stage
(`Accepted 8:32pm · +2m`), which is the number an owner is actually reading
for.

### One component, two tones

`apps/web/components/order/timeline.tsx` serves both. The diner tree is
themed per business with `--menu-*` CSS variables; the app shell uses
`--accent` and the `text-muted` / `text-faint` tokens. The component takes a
`tone: "diner" | "staff"` prop selecting the token set, and `showUpcoming` to
turn the future stages on and off. Two near-identical steppers drifting apart
is the predictable failure here, and it is the same reasoning that put all
notification copy in `events.ts`.

The ordering of events into rendered steps — merging the log with the
upcoming stages, computing gaps, deciding which stage is current, hiding
`preparing` on an order that skipped it — is a pure function in
`apps/web/lib/order-timeline.ts`, not logic inside JSX.

## Testing

The repo's API specs are pure-function tests with no database, and this
follows that:

- `apps/web/lib/order-timeline.spec.ts` — the real logic. A normal order; one
  that skipped `preparing`; a cancelled order; an order with two rounds; a
  backfilled order with only two events; gap arithmetic across an hour
  boundary.
- `apps/api/src/orders/transitions.spec.ts` — the transition table lifted out
  of the service into a pure module so it can be asserted directly: every
  forward move legal, every backward move rejected, terminal states closed.
- `apps/web/e2e/ordering.spec.ts` — extended so the existing happy path taps
  Accept before Start, which is what proves the fourth column is reachable.
- `apps/web/e2e/ordering.spec.ts` — **and a round added to an accepted
  order.** Accept, then place a second round from the diner tab, then assert
  the board still shows one card for that table with both rounds on it. This
  is the only test that catches the index and `place_table_round` being
  missed; every unit test above passes with that bug present.

`pnpm lint` (`tsc --noEmit`) in both apps is the check that the widened
status union reached every switch and `Record<Status, …>` in the codebase —
there are four of them, and TypeScript finds them all.

## Risks

**Four columns on a 360px phone.** The board's `Segmented` control currently
shows three options with counts. A fourth may not fit without truncating.
Mitigated by verifying at 360px during implementation; the fallback is
shortening the labels ("New / Taken / Making / Ready") rather than changing
the layout.

**A two-migration sequence deployed out of order** breaks the second
migration. Prisma applies folders in name order, so the names must sort
correctly — the `ALTER TYPE` folder gets the earlier timestamp.

## Not doing

- Who accepted it. One owner per business today (`Business.ownerId`), so
  there is no second person for an attribution column to distinguish.
- Auto-accept after a timeout. An order nobody accepted is information the
  owner should see, not something to paper over.
- Diner push on acceptance. The diner screen already refetches on the
  Realtime ping and on a 5s poll; a notification permission prompt on a
  stranger's phone mid-meal is a worse trade.
- Exposing the event log as a general audit API. It is two reads with two
  shapes; a generic endpoint is speculative.
