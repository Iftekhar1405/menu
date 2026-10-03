import { ConflictException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { OrdersService } from "./orders.service";

type FakeOrder = { id: string; status: string; completedAt: Date | null; tableId: string };

/** `reread` is what a second read returns — the order as it stands once the lock is held. */
function setup(order: FakeOrder | null, updatedCount = 1, reread?: FakeOrder) {
  const calls: string[] = [];
  let reads = 0;
  const db = {
    order: {
      findFirst: vi.fn(async () => (reads++ > 0 && reread ? reread : order)),
      updateMany: vi.fn(async () => {
        calls.push("order.updateMany");
        return { count: updatedCount };
      }),
      findUniqueOrThrow: vi.fn(async () => ({ ...order, status: "paid", table: { id: "t", label: "1" }, items: [], cancellations: [] })),
    },
    bill: {
      updateMany: vi.fn(async () => {
        calls.push("bill.updateMany");
        return { count: 1 };
      }),
      findFirstOrThrow: vi.fn(async () => ({
        id: "b", billNumber: 1, tableLabel: "1", issuedAt: new Date(), currency: "INR", taxLabel: "GST",
        pricesIncludeTax: true, businessSnapshot: {}, receiptFooter: null, subtotal: "100", taxTotal: "5",
        serviceCharge: "0", serviceChargeRate: "0", roundOff: "0", total: "105", lines: [],
        paymentMode: "upi", paidAt: new Date(),
      })),
    },
    $queryRaw: vi.fn(async () => {
      calls.push("generate_bill");
      return [];
    }),
    $executeRaw: vi.fn(async () => {
      calls.push("table_lock");
      return 1;
    }),
  };
  const service = new OrdersService(
    { db } as never,
    { assertOwns: vi.fn(async () => ({ id: "biz" })) } as never,
    {} as never,
    { announceStatus: vi.fn(async () => undefined) } as never,
  );
  return { service, db, calls };
}

describe("markPaid", () => {
  it("bills, records the mode, then closes the order — in that order", async () => {
    const { service, calls, db } = setup({ id: "o", status: "completed", completedAt: new Date(), tableId: "t" });
    await service.markPaid("u", "biz", "o", "upi");
    expect(calls).toEqual(["table_lock", "generate_bill", "bill.updateMany", "order.updateMany"]);
    expect(db.bill.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderId: "o", businessId: "biz", paidAt: null } }),
    );
  });

  it("sets the served time when a counter order is paid straight from open", async () => {
    const { service, db } = setup({ id: "o", status: "placed", completedAt: null, tableId: "t" });
    await service.markPaid("u", "biz", "o", "cash");
    const arg = (db.order.updateMany.mock.calls as unknown as [{ data: { completedAt: Date } }][])[0]![0];
    expect(arg.data.completedAt).toBeInstanceOf(Date);
  });

  it("refuses a cancelled order and an already-paid one", async () => {
    await expect(setup({ id: "o", status: "cancelled", completedAt: null, tableId: "t" }).service.markPaid("u", "biz", "o", "cash"))
      .rejects.toBeInstanceOf(ConflictException);
    await expect(setup({ id: "o", status: "paid", completedAt: new Date(), tableId: "t" }).service.markPaid("u", "biz", "o", "cash"))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it("loses a race cleanly: the second tap gets 409", async () => {
    const { service } = setup({ id: "o", status: "completed", completedAt: new Date(), tableId: "t" }, 0);
    await expect(service.markPaid("u", "biz", "o", "card")).rejects.toBeInstanceOf(ConflictException);
  });

  it("404s an order that is not this business's", async () => {
    await expect(setup(null).service.markPaid("u", "biz", "o", "cash")).rejects.toBeInstanceOf(NotFoundException);
  });

  // Same lock place_table_round takes: a diner's new round cannot slip into
  // an order between the read and the write, and two Paid taps on an unbilled
  // order queue instead of racing generate_bill into a duplicate-bill 500.
  it("decides under the table's lock, using the status as it stands once locked", async () => {
    const { service, calls } = setup(
      { id: "o", status: "placed", completedAt: null, tableId: "t" },
      1,
      { id: "o", status: "paid", completedAt: new Date(), tableId: "t" },
    );
    await expect(service.markPaid("u", "biz", "o", "cash")).rejects.toBeInstanceOf(ConflictException);
    expect(calls).toEqual(["table_lock"]);
  });
});

describe("setStatus", () => {
  // Without a guard, Accept read before a Paid commits and written after it
  // would reopen a paid order.
  it("refuses when someone else changed the order first", async () => {
    const { service } = setup({ id: "o", status: "placed", completedAt: null, tableId: "t" }, 0);
    await expect(service.setStatus("u", "biz", "o", "accepted")).rejects.toBeInstanceOf(ConflictException);
  });
});
