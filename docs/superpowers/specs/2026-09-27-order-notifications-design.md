# Order notifications — design

**Date:** 2026-09-27
**Status:** approved, implementing

## What this is for

Staff must learn that an order exists without watching the board, and diners
must learn their food is ready without asking. Today both screens discover
everything by refetching on a 5s `setInterval` — three of them, on every open
device, forever. That is the whole real-time story, and it is both slow to
notice and expensive: ~720 serverless invocations an hour per open tab.

Success: a new order reaches a counter tablet in under a second with a sound
and a notification carrying enough detail to act on; an order that arrives
while nobody is looking is still recoverable afterwards; and nothing is ever
silently lost when the network drops.

## The constraint that shapes everything

The API is a Vercel serverless function (`api/index.ts`, `maxDuration: 30`).
There is no long-lived process to hold a socket, no shared memory to fan out
across instances, and an SSE stream would die at 30s while billing for the
whole window. A `ws` gateway in Nest is not an option here.

Supabase Realtime is: the project is already on Supabase Postgres, Realtime is
a hosted WebSocket service, and the server side of a broadcast is a plain
HTTPS POST — no connection for the function to hold.

## Architecture: ping-and-fetch

The socket carries a **content-free signal**. The client responds by fetching
over the authenticated HTTP API it already uses.

This is the central decision. It means:

- Order contents never touch a pub/sub channel, so channel security stops
  being load-bearing.
- Every wake-up path — socket reconnect, tab becomes visible, fallback poll —
  is the *same* catch-up fetch. A ping that never arrives costs nothing.
- The socket is a latency optimisation over a correct polling system, not a
  thing correctness depends on.

Rejected: broadcasting full payloads (a dropped message becomes a permanently
lost notification, and two code paths build the same notification); Realtime
`postgres_changes` (requires giving the browser's anon key RLS `SELECT` on
`orders` in a multi-tenant app — widening the most sensitive policy to save a
controller).

## Two audiences, deliberately asymmetric

**Staff get an inbox.** A `notifications` table is the source of truth. The
toast, the bell panel and the Web Push notification all render the same row,
so they cannot disagree about what happened, and an order that arrived while
the tablet was asleep is still there afterwards.

**Diners get no inbox.** A diner needs their current order state, not a
history — and `GET /public/table/order` already returns exactly that. So a
status change broadcasts a ping and stores nothing; the diner screen refetches
the order it was already polling for and animates the change. This removes a
diner-facing notifications endpoint, its SECURITY DEFINER read function, and
an audience column, for no loss in what the diner sees.

## Events

| Event | Trigger | Audience | Stored |
| --- | --- | --- | --- |
| `order.placed` | `placeRound` creates an order | staff | yes |
| `order.round_added` | `placeRound` appends a batch | staff | yes |
| `order.status` | `setStatus` | that table | no |

`place_table_round` already returns the order with `batch` numbers, so
new-order vs. added-round is derivable with no SQL change.

## Writing notifications under RLS

Every stored notification is triggered by a **diner**, who has no
`app.current_user_id`, so RLS correctly refuses an ordinary insert. Inserts go
through `emit_staff_notification(...)`, a SECURITY DEFINER function, matching
the existing `place_table_round` / `get_table_order` pattern.

That function returns the new row **and the owner's push subscriptions** in
one call, because Web Push needs them and the alternative is a second
definer function plus another round trip to a database ~400ms away.

## Channel naming

`business:<hmac>` and `table:<hmac>`, HMAC-SHA256 of the id under
`REALTIME_CHANNEL_SECRET`, truncated to 32 hex chars.

A business UUID is not a secret — it appears in `/businesses/:bid/...` URLs,
browser history and logs. Deriving the channel from it would let anyone who
saw a URL subscribe to that restaurant's activity. The HMAC makes the channel
name an unguessable capability that a leaked id does not yield. Each client is
told its own channel name by the API; nobody derives one client-side.

Since the payload is content-free, this is sufficient — private channels with
minted JWTs and `realtime.messages` RLS would protect a message that says
`{"cursor": 4821}`.

## Reliability

- `seq` is a `bigserial` on `notifications`; it is the cursor.
- Catch-up `GET .../notifications?since=<seq>` runs on subscribe, on
  reconnect, and on `visibilitychange → visible`.
- A 25s fallback poll runs **only** while the socket is not `SUBSCRIBED`.
- The client dedupes by notification id, so a replayed ping cannot
  double-chime.
- Existing 5s polls on the order board and diner screens drop to a slow
  fallback, which is where the invocation saving comes from.

## Permission, asked exactly once

Never on page load. A dismissible card at the top of the bell panel is the
only thing that ever calls `Notification.requestPermission()`, and only on a
click — which Push subscription requires anyway.

The outcome is written to localStorage **including dismissal**, and the card
never returns. Settings carries a re-enable control for anyone who changes
their mind. If permission is already `denied`, nothing is shown at all.

Permission state is per-device, so the record is per-device (localStorage),
not per-user on the server.

## Sound

WebAudio synthesis, not an audio file: a two-note chime for a new order, a
softer single note for a status change. No binary asset, no format matrix,
works offline.

Autoplay policy blocks audio before a gesture, so the context is unlocked on
the first pointer/key event on the dashboard and reused. A mute toggle lives
in the bell panel, persisted to localStorage.

## Escalation

An unacknowledged new order re-chimes at 30s and 90s, then stops. Capped by
construction — it cannot become a loop. Acknowledgement is marking it read or
opening the board.

**Known limitation:** this is client-side, so it only escalates while a tab is
alive. Server-side re-push to a closed device is a real feature and a
different one; the seam is left, the code is not written.

## Web Push

`web-push` on the API, VAPID keypair in env, subscriptions pruned on 404/410.
Fan-out is tiny — one owner, a handful of devices.

**iOS delivers Web Push only to sites installed to the Home Screen.** The
`manifest.ts` and icons already exist, so the path is there, but the UI must
say so rather than appearing broken on an iPhone.

## Module layout

The existing `apps/api/src/notifications/` is OTP delivery channels with one
consumer. It moves to `apps/api/src/otp/channels/`, freeing the name rather
than leaving two unrelated concepts fighting over it.

**API** — `notifications/`: `events.ts` (kinds + the single place that decides
what a notification says), `notifications.service.ts` (emit: store, broadcast,
push), `notifications.controller.ts`, `realtime.broadcast.ts`,
`web-push.sender.ts`, `channel-name.ts`.

**Web** — pure logic in `lib/notifications/` so it is testable without a
browser, the way `lib/freshness.ts` is: `feed.ts` (merge/dedupe/unread/cursor),
`permission.ts` (the ask-once state machine), `escalation.ts`, `chime.ts`,
`realtime.ts`. UI in `components/notifications/`.

## New configuration

`SUPABASE_URL`, `SUPABASE_ANON_KEY` (+ `NEXT_PUBLIC_` pair),
`REALTIME_CHANNEL_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
`VAPID_SUBJECT`.

Setting `SUPABASE_URL` currently flips `usesSupabaseStorage()` to true.
Cloudinary wins in practice because every call site happens to check it first,
but that precedence is implicit in call order rather than stated.
`usesSupabaseStorage()` is tightened to say so explicitly, so enabling
Realtime cannot quietly change where images come from.

## Testing

Pure modules carry the load: the feed reducer, the permission state machine,
the escalation timer, the chime's unlock/mute state, HMAC derivation.

On the API: emitter fan-out per domain event, push pruning on 410, and tenant
isolation on the notifications controller (owner A cannot read owner B's rows).

Playwright: diner places an order, staff board shows it, a notification row
exists.
