import "../config/load-dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

/**
 * The constraints, asserted against a real database. Every one of these is
 * load-bearing in a way application code cannot be: they hold even when two
 * requests race, which is exactly the case that produces double paper.
 */
const ADMIN_URL = process.env.DIRECT_URL!;

let admin: Client;
let owner: string, kitchenUser: string, outsider: string, biz: string, station: string, eventId: string;

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();

  const user = async (name: string, role: "owner" | "kitchen") => {
    const r = await admin.query(
      `INSERT INTO users (id, pin_hash, full_name, phone, role, verified_at, updated_at)
       VALUES (gen_random_uuid(), 'x', $1, $2, $3, now(), now()) RETURNING id`,
      [name, `+9199${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`, role],
    );
    return r.rows[0].id as string;
  };
  owner = await user("Printing Owner", "owner");
  kitchenUser = await user("Printing Kitchen", "kitchen");
  // Belongs to no business at all — the caller the functions must refuse.
  outsider = await user("Printing Outsider", "owner");

  const b = await admin.query(
    `INSERT INTO businesses (id, owner_id, name, type, public_code, updated_at)
     VALUES (gen_random_uuid(), $1, 'Printing Test', 'restaurant', $2, now()) RETURNING id`,
    [owner, Math.random().toString(36).slice(2, 10).toUpperCase().padEnd(8, "X")],
  );
  biz = b.rows[0].id;

  await admin.query(
    `INSERT INTO business_staff (id, business_id, user_id, updated_at)
     VALUES (gen_random_uuid(), $1, $2, now())`,
    [biz, kitchenUser],
  );

  const t = await admin.query(
    `INSERT INTO tables (id, business_id, label, token, position)
     VALUES (gen_random_uuid(), $1, '1', $2, 1) RETURNING id`,
    [biz, Math.random().toString(36).slice(2).padEnd(32, "0").slice(0, 32)],
  );
  const o = await admin.query(
    `INSERT INTO orders (id, business_id, table_id, status, business_day, daily_number, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'placed', CURRENT_DATE, 7001, now()) RETURNING id`,
    [biz, t.rows[0].id],
  );
  const e = await admin.query(
    `INSERT INTO order_events (order_id, business_id, kind) VALUES ($1, $2, 'accepted') RETURNING id`,
    [o.rows[0].id, biz],
  );
  eventId = e.rows[0].id;

  const s = await admin.query(
    `INSERT INTO print_stations (id, business_id, name, updated_at)
     VALUES (gen_random_uuid(), $1, 'Counter', now()) RETURNING id`,
    [biz],
  );
  station = s.rows[0].id;
});

afterAll(async () => {
  await admin.query("DELETE FROM businesses WHERE id = $1", [biz]);
  await admin.query("DELETE FROM users WHERE id = ANY($1)", [[owner, kitchenUser, outsider]]);
  await admin.end();
});

describe("print_stations schema", () => {
  it("allows one output per job per station and refuses a second", async () => {
    // Two 'kitchen' printers on one machine is not a configuration, it is a
    // mistake, and the shape of the data is what says so.
    await admin.query(
      `INSERT INTO station_outputs (id, business_id, station_id, job, device_label, device_key, transport, paper_width, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'kitchen', 'EPSON TM-T82', 'v:p:s1', 'usb', 80, now())`,
      [biz, station],
    );
    await expect(
      admin.query(
        `INSERT INTO station_outputs (id, business_id, station_id, job, device_label, device_key, transport, paper_width, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'kitchen', 'Other', 'v:p:s2', 'usb', 80, now())`,
        [biz, station],
      ),
    ).rejects.toThrow(/station_outputs_station_id_job_key|duplicate key/);
  });

  it("accepts the same device on two jobs, which is the one-machine shop", async () => {
    // Pointing token and bill at one device_key is how a single roll does
    // both. Nothing branches on "how many devices".
    await admin.query(
      `INSERT INTO station_outputs (id, business_id, station_id, job, device_label, device_key, transport, paper_width, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'token', 'EPSON TM-T82', 'v:p:s1', 'usb', 58, now()),
              (gen_random_uuid(), $1, $2, 'bill',  'EPSON TM-T82', 'v:p:s1', 'usb', 58, now())`,
      [biz, station],
    );
    const r = await admin.query(
      `SELECT count(*)::int AS n FROM station_outputs WHERE station_id = $1 AND device_key = 'v:p:s1'`,
      [station],
    );
    expect(r.rows[0].n).toBe(3);
  });

  it("refuses a paper width no roll comes in", async () => {
    await expect(
      admin.query(
        `INSERT INTO station_outputs (id, business_id, station_id, job, device_label, device_key, transport, paper_width, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'kitchen', 'X', 'k', 'usb', 70, now())`,
        [biz, station],
      ),
    ).rejects.toThrow(/station_outputs_paper_width_check|violates check constraint/);
  });

  it("refuses a second receipt for the same station, event, job and attempt", async () => {
    // THE constraint. Two tabs on one machine both claim; one of them gets
    // this error and skips, and the shop gets one ticket.
    await admin.query(
      `INSERT INTO print_receipts (business_id, station_id, event_id, job, attempt, status, claimed_at)
       VALUES ($1, $2, $3, 'token', 1, 'claimed', now())`,
      [biz, station, eventId],
    );
    await expect(
      admin.query(
        `INSERT INTO print_receipts (business_id, station_id, event_id, job, attempt, status, claimed_at)
         VALUES ($1, $2, $3, 'token', 1, 'claimed', now())`,
        [biz, station, eventId],
      ),
    ).rejects.toThrow(/print_receipts_claim_key|duplicate key/);
  });

  it("lets a reprint through as a second attempt", async () => {
    // Half-printed paper is physical: tear it off and print attempt 2.
    const r = await admin.query(
      `INSERT INTO print_receipts (business_id, station_id, event_id, job, attempt, status, claimed_at)
       VALUES ($1, $2, $3, 'token', 2, 'claimed', now()) RETURNING attempt`,
      [biz, station, eventId],
    );
    expect(r.rows[0].attempt).toBe(2);
  });

  it("adds no kitchen INSERT or DELETE policy", async () => {
    // The invariant kitchen-policies.spec.ts asserts for the whole schema,
    // re-checked here against this migration's own tables — the kitchen's
    // writes go through SECURITY DEFINER functions, never a policy.
    const r = await admin.query(
      `SELECT policyname, cmd FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename IN ('print_stations', 'station_outputs', 'print_receipts')
          AND cmd IN ('INSERT', 'DELETE')
          AND policyname LIKE '%\\_kitchen\\_%'`,
    );
    expect(r.rows).toEqual([]);
  });

  it("lets a kitchen user claim a ticket through the function, not a policy", async () => {
    // The door the invariant leaves open. Runs as menu_app with the kitchen
    // user's tenant context — the same principal a real request carries —
    // because as a superuser this would pass with the function deleted.
    const app = new Client({ connectionString: process.env.APP_DATABASE_URL! });
    await app.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.current_user_id', $1, true)", [kitchenUser]);
      const r = await app.query(
        `SELECT (claim_print_receipt($1, $2, $3, 'kitchen', 1)).id AS id`,
        [biz, station, eventId],
      );
      expect(r.rows[0].id).toBeTruthy();
      await app.query("ROLLBACK");
    } finally {
      await app.end();
    }
  });

  it("refuses a claim for a business the caller has nothing to do with", async () => {
    // SECURITY DEFINER means RLS is not checking this — the function is.
    const app = new Client({ connectionString: process.env.APP_DATABASE_URL! });
    await app.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.current_user_id', $1, true)", [outsider]);
      await expect(
        app.query(`SELECT claim_print_receipt($1, $2, $3, 'kitchen', 1)`, [biz, station, eventId]),
      ).rejects.toThrow(/not your business/i);
      await app.query("ROLLBACK");
    } finally {
      await app.end();
    }
  });

  it("refuses a bill output written by someone who is not the owner", async () => {
    // A bill is prices, and the kitchen role sees no prices anywhere in
    // this product. The guard is a trigger, not a service check, because
    // the service is not the only thing that can write this table.
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('app.current_user_id', $1, true)", [kitchenUser]);
    await expect(
      admin.query(
        `INSERT INTO station_outputs (id, business_id, station_id, job, device_label, device_key, transport, paper_width, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'bill', 'X', 'kk', 'usb', 80, now())`,
        [biz, station],
      ),
    ).rejects.toThrow(/only the owner/i);
    await admin.query("ROLLBACK");
  });
});
