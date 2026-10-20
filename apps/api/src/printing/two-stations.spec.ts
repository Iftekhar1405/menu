import "../config/load-dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { PrismaClient } from "@prisma/client";
import { ReceiptsService } from "./receipts.service";
import { StationsService } from "./stations.service";

/**
 * The two requirements the spec states directly, against a real database.
 *
 * Both are about the same thing from two directions: nothing anywhere
 * branches on "how many devices this shop has". The count of stations and
 * the outputs on them IS the configuration.
 *
 * `offered()` runs the production `ReceiptsService.pending()` itself,
 * inside a menu_app transaction exactly as TenantInterceptor opens one for
 * a real request — the same shape close-table.spec.ts uses for
 * `OrdersService.setStatus`. A reimplementation of pending()'s query here
 * would only prove this file agrees with itself; calling the real method is
 * what lets a regression in the mapping or the per-station filter actually
 * turn this suite red. Only `assertAccess` is stubbed, and for the reason
 * the precedent gives: ownership is a different spec's subject, and
 * stubbing it keeps `printStation.findFirst`, `orderEvent.findMany` and
 * `printReceipt.findMany` — the real schema, the real column mapping, the
 * real RLS as the menu_app role — all genuinely exercised.
 */
const ADMIN_URL = process.env.DIRECT_URL!;
const APP_URL = process.env.APP_DATABASE_URL || process.env.DATABASE_URL!;

let admin: Client;
let prisma: PrismaClient;
let owner: string, biz: string, eventId: string;
let counter: string, kitchenStation: string, oneMachine: string;

async function station(name: string, jobs: { job: string; width: number }[]) {
  const s = await admin.query(
    `INSERT INTO print_stations (id, business_id, name, updated_at)
     VALUES (gen_random_uuid(), $1, $2, now()) RETURNING id`,
    [biz, name],
  );
  const id = s.rows[0].id as string;
  for (const j of jobs) {
    await admin.query(
      `INSERT INTO station_outputs (id, business_id, station_id, job, device_label, device_key, transport, paper_width, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'P', $4, 'usb', $5, now())`,
      [biz, id, j.job, `${name}:${j.job}`, j.width],
    );
  }
  return id;
}

/**
 * What a station would be offered, through the real service — see the file
 * comment for why this is not a second copy of its query.
 */
async function offered(
  stationId: string,
  role: "owner" | "kitchen" = "owner",
): Promise<string[]> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_user_id', ${owner}::text, true)`;
    const stations = new StationsService(
      { db: tx } as never,
      { assertAccess: async () => ({ business: { id: biz }, role }) } as never,
    );
    const receipts = new ReceiptsService({ db: tx } as never, stations, {} as never);
    const { pending } = await receipts.pending(owner, biz, stationId);
    return pending.map((p) => p.job);
  });
}

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();

  const u = await admin.query(
    `INSERT INTO users (id, pin_hash, full_name, phone, verified_at, updated_at)
     VALUES (gen_random_uuid(), 'x', 'Two Stations', $1, now(), now()) RETURNING id`,
    [`+9199${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`],
  );
  owner = u.rows[0].id;

  const b = await admin.query(
    `INSERT INTO businesses (id, owner_id, name, type, public_code, updated_at)
     VALUES (gen_random_uuid(), $1, 'Two Stations', 'restaurant', $2, now()) RETURNING id`,
    [owner, Math.random().toString(36).slice(2, 10).toUpperCase().padEnd(8, "X")],
  );
  biz = b.rows[0].id;

  const t = await admin.query(
    `INSERT INTO tables (id, business_id, label, token, position)
     VALUES (gen_random_uuid(), $1, '7', $2, 1) RETURNING id`,
    [biz, Math.random().toString(36).slice(2).padEnd(32, "0").slice(0, 32)],
  );
  const o = await admin.query(
    `INSERT INTO orders (id, business_id, table_id, status, business_day, daily_number, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'placed', CURRENT_DATE, 14, now()) RETURNING id`,
    [biz, t.rows[0].id],
  );
  const e = await admin.query(
    `INSERT INTO order_events (order_id, business_id, kind) VALUES ($1, $2, 'round.accepted') RETURNING id`,
    [o.rows[0].id, biz],
  );
  eventId = e.rows[0].id;

  counter = await station("Counter", [{ job: "token", width: 58 }, { job: "bill", width: 80 }]);
  kitchenStation = await station("Kitchen", [{ job: "kitchen", width: 80 }]);
  oneMachine = await station("All in one", [
    { job: "token", width: 58 },
    { job: "kitchen", width: 58 },
    { job: "bill", width: 58 },
  ]);

  prisma = new PrismaClient({ datasources: { db: { url: APP_URL } } });
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
  await admin.query("DELETE FROM businesses WHERE id = $1", [biz]);
  await admin.query("DELETE FROM users WHERE id = $1", [owner]);
  await admin.end();
});

describe("one accept, two machines", () => {
  it("gives each machine exactly the one job it holds", async () => {
    // The counter prints the token, the kitchen prints the ticket, at the
    // same moment, and neither knows the other exists.
    expect(await offered(counter)).toEqual(["token"]);
    expect(await offered(kitchenStation)).toEqual(["kitchen"]);
  });

  it("gives a single machine holding all three outputs both slips", async () => {
    // Same event, same data, no mode flag: one roll does both, back to back.
    expect(await offered(oneMachine)).toEqual(["token", "kitchen"]);
  });

  it("offers the bill to nobody until the order is closed", async () => {
    // The counter holds a bill printer, and an accepted round is still not
    // a bill. Closing the table is what produces one.
    expect(await offered(counter)).not.toContain("bill");
  });
});

describe("two tabs on one machine", () => {
  it("lets exactly one of two concurrent claims through", async () => {
    // Review Focus 2, for real: two connections, one event, one job, no
    // coordination between them except the index.
    const tabs = [new Client({ connectionString: ADMIN_URL }), new Client({ connectionString: ADMIN_URL })];
    await Promise.all(tabs.map((c) => c.connect()));

    const claim = (c: Client) =>
      c.query(
        `INSERT INTO print_receipts (business_id, station_id, event_id, job, attempt, status, claimed_at)
         VALUES ($1, $2, $3, 'token', 1, 'claimed', now())`,
        [biz, counter, eventId],
      );

    const results = await Promise.allSettled([claim(tabs[0]!), claim(tabs[1]!)]);
    await Promise.all(tabs.map((c) => c.end()));

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const n = await admin.query(
      `SELECT count(*)::int AS n FROM print_receipts
        WHERE station_id = $1 AND event_id = $2 AND job = 'token'`,
      [counter, eventId],
    );
    expect(n.rows[0].n).toBe(1);
  });
});

/**
 * The final-review fixes (C1's other half, C2, I1), against the real
 * `claim_print_receipt` function and real RLS, not a mocked Prisma client.
 * The unit suites (pending.spec.ts, claim.spec.ts) prove the service calls
 * the right functions with the right arguments; they cannot prove the SQL
 * function itself tolerates a retried insert, or that StationsService's real
 * `roleFor` actually reaches `pending()`'s query.
 */
describe("final review fixes, against a real database", () => {
  let completedEventId: string;
  // A round.accepted event that actually has a round behind it, unlike the
  // suite-wide `eventId` (deliberately round-less — see "one accept, two
  // machines" for why). ticketFor() needs a real round to succeed, and a
  // claim that never reaches ticketFor never proves the retry survives the
  // one-transaction-per-request rollback a throw there would otherwise
  // cause (see roundEventId's own test).
  let roundEventId: string;

  beforeAll(async () => {
    // A dedicated event of a kind that actually produces a bill
    // (jobsForEvent("completed") === ["bill"]); the suite-wide `eventId` is
    // a round.accepted and never offers bill to anyone, which would make a
    // role-filter test here pass vacuously.
    const ce = await admin.query(
      `INSERT INTO order_events (order_id, business_id, kind)
       SELECT order_id, $1, 'completed' FROM order_events WHERE id = $2 RETURNING id`,
      [biz, eventId],
    );
    completedEventId = ce.rows[0].id;

    const r = await admin.query(
      `INSERT INTO order_rounds (id, business_id, order_id, seq, business_day, kot_number, status, placed_at)
       SELECT gen_random_uuid(), $1, order_id, 2, CURRENT_DATE, 999, 'accepted', now()
         FROM order_events WHERE id = $2 RETURNING id`,
      [biz, eventId],
    );
    const roundId = r.rows[0].id;
    const re = await admin.query(
      `INSERT INTO order_events (order_id, business_id, kind, round_id)
       SELECT order_id, $1, 'round.accepted', $2 FROM order_events WHERE id = $3 RETURNING id`,
      [biz, roundId, eventId],
    );
    roundEventId = re.rows[0].id;
  });

  afterAll(async () => {
    await admin.query("DELETE FROM order_events WHERE id = $1", [completedEventId]);
    await admin.query("DELETE FROM order_events WHERE id = $1", [roundEventId]);
  });

  async function claimReal(
    stationId: string,
    eventIdStr: string,
    job: "token" | "kitchen" | "bill",
    now?: Date,
  ) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${owner}::text, true)`;
      const stations = new StationsService(
        { db: tx } as never,
        { assertAccess: async () => ({ business: { id: biz }, role: "owner" as const }) } as never,
      );
      const receipts = new ReceiptsService({ db: tx } as never, stations, {} as never);
      return receipts.claim(owner, biz, stationId, { eventId: eventIdStr, job }, now);
    });
  }

  it("hides the bill job from a kitchen principal on a station that holds a bill printer", async () => {
    // C1's other half. claim() already refuses a kitchen principal's bill
    // claim with a 403 (claim.spec.ts); pending() must now agree before the
    // claim is ever attempted, against real RLS — not a stub that always
    // answers "owner". `completedEventId` (set up above) is what actually
    // makes "bill" a candidate at all; the suite-wide `eventId` never would,
    // which would make this pass vacuously regardless of the fix.
    expect(await offered(counter, "kitchen")).not.toContain("bill");
    expect(await offered(counter, "owner")).toContain("bill");
  });

  it("reclaims a receipt whose previous attempt failed, as attempt 2 (C2)", async () => {
    // roundEventId, not the suite-wide eventId: the whole request runs in
    // one transaction (TenantInterceptor), so a throw from ticketFor() would
    // roll back the insert along with it, and this needs the claim to
    // actually commit to prove the retry survives for real.
    await admin.query(
      `INSERT INTO print_receipts (business_id, station_id, event_id, job, attempt, status, claimed_at, error)
       VALUES ($1, $2, $3, 'kitchen', 1, 'failed', now(), 'device unavailable')`,
      [biz, kitchenStation, roundEventId],
    );
    try {
      const out = await claimReal(kitchenStation, roundEventId, "kitchen");
      expect(out.attempt).toBe(2);
      const row = await admin.query(
        `SELECT status FROM print_receipts
          WHERE station_id = $1 AND event_id = $2 AND job = 'kitchen' AND attempt = 2`,
        [kitchenStation, roundEventId],
      );
      expect(row.rows).toHaveLength(1);
    } finally {
      await admin.query(
        `DELETE FROM print_receipts WHERE station_id = $1 AND event_id = $2 AND job = 'kitchen'`,
        [kitchenStation, roundEventId],
      );
    }
  });

  it("reclaims a claim abandoned past the stale window, as attempt 2 (I1)", async () => {
    const staleClaim = new Date(Date.now() - 10 * 60_000); // ten minutes ago
    await admin.query(
      `INSERT INTO print_receipts (business_id, station_id, event_id, job, attempt, status, claimed_at)
       VALUES ($1, $2, $3, 'kitchen', 1, 'claimed', $4)`,
      [biz, oneMachine, roundEventId, staleClaim],
    );
    try {
      const out = await claimReal(oneMachine, roundEventId, "kitchen");
      expect(out.attempt).toBe(2);
      const row = await admin.query(
        `SELECT status FROM print_receipts
          WHERE station_id = $1 AND event_id = $2 AND job = 'kitchen' AND attempt = 2`,
        [oneMachine, roundEventId],
      );
      expect(row.rows).toHaveLength(1);
    } finally {
      await admin.query(
        `DELETE FROM print_receipts WHERE station_id = $1 AND event_id = $2 AND job = 'kitchen'`,
        [oneMachine, roundEventId],
      );
    }
  });

  it("still 409s a fresh, live claim rather than reclaiming it (not abandoned)", async () => {
    await admin.query(
      `INSERT INTO print_receipts (business_id, station_id, event_id, job, attempt, status, claimed_at)
       VALUES ($1, $2, $3, 'kitchen', 1, 'claimed', now())`,
      [biz, oneMachine, eventId],
    );
    try {
      await expect(claimReal(oneMachine, eventId, "kitchen")).rejects.toThrow(
        /already took this ticket/,
      );
    } finally {
      await admin.query(
        `DELETE FROM print_receipts WHERE station_id = $1 AND event_id = $2 AND job = 'kitchen'`,
        [oneMachine, eventId],
      );
    }
  });
});
