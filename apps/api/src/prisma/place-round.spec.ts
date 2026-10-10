import "../config/load-dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

/**
 * place_table_round is the only writer of order_rounds. Three things about it
 * would be invisible until a customer hit them, so each gets a test here: a
 * new round used to drag the whole order back to 'placed', and the two
 * numbers it allocates are `MAX(...) + 1` reads whose safety rests entirely
 * on the locks taken before them — seq on the table lock, kot_number on the
 * business-and-day lock inside next_kot_number.
 *
 * Everything runs as the admin role: what is asserted is a function's
 * arithmetic, not who may see it. `updated_at` has no database-level default
 * anywhere in this schema — Prisma's @updatedAt only fires through Prisma
 * Client — so every raw INSERT sets it explicitly.
 */
const ADMIN_URL = process.env.DIRECT_URL!;
let admin: Client;
let owner: string, biz: string, table: string, itemId: string;

/**
 * A table of its own per test. `orders_one_open_per_table` allows a table
 * exactly one open order and every test here leaves one behind, so sharing
 * one table would couple them to each other's order and to run order.
 */
async function freshTable(): Promise<string> {
  const t = await admin.query(
    `INSERT INTO tables (id, business_id, label, token, position)
     VALUES (gen_random_uuid(), $1, '1', $2, 1) RETURNING id`,
    [biz, Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32)],
  );
  return t.rows[0].id as string;
}

const lines = (qty: number) => JSON.stringify([{ itemId, variantId: null, quantity: qty }]);

const place = (c: Client, tableId: string, qty = 1) =>
  c.query(`SELECT place_table_round($1, $2, $3::jsonb)`, [tableId, biz, lines(qty)]);

/**
 * Two rounds placed in genuinely overlapping transactions.
 *
 * Racing two autocommit calls with Promise.all and hoping they collide is not
 * a test — the window between a `MAX(...) + 1` read and its INSERT is a few
 * microseconds, so an unlocked allocator passes most of the time and the gate
 * is worthless. This holds session A's transaction open instead. A's round is
 * then committed to nothing and invisible to B under MVCC, so B *must* be
 * held off by a lock; nothing else can save it.
 *
 * The barrier is exact rather than a sleep. Before A commits we wait for B's
 * backend to actually be waiting on a lock, which it is in both worlds: with
 * the locks right, B waits on the advisory lock A holds; with them wrong, B
 * sails past the MAX, computes the same number, and waits on A's transaction
 * id at the unique index. Either way B has provably reached the contended
 * point before A lets go, which is what makes this deterministic in both
 * directions instead of merely likely.
 */
async function placeInOverlappingTransactions(tableA: string, tableB: string) {
  const a = new Client({ connectionString: ADMIN_URL });
  const b = new Client({ connectionString: ADMIN_URL });
  await a.connect();
  await b.connect();
  try {
    const bPid = (await b.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;

    await a.query("BEGIN");
    await place(a, tableA);

    await b.query("BEGIN");
    const bPlaced = place(b, tableB);

    const deadline = Date.now() + 4000;
    for (;;) {
      const w = await admin.query(
        `SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'`,
        [bPid],
      );
      if (w.rowCount) break;
      if (Date.now() > deadline) {
        throw new Error(
          "second session never waited for the first: nothing serialised the " +
            "two, so whichever number they allocated they allocated blind",
        );
      }
      await new Promise((r) => setTimeout(r, 20));
    }

    await a.query("COMMIT");
    await bPlaced;
    await b.query("COMMIT");
  } finally {
    await a.end();
    await b.end();
  }
}

/** Rounds on a table, found through the table rather than through one order. */
const roundsAtTables = (tableIds: string[]) =>
  admin.query(
    `SELECT count(*)::int               AS rounds,
            count(DISTINCT r.seq)::int  AS seqs,
            count(DISTINCT r.kot_number)::int AS kots,
            count(DISTINCT r.order_id)::int   AS orders
     FROM order_rounds r
     JOIN orders o ON o.id = r.order_id
     WHERE o.table_id = ANY($1)`,
    [tableIds],
  );

const openOrdersAt = async (tableId: string) =>
  (
    await admin.query(
      `SELECT count(*)::int AS n FROM orders
       WHERE table_id = $1 AND status IN ('placed','accepted','preparing','ready')`,
      [tableId],
    )
  ).rows[0].n as number;

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const u = await admin.query(
    `INSERT INTO users (id, pin_hash, full_name, phone, verified_at, updated_at)
     VALUES (gen_random_uuid(), 'x', 'Place Round Owner', $1, now(), now()) RETURNING id`,
    [`+9199${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`],
  );
  owner = u.rows[0].id;
  const b = await admin.query(
    `INSERT INTO businesses (id, owner_id, name, public_code, type, currency, updated_at)
     VALUES (gen_random_uuid(), $1, 'Place Round Test', $2, 'restaurant', 'INR', now())
     RETURNING id`,
    [owner, Math.random().toString(36).slice(2, 10).toUpperCase()],
  );
  biz = b.rows[0].id;
  table = await freshTable();
  const cat = await admin.query(
    `INSERT INTO menu_categories (id, business_id, name, position)
     VALUES (gen_random_uuid(), $1, 'Drinks', 0) RETURNING id`,
    [biz],
  );
  const item = await admin.query(
    `INSERT INTO menu_items (id, business_id, category_id, name, price, is_available, position, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'Irani Chai', 30.00, true, 0, now()) RETURNING id`,
    [biz, cat.rows[0].id],
  );
  itemId = item.rows[0].id;
});

afterAll(async () => {
  await admin.query("DELETE FROM businesses WHERE id = $1", [biz]);
  await admin.query("DELETE FROM users WHERE id = $1", [owner]);
  await admin.end();
});

describe("place_table_round", () => {
  it("leaves an in-flight round alone when a new round arrives", async () => {
    await place(admin, table, 1);
    await admin.query(
      `UPDATE order_rounds SET status = 'ready' WHERE order_id =
         (SELECT id FROM orders WHERE table_id = $1 AND status <> 'completed' LIMIT 1)`,
      [table],
    );

    await place(admin, table, 2);

    const r = await admin.query(
      `SELECT seq, status::text AS s FROM order_rounds
       WHERE order_id = (SELECT id FROM orders WHERE table_id = $1 AND status <> 'completed' LIMIT 1)
       ORDER BY seq`,
      [table],
    );
    expect(r.rows.map((x) => [x.seq, x.s])).toEqual([
      [1, "ready"],
      [2, "placed"],
    ]);
  });

  // Review Focus #2, within one table: seq is unique per order, and the table
  // advisory lock is the only thing standing between two phones at one table
  // and two rounds numbered the same.
  it("gives concurrent rounds at one table distinct seq and kot_number", async () => {
    const t = await freshTable();
    // An open order first, so both concurrent calls take the append path.
    await place(admin, t, 1);

    await placeInOverlappingTransactions(t, t);

    // Counted through the table, not through one order: scoping to a single
    // order id would hide the very failure where the race ends up creating a
    // second open order for the table.
    expect(await openOrdersAt(t)).toBe(1);
    const r = await roundsAtTables([t]);
    expect(r.rows[0]).toMatchObject({ orders: 1, rounds: 3, seqs: 3, kots: 3 });
  });

  // Review Focus #2, across tables. kot_number is unique per *business*, so a
  // per-table lock cannot protect it: two diners at two tables in one venue
  // take different table locks and never block each other.
  it("gives concurrent rounds at different tables distinct kot_number", async () => {
    const t1 = await freshTable();
    const t2 = await freshTable();
    // Both tables need an open order before the concurrent pair, or each call
    // would take the new-order branch and be serialised for the wrong reason:
    // next_daily_number already takes the business-and-day lock on that path,
    // so the test would pass without next_kot_number taking it at all. The
    // append path is both the commonest and the unprotected one.
    await place(admin, t1, 1);
    await place(admin, t2, 1);

    await placeInOverlappingTransactions(t1, t2);

    expect(await openOrdersAt(t1)).toBe(1);
    expect(await openOrdersAt(t2)).toBe(1);
    const r = await roundsAtTables([t1, t2]);
    expect(r.rows[0]).toMatchObject({ orders: 2, rounds: 4, kots: 4 });
  });
});
