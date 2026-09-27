# Running orders — design

**Date:** 2026-09-27
**Status:** approved, implementing

## What this is for

A table that has just been served and orders again is not a new table. They
are mid-meal, they are waiting on a pass that is already busy, and the gap
between their rounds is the whole of their experience of the place. On the
board today that second order is indistinguishable from a table that walked
in thirty seconds ago: same card, same column, sorted only by when it was
placed.

A **running order** names that table. When a table orders again shortly after
its previous order was served, the new order is flagged, sorted to the top of
its column, and announced to the owner as a return rather than as a new
arrival. Staff finish that table first.

Success: an owner glancing at the board can tell which tables are mid-meal
without remembering who they served five minutes ago; the flag can be turned
off per order when it is wrong; and an owner who does not want the behaviour
at all can set the window to their own service's rhythm or switch it off.

## What counts as running

> An order is a running order when the same table placed it within
> `runningOrderWindowMins` of that table's most recent **completed** order.

Three details, each a decision:

**Completed, not cancelled.** A cancelled order was never served. A table
whose order was cancelled and who orders again is retrying, not returning,
and flagging them would put a table that has eaten nothing at the top of the
queue ahead of tables that are actually waiting on a second round.

**Measured from `completed_at`, not from `placed_at`.** The window is meant
to capture "we served them and they came back", so it starts when the food
went out. Measuring from when the previous order was placed would make a slow
kitchen shorten its own window.

**Not constrained to a business day.** A table served at 11:52pm that orders
again at 12:05am is the same party. A `business_day` predicate would silently
stop flagging across midnight, which is exactly when a late-service venue
most wants it.

The flag is decided once, at the moment the order row is created, and then
stored. It is not recomputed on read. Two reasons: the board polls every five
seconds and recomputing a time-window predicate per order per poll is work
for nothing, and — more importantly — a stored flag is a fact about what was
true when the order arrived. An order that was running when it was placed
must not quietly stop being running because the owner later shortened the
window.

### Rounds do not make an order running

A second round appended to an order that is still open is **not** a running
order. That case is already visible: the card grows a "Round 2" heading, and
`place_table_round` appends to the existing order rather than creating one.
Flagging it would mean nearly every busy table is flagged, and a priority
signal that fires on everything is not a priority signal.

Running orders are specifically the *new order after the last one closed* —
the case the board currently has no way to show.

### Runs chain

Because the rule compares against the table's most recent completed order,
a table on its fourth round of the evening keeps being flagged as long as
each gap stays inside the window. Nothing tracks "the run" as an entity; the
chaining falls out of the rule, which is why there is no session table here.

## Where the decision is made

Inside `place_table_round`, on the branch that creates the order — not in the
API afterwards.

This is not a preference. The API's alternative is: call the function, get
the new order back, then issue a second statement to work out whether it was
a return and set the flag. That is a second round trip to a database ~400ms
away on the one path where a diner is watching a spinner, and it opens a
window where the order exists unflagged — long enough for the board's
five-second poll, the staff notification, and the realtime ping to all go out
describing it wrongly. Deciding it in the same transaction that writes the
row means the order is never observable in the wrong state.

The function reads the business's own settings, so the window is per-tenant
without the caller passing anything:

```sql
SELECT running_order_enabled, running_order_window_mins
  INTO v_running_enabled, v_window
  FROM businesses WHERE id = p_business_id;

IF v_running_enabled THEN
  SELECT true INTO v_is_running
    FROM orders
   WHERE table_id = p_table_id
     AND status = 'completed'
     AND completed_at IS NOT NULL
     AND completed_at > now() - make_interval(mins => v_window)
   LIMIT 1;
END IF;
```

`orders_table_id_status_idx` already exists, so this is an index scan on a
handful of rows.

## Schema

```sql
ALTER TABLE businesses
  ADD COLUMN running_order_enabled     boolean NOT NULL DEFAULT true,
  ADD COLUMN running_order_window_mins integer NOT NULL DEFAULT 45
    CHECK (running_order_window_mins BETWEEN 5 AND 180);

ALTER TABLE orders
  ADD COLUMN is_running boolean NOT NULL DEFAULT false;
```

**Default on, at 45 minutes.** A feature shipped off is a feature nobody
finds. Turning it on changes nothing destructive — it reorders cards within a
column and adds a badge — and 45 minutes is roughly a starters-then-mains gap
in an Indian casual-dining service. The bounds exist so the window cannot be
set to a value that makes the flag meaningless: below 5 minutes nothing ever
qualifies, above 180 everything does.

No backfill. Existing orders are `false`, which is honest: we do not know
what the owner would have wanted flagged last week, and inventing it would
put stale badges on the "Earlier today" list.

## The board

`listForBusiness` sorts `[isRunning desc, status asc, placedAt asc]`. Since
the board groups by status in the browser, the effect is that running orders
sit at the top of their column. The browser sorts the same way again after
grouping, because optimistic status moves reorder the array locally and a
card that was just started should not jump below a non-running one.

A flagged card gets an accent ring and a small **Running order** badge beside
the table name, plus one extra action in its footer: **Not running**, which
clears the flag. That is the whole of the owner override — per order, not per
table. An owner who unflags table 5's order is saying "this one is wrong",
not "never flag table 5 again", and a table-level mute would be a second
piece of state with its own lifetime and no obvious end.

Marking an order running by hand goes through the same endpoint — the body
carries a boolean either way — but only the clearing action is on screen. A
"make this running" button would need staff to decide what the word means,
and the whole point is that the system knows.

```
PATCH /businesses/:bid/orders/:id/running   { "running": false }
```

Allowed only while the order is open (`placed`, `preparing`, `ready`). A
served order's flag is history, and history is not editable — the same
reasoning that stops `setStatus` reopening a completed order.

## The notification

The owner is pushed a notification when an order is placed; a running order
says so in its title:

| case | title |
|---|---|
| first order from this table | `New order · Table 12` |
| a second round on an open order | `Added to Table 12` |
| a new order inside the window | `Ordered again · Table 12` |

The `kind` stays `order.placed`. Kinds drive nothing but grouping, and adding
`order.running` would mean every existing consumer needs a case for a thing
that renders identically.

For the copy to know, `place_table_round` merges `isRunning` into the payload
it returns. Deliberately *not* added to `get_table_order` itself: that
function is shared with the diner's own polling and is rewritten by other
migrations, so a field added there is both a collision waiting to happen and
a promise to the diner we have not made. Telling a diner they are a priority
sets an expectation the kitchen has not agreed to.

## Settings

The two fields join `businessUpdateSchema` and the Settings page rather than
getting their own endpoint, because they are attributes of the business and
the dashboard already holds the whole business row in session — which also
means the board can read the window without a second fetch.

The section is a toggle and a minutes field, the minutes field hidden when
the toggle is off, matching how Billing shows tax rate under the tax toggle.

The `Toggle` control moves from `billing/page.tsx` into `components/ui.tsx`.
It is the second caller; a third copy is how two switches end up behaving
differently.

## Testing

The SQL is not unit-testable here — this repo has no database-backed suite,
and `place_table_round` has none today either. What is testable is tested:

- `apps/web/lib/order-board.ts` — the sort. Running first, then placement
  order; a running order placed later still outranks an older ordinary one.
- `apps/api/src/notifications/events.spec.ts` — the third title, and that a
  round added to an open order never renders as "Ordered again" even when
  the order it lands on is flagged.

The rule itself is verified by hand against the running app: complete a
table's order, order again from that table's link, confirm the badge and the
position.

## What is deliberately not here

- **No per-table mute.** See above.
- **No auto-expiry of the flag.** A running order stays flagged until it is
  served. It was a return when it arrived; time passing does not change that.
- **No diner-facing signal.**
- **No separate "Running" column.** The board has three columns and a phone
  shows one at a time; a fourth would cost more than the badge earns.
