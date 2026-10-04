# Round-level orders, and KOT printing

Date: 2026-10-04
Branch: `feat/kot-printing`

## The problem

Two problems, and the second cannot be solved without the first.

**Paper.** There is no printing in this system. A counter accepts an order on
the board and the kitchen learns about it by looking at a screen. Every
restaurant this is sold into expects a token slip in the customer's hand and
a ticket on the pass, and a bill off the till when the table is closed.

**Rounds.** A round added to an open order drags the whole order backwards.
`place_table_round` ends with `UPDATE orders SET status = 'placed'`
(`20260928000000_order_round_fixes/migration.sql:74`), so a table whose
biryani is already `ready` is thrown back to `placed` because someone asked
for a chai. The board lies about what the kitchen is doing, and any ticket
printed off that status would lie with it.

This spec fixes the second and then builds the first on top. They are one
piece of work because "print the newly placed items" has no meaning until a
round is a thing that can be accepted on its own.

## What was decided

| Question | Answer |
|---|---|
| How does paper come out? | A browser tab on the shop machine, driving the printer directly over WebUSB / Web Serial as raw ESC/POS |
| How does the page find a printer? | Chrome's device chooser, once; the grant persists and the page re-finds it by `vendorId:productId:serial` |
| What prints on accept? | Counter: a customer token slip. Kitchen: the working item ticket. Different tickets, same token number |
| What prints on close? | The bill, at the counter |
| One device or two? | Both, with no mode flag — see "The configuration is the station list" |
| What number does the customer hold? | `Order.dailyNumber`, the number staff already call out |
| Extra rounds? | A round is a new order for printing: accept it, its own KOT prints, showing only its own items |
| Where does "has this printed?" live? | A `print_receipts` row per station per event, unique-indexed. The insert is the claim |

Rejected, with reasons, in "Roads not taken".

## Part 1 — a round becomes a thing

### Data model

```
order_rounds
  id            uuid pk
  business_id   uuid                  -- carried for RLS, as every table here does
  order_id      uuid -> orders
  seq           int                   -- 1-based, migrated from order_items.batch
  business_day  date                  -- denormalised from orders, so the KOT
                                      -- serial is unique without a join
  kot_number    int                   -- per business per business day
  status        OrderStatus           -- the existing enum, now at this level
  placed_at     timestamptz
  accepted_at   timestamptz null
  completed_at  timestamptz null
  unique (order_id, seq)
  unique (business_id, business_day, kot_number)
  index  (business_id, status)
```

`order_items.batch` becomes `order_items.round_id`. The migration creates one
`order_rounds` row per distinct `(order_id, batch)`, carries `batch` across as
`seq` so nothing renumbers, backfills `round_id`, then drops `batch`.
`kot_number` is backfilled per business-day in `(business_day, order_id, seq)`
order, so historical rounds get stable numbers rather than nulls.

`order_events` gains a nullable `round_id`.

### `orders.status` stays, and stops being written by hand

An `AFTER INSERT OR UPDATE` trigger on `order_rounds` derives it:

- `cancelled` when every round is cancelled
- `completed` when every round is terminal and at least one completed
- otherwise **the least advanced live round**, by the lifecycle order
  `placed < accepted < preparing < ready`

An order with round 1 `ready` and round 2 `placed` is a `placed` order.

Deriving rather than removing is the load-bearing choice. `orders.status` is
read by the `orders_one_open_per_table` partial unique index, by
`get_table_order`, by the board's `status: { in: OPEN_STATUSES }` query and by
the kitchen RLS policies. Keeping the column correct keeps all four working
untouched. Removing it would mean rewriting them, including the index that is
the only thing stopping a table from getting two bills.

The hazard that comes with this is the one `transitions.ts` already warns
about: `OPEN_STATUSES` is written out by hand in SQL in several places. The
derivation function is a fifth copy of that list and must be listed in the
same warning comment.

### Writers

`place_table_round` stops touching `orders.status`. It inserts an
`order_rounds` row at `placed`, allocates `kot_number` under the advisory lock
it already takes, and attaches the new items to it. **Rounds already in
flight are never touched.** That is the bug, fixed at its source.

Status changes are logged by **two** triggers, not one moved:

- a new trigger on `order_rounds` writes `round.accepted`, `round.preparing`,
  `round.ready`, `round.completed`, `round.cancelled`, with `round_id` set
- the existing trigger on `orders` is kept, writing `order.completed` and
  `order.cancelled` with `round_id` null

Part 2 needs both: tickets hang off a round event, the bill off an order event.

### Roles and transitions

`ALLOWED_TRANSITIONS` and `ROLE_TARGETS` in `packages/shared/src/roles.ts`
keep their shape and their signatures; the thing they describe becomes a
round. Kitchen still gets `accepted / preparing / ready` and still cannot
reach `completed` or `cancelled`, for the reasons already written there.

Nobody closes an order directly any more. "Close table" on the board means
"complete every live round of this order", one call, one transaction, and the
derivation trigger flips the order. Cancellation windows
(`CANCELLABLE_STATUSES`) are evaluated per round, so a diner may still cancel
a chai that has not been started while the biryani is being made.

### The board

Each order card lists its rounds. Round 1 can show Ready while round 2 shows
New, each with its own buttons drawn from the same role table. An order
appears in the column of its least advanced live round, which is what the
derived status already says.

## Part 2 — printing

### The configuration is the station list

```
print_stations                     -- one machine
  id, business_id, name
  last_seen_at  timestamptz null
  revoked_at    timestamptz null

station_outputs                    -- one linked printer, for one job
  id, business_id, station_id
  job           'token' | 'kitchen' | 'bill'
  device_label  text               -- what Chrome reported, for the settings list
  device_key    text               -- vendorId:productId:serial
  transport     'usb' | 'serial'
  paper_width   58 | 80
  unique (station_id, job)

print_receipts
  id bigserial, business_id, station_id
  event_id  bigint -> order_events
  job       'token' | 'kitchen' | 'bill'
  attempt   int default 1
  status    'claimed' | 'printed' | 'failed'
  claimed_at, printed_at, error
  unique (station_id, event_id, job, attempt)
```

**The USB handle is not stored.** A WebUSB grant lives in the browser, per
origin, and cannot be serialised. The server stores `device_key` only; the
station page matches it against `navigator.usb.getDevices()` to re-find the
printer after a reload.

**One output per job per station** is what makes both deployment modes fall
out of the same data with no mode flag anywhere:

- **Two devices.** Counter holds `token` and `bill`; kitchen holds `kitchen`.
  One accept emits one event, each station finds one job of its own against
  it, both print at the same moment. Only the counter owns `bill`, so only
  the counter prints bills.
- **One device.** A single station holds all three. The same event yields it
  two jobs — token slip and kitchen ticket, back to back off the one machine.
  Pointing `token` and `bill` at the same `device_key` simply means one roll
  does both.

Nothing branches on "how many devices". The count of stations *is* the
configuration.

### Which event produces which job

One pure function in `packages/shared`, beside the role table, for the same
reason that one lives there: the station page needs it to decide what to
render and the API needs it to decide what to hand out.

| event | job | printed by |
|---|---|---|
| `round.accepted` | `token` | stations with a `token` output |
| `round.accepted` | `kitchen` | stations with a `kitchen` output |
| `order.completed` | `bill` | stations with a `bill` output |

Nothing fires on `preparing`, `ready` or `cancelled`. A void slip for a
cancelled round that the kitchen already holds is a real feature and a
deliberate omission — see "Not built".

**The bill is produced by the job, not by a button.** `generate_bill` already
returns the existing bill rather than recomputing, so the endpoint serving a
`bill` job calls it first. Closing the table becomes what produces a bill; the
existing button becomes a reprint.

### Becoming a station, and linking a printer

`/(app)/station` is the page that stays open on the shop machine.
`/(app)/settings/printing` is the owner's view of every station: last seen,
which printer is on which job, rename, test print, revoke.

Setup is: open `/station` as any staff user, press "Set up this machine", name
it. That writes a `print_stations` row and keeps its id in `localStorage`.
There is no pairing code and no new auth path — the page sits behind the
session that already exists, and every station endpoint goes through
`assertAccess(owner | kitchen)` plus a check that the station belongs to that
business. Revoking sets `revoked_at`, after which the id stops resolving.

"Link a printer" calls `navigator.usb.requestDevice({ filters: [{ classCode: 7 }] })`,
or `navigator.serial.requestPort()` for printers in virtual-COM mode. Chrome
shows the printers actually connected to that machine; the user picks one, its
job and its paper width. On later loads `navigator.usb.getDevices()` returns
the already-granted devices with no prompt and the page matches by
`device_key`. A linked printer absent from that list renders as **Not
connected**, on the station screen and in the owner's list. That is as close
to an OS-level connected check as a browser can give.

### The loop

The station subscribes to the business's existing Realtime topic (the
HMAC-derived name from `channel-name.ts`) and also polls every 10 seconds,
because the ping is an optimisation over polling and is allowed to be lost.
On either trigger:

1. `GET /businesses/:bid/stations/:sid/pending` — events with no receipt of
   mine, mapped through the job table. No side effects, so two tabs may both
   ask. Refreshes `last_seen_at`.
2. `POST .../receipts { eventId, job }` — **the insert is the claim.** A
   second tab racing for the same token gets `409` off the unique index and
   skips. This is the only thing standing between the shop and double-printed
   tokens, and it is a database constraint rather than application code, for
   the same reason `orders_one_open_per_table` is.
3. Render to ESC/POS, write to the device, then
   `POST .../receipts/:id/result` with `printed` or `failed` and the error.

**`pending` only looks back 30 minutes.** A station switched off all day and
opened at closing time must not emit two hundred tickets. Anything older is
listed on the station screen as **Missed**, with a Print button, and stays a
human decision.

### Rendering

The encoder is a pure function in `packages/shared`: ticket DTO to
`Uint8Array`. No DOM, no device, no browser, so it is unit-testable with the
vitest setup already present. The station page's only job is to write the
bytes it is handed. Width is a property of the output, not the ticket: 48
columns at 80mm, 32 at 58mm, and the encoder lays out against whichever it is
given.

**Token slip** — business name, the token (`Order.dailyNumber`) double-width
and double-height via `GS ! 0x11`, `Round N` beneath it when `seq > 1`, table
label, time. No dishes, no prices.

**Kitchen ticket** — the same token so the two slips match, the table, the
KOT number, a `*** ROUND N — NEW ITEMS ***` banner when `seq > 1`, a
`** RUNNING TABLE **` line when `isRunning` (free: the order already carries
that flag), then **this round's lines only** — quantity, name, variant, note —
in double-height text, because this is read at arm's length over a pass. No
prices.

**Bill slip** — the content `receipt.pdf.ts` already produces, re-emitted as
ESC/POS from the existing `Bill` DTO rather than reimplemented: header, lines,
per-line snapshot tax rates, service charge with its "voluntary, ask us to
remove it" sentence when enabled, round-off, total, `receiptFooter`, and the
same "this is a receipt, not a GST tax invoice" line the screen and the PDF
both carry. `Token N` is printed on it, tying the paper back to the slip in
the customer's hand.

Approved sample output is in
`docs/superpowers/specs/2026-10-04-kot-printing-samples.md`.

**Limitation: ESC/POS text mode is a single-byte codepage** (CP437 / CP1252,
Latin). A business whose name or dish names are in Devanagari, Tamil or
Bengali cannot be printed as text; those bytes come out as garbage. The
encoder transliterates what it can and drops what it cannot, and the printing
settings page warns when a linked printer's business or menu contains
characters it cannot render. Rasterising those lines as a bitmap is the real
fix and is a named follow-up, not part of this.

Cash-drawer kick and the buzzer most KOT printers carry are each one ESC/POS
command away and are out of scope.

### Bills merge identical lines across rounds

`generate_bill` loops `order_items` one row at a time ordered by batch
(`20260830085723_billing/migration.sql:235`), so one biryani in round 1 and
two in round 2 print as two lines. A customer who ordered three biryanis
expects to see three.

Lines are merged when they match on **name, variant, unit price and tax
rate**, the merged line taking the position of its first appearance. Any
difference keeps them apart, and that is the point: prices are snapshotted per
round deliberately, so if the owner raised the biryani price between 8:42 and
9:06 the two rows carry different `unit_price` values and merging them would
invent a price nobody was charged.

The kitchen ticket does **not** merge. Round 2's ticket says `2 x Dum Biryani`
because two is what the kitchen has to cook.

Bills already written are untouched: a bill is frozen once generated.

## When it goes wrong

Printing is never on the critical path. Accepting a round writes the event and
returns; the API never waits on paper and never fails an order because a
printer was off. This is the stance `RealtimeBroadcaster.ping` already takes.

| Situation | Behaviour |
|---|---|
| Printer unplugged | Job stays unclaimed. Station shows "Kitchen printer not connected — 2 tickets waiting". The WebUSB `connect` event drains them inside the 30-minute window |
| Write fails mid-ticket | Receipt goes `failed` with the error; listed with a Reprint button, which writes `attempt 2`. Half-printed paper is physical: tear and reprint |
| Tab closed, machine off | Nothing claims, nothing is lost. On reopen it catches up within 30 minutes; older lands in **Missed** and prints only if a human asks |
| Two tabs on one machine | Both claim, the unique index gives one a `409`. One ticket |
| Station revoked mid-shift | `pending` returns `410`; the page says this machine is no longer a station and clears its `localStorage` |
| Round cancelled after its KOT printed | No paper. The board and the existing cancellation notification carry it |
| Bill reprint | Any time, from the board or the billing page: a new attempt against the same `order.completed` event. `generate_bill` is idempotent, so a reprint is identical to the original by construction |
| No station configured | Nothing prints, nothing errors, nothing accumulates — jobs exist only relative to a station. Every business already on the platform is unaffected until someone sets a machine up |

**No offline queue.** The station needs the API to know what to print. This is
acceptable because the diner's ordering flow is online: a shop with no
internet has no orders to print.

## Delivery order

Part 1 ships first and is working in production before Part 2 begins. Rounds
carrying their own status is a correctness fix that stands on its own — the
board stops lying whether or not a printer is ever attached — and building
tickets against the old order-level status would mean rewriting the trigger
logic the moment rounds changed. The implementation plan stages them
accordingly.

Part 1 is observable on its own: a table that orders again leaves its
in-flight rounds alone, and the board shows each round's state separately.
Nothing in Part 1 depends on anything in Part 2.

## Testing

Built test-first.

**`packages/shared`**
- Golden-byte tests per ticket DTO at 32 and 48 columns
- Column wrapping and two-column rows
- The event-to-job mapping table
- The round state machine and role matrix, extending `roles.spec.ts`
- The bill merge grouping key, including the price-changed-mid-meal case that
  must not merge

**`apps/api`**
- The order-status derivation matrix: every combination of round statuses
  against the expected `orders.status`
- `place_table_round` does not touch rounds already in flight
- Concurrent claims of one event produce exactly one ticket
- The 30-minute `pending` window
- `generate_bill` merging, including snapshot price divergence
- The RLS drift guard extended to `order_rounds`, `print_stations`,
  `station_outputs` and `print_receipts`, in the style of the kitchen policy
  tests

**`apps/web`**
- The station page against an injected fake transport, so no test needs real
  WebUSB
- Playwright: setup, accept, both tickets claimed, close, bill

**Two tests that encode the requirement directly**
- One accept with two stations configured produces exactly two tickets, one
  at each
- One accept with a single station holding all three outputs produces the
  token slip and the kitchen ticket from that one machine

## Not built

- **Void slips.** A cancelled round whose ticket the kitchen already holds
  produces no paper. Worth doing, needs its own decision about what the slip
  says.
- **Rasterised non-Latin text.** Named above.
- **Cash drawer and buzzer.**
- **An offline print queue.**
- **Per-round bills.** One order remains one bill.
- **Pairing codes.** A station is created by a logged-in staff user on the
  machine itself; the owner's revoke is the control.

## Roads not taken

**A local print agent.** Genuinely enumerates OS printers, routes per job,
prints with the existing driver and survives the tab closing. Rejected because
it is a binary to build, sign, install and update at every site.

**Network printers, printed server-side.** A Vercel function cannot reach a
printer behind a restaurant's router.

**`window.print()` to the default printer.** No device list, no online status,
and silent kiosk printing always targets the default printer — so one machine
could never drive a token roll and a bill roll.

**A `print_jobs` queue.** More conventional, and freezes ticket content at
accept time. Rejected because it is a second source of truth beside
`order_events`, with a job lifecycle to maintain and rows to garbage-collect,
for guarantees a unique index already provides.

**No server state; print what the board shows.** Clearing browser data
reprints the day; a second counter tab prints every token twice.

**A status column on `order_items`, no rounds table.** A round would have no
identity, so there is nowhere to hang a KOT number, an accepted-at time or an
event, and "the rounds of this order" becomes a `GROUP BY` everywhere.
Cheaper now, more expensive forever.

## Known risks

**WebUSB on Windows.** A thermal printer installed as a normal Windows
printer is claimed by `usbprint.sys` and WebUSB cannot take it over without a
one-time WinUSB swap (Zadig) on that machine. Printers in virtual-COM mode
avoid this entirely via Web Serial. Setup documentation must say so plainly,
and the link-a-printer screen should detect the empty chooser and explain it
rather than looking broken.

**Chrome and Edge only.** WebUSB and Web Serial do not exist in Safari or
Firefox. The station page must say which browser it needs rather than failing
silently.

**`OPEN_STATUSES` drift.** The derivation function joins the list of places
that hand-write the open statuses in SQL. It must be named in the existing
warning comment in `apps/api/src/orders/transitions.ts`.
