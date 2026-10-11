import "../config/load-dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

/**
 * cancel_table_order judges a cancellation against the round the dish is in.
 *
 * The order's own status cannot answer the question any more. It is derived
 * as the *least advanced* live round, so an order holding a ready biryani and
 * a just-placed chai reads 'placed' — and an order-level guard reading that
 * would happily let the diner call back the biryani the pass is plating. The
 * round knows; the order does not.
 *
 * The second half is what happens to a round once its last dish goes.
 * Cancelling deletes order_items, so an emptied round would otherwise sit
 * there live and empty: an empty ticket on the kitchen board, and an order
 * pinned to that round's status for ever because the derivation still counts
 * it. It has to be cancelled, and then orders.status follows on its own.
 *
 * Seeding and the assertions run as the admin role — what is asserted is the
 * function's arithmetic, not who may see it. The cancellation itself goes
 * through a menu_app connection, because that is the role the API calls it
 * with and the one the GRANT is written for.
 */
const ADMIN_URL = process.env.DIRECT_URL!;
const APP_URL = process.env.APP_DATABASE_URL || process.env.DATABASE_URL!;

let admin: Client;
let app: Client;
let owner: string, biz: string, chai: string, biryani: string;

async function freshTable(): Promise<string> {
  const t = await admin.query(
    `INSERT INTO tables (id, business_id, label, token, position)
     VALUES (gen_random_uuid(), $1, '1', $2, 1) RETURNING id`,
    [biz, Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32)],
  );
  return t.rows[0].id as string;
}

/** One round of one dish, placed the way a diner places it. */
async function place(tableId: string, itemId: string): Promise<void> {
  await admin.query(`SELECT place_table_round($1, $2, $3::jsonb)`, [
    tableId,
    biz,
    JSON.stringify([{ itemId, variantId: null, quantity: 1 }]),
  ]);
}

interface Round {
  id: string;
  seq: number;
  status: string;
  itemId: string;
}

/** Every round on a table's open order, newest last, with its one dish. */
async function roundsAt(tableId: string): Promise<Round[]> {
  const r = await admin.query(
    `SELECT r.id, r.seq, r.status::text AS status, i.id AS "itemId"
     FROM order_rounds r
     JOIN orders o ON o.id = r.order_id
     LEFT JOIN order_items i ON i.round_id = r.id
     WHERE o.table_id = $1
     ORDER BY r.seq`,
    [tableId],
  );
  return r.rows as Round[];
}

async function orderStatusAt(tableId: string): Promise<string> {
  const r = await admin.query(
    `SELECT status::text AS s FROM orders WHERE table_id = $1`,
    [tableId],
  );
  return r.rows[0].s as string;
}

/**
 * A table whose biryani is already ready and whose chai has just gone in.
 * The whole point of the change is that these two dishes get different
 * answers, so almost every test here starts from this shape.
 */
async function readyBiryaniAndFreshChai(): Promise<string> {
  const tableId = await freshTable();
  await place(tableId, biryani);
  await admin.query(
    `UPDATE order_rounds SET status = 'ready'
     WHERE order_id = (SELECT id FROM orders WHERE table_id = $1)`,
    [tableId],
  );
  await place(tableId, chai);
  return tableId;
}

function cancel(tableId: string, lines: { orderItemId: string; quantity: number }[] | null) {
  return app.query(
    `SELECT cancel_table_order($1::uuid, $2::jsonb, 'changed_mind'::text, NULL::text) AS r`,
    [tableId, lines === null ? null : JSON.stringify(lines)],
  );
}

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();

  const u = await admin.query(
    `INSERT INTO users (id, pin_hash, full_name, phone, verified_at, updated_at)
     VALUES (gen_random_uuid(), 'x', 'Cancel Round Owner', $1, now(), now()) RETURNING id`,
    [`+9199${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`],
  );
  owner = u.rows[0].id;

  // cancellation_statuses keeps its default of ['placed'] deliberately: it is
  // the owner policy almost everyone runs, and the one under which the order
  // and the round disagree. The window is opened wide so a slow run can never
  // fail a test for the wrong reason.
  const b = await admin.query(
    `INSERT INTO businesses
       (id, owner_id, name, public_code, type, currency,
        cancellation_enabled, cancellation_window_mins, updated_at)
     VALUES (gen_random_uuid(), $1, 'Cancel Round Test', $2, 'restaurant', 'INR',
             true, 120, now())
     RETURNING id`,
    [owner, Math.random().toString(36).slice(2, 10).toUpperCase()],
  );
  biz = b.rows[0].id;

  const cat = await admin.query(
    `INSERT INTO menu_categories (id, business_id, name, position)
     VALUES (gen_random_uuid(), $1, 'All day', 0) RETURNING id`,
    [biz],
  );
  const mk = async (name: string, price: string) => {
    const i = await admin.query(
      `INSERT INTO menu_items (id, business_id, category_id, name, price, is_available, position, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4::numeric, true, 0, now()) RETURNING id`,
      [biz, cat.rows[0].id, name, price],
    );
    return i.rows[0].id as string;
  };
  chai = await mk("Irani Chai", "30.00");
  biryani = await mk("Dum Biryani", "320.00");

  app = new Client({ connectionString: APP_URL });
  await app.connect();
});

afterAll(async () => {
  await app.end();
  await admin.query("DELETE FROM businesses WHERE id = $1", [biz]);
  await admin.query("DELETE FROM users WHERE id = $1", [owner]);
  await admin.end();
});

describe("cancel_table_order", () => {
  it("lets a diner call back the round they just ordered", async () => {
    const tableId = await readyBiryaniAndFreshChai();
    const [biryaniRound, chaiRound] = await roundsAt(tableId);

    await cancel(tableId, [{ orderItemId: chaiRound.itemId, quantity: 1 }]);

    const rounds = await roundsAt(tableId);
    expect(rounds[1].itemId).toBeNull();
    expect(rounds[0].itemId).toBe(biryaniRound.itemId);
  });

  it("refuses a dish whose own round has gone past what the owner allows", async () => {
    const tableId = await readyBiryaniAndFreshChai();
    const [biryaniRound] = await roundsAt(tableId);

    // The order reads 'placed' because the chai is: asking the order would
    // let this through and the pass would plate a dish nobody is paying for.
    expect(await orderStatusAt(tableId)).toBe("placed");

    await expect(
      cancel(tableId, [{ orderItemId: biryaniRound.itemId, quantity: 1 }]),
    ).rejects.toThrow(/too far to cancel/);

    expect((await roundsAt(tableId))[0].itemId).toBe(biryaniRound.itemId);
  });

  it("cancels an emptied round and lets the rest of the order carry the status", async () => {
    const tableId = await readyBiryaniAndFreshChai();
    const [, chaiRound] = await roundsAt(tableId);

    await cancel(tableId, [{ orderItemId: chaiRound.itemId, quantity: 1 }]);

    // Left live, the empty round would print as a blank ticket and hold the
    // order at 'placed' for ever — nothing else would ever move it.
    const rounds = await roundsAt(tableId);
    expect(rounds[1].status).toBe("cancelled");
    expect(rounds[1].itemId).toBeNull();
    expect(await orderStatusAt(tableId)).toBe("ready");
  });

  it("takes the whole order down through its rounds, not by hand", async () => {
    const tableId = await freshTable();
    await place(tableId, biryani);
    await place(tableId, chai);

    const res = await cancel(tableId, null);

    expect(res.rows[0].r.orderCancelled).toBe(true);
    const rounds = await roundsAt(tableId);
    expect(rounds.map((r) => r.status)).toEqual(["cancelled", "cancelled"]);
    expect(await orderStatusAt(tableId)).toBe("cancelled");
  });
});
