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
async function offered(stationId: string): Promise<string[]> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_user_id', ${owner}::text, true)`;
    const stations = new StationsService(
      { db: tx } as never,
      { assertAccess: async () => ({ business: { id: biz }, role: "owner" as const }) } as never,
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
