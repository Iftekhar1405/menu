import { describe, expect, it } from "vitest";
import type { Bill } from "../billing/billing.service";
import { billTicketFrom, kitchenTicketFrom, tokenTicketFrom, type TicketSource } from "./ticket-payload";

const src: TicketSource = {
  businessName: "Taste of Hyderabad",
  order: { dailyNumber: 14, note: null, isRunning: false, tableLabel: "7" },
  round: {
    seq: 2,
    kotNumber: 38,
    placedAt: new Date("2026-10-04T15:36:00.000Z"),
    items: [
      { quantity: 2, nameSnapshot: "Irani Chai", variantSnapshot: null },
      { quantity: 1, nameSnapshot: "Osmania Biscuit", variantSnapshot: null },
    ],
  },
};

const bill: Bill = {
  id: "bill1",
  billNumber: 208,
  tableLabel: "7",
  issuedAt: "2026-10-04T16:01:00.000Z",
  currency: "INR",
  taxLabel: "GST",
  pricesIncludeTax: true,
  business: {
    name: "Taste of Hyderabad",
    gstin: "36AABCT1234K1Z5",
    logoPath: null,
    addressLine1: "12-3-45 Banjara Hills",
    addressLine2: null,
    city: "Hyderabad",
    state: null,
    postalCode: "500034",
  },
  receiptFooter: "Thank you",
  subtotal: "1223.81",
  taxTotal: "61.19",
  serviceCharge: "0.00",
  serviceChargeRate: "0",
  roundOff: "0.00",
  total: "1290.00",
  lines: [
    { id: "l1", name: "Chicken Biryani", variant: "Full", quantity: 2, unitPrice: "320.00", lineTotal: "640.00", taxRate: "5.00", taxAmount: "30.48" },
    { id: "l2", name: "Irani Chai", variant: null, quantity: 2, unitPrice: "30.00", lineTotal: "60.00", taxRate: "5.00", taxAmount: "2.86" },
  ],
};

describe("tokenTicketFrom", () => {
  it("carries the order's daily number as the token, not the round's", async () => {
    // The customer is given one number for the whole table, whatever
    // round they are on. Handing them a new number per round would make
    // the counter unable to match the slip to the food.
    expect(tokenTicketFrom(src)).toMatchObject({ kind: "token", token: 14, seq: 2 });
  });

  it("produces every field, not just token and seq", () => {
    // The test above uses toMatchObject and only pins token/seq, so
    // businessName, tableLabel and the Date-to-ISO conversion of `at` could
    // each be dropped, hardcoded, or swapped and still pass it.
    expect(tokenTicketFrom(src)).toEqual({
      kind: "token",
      businessName: "Taste of Hyderabad",
      token: 14,
      seq: 2,
      tableLabel: "7",
      at: "2026-10-04T15:36:00.000Z",
    });
  });
});

describe("kitchenTicketFrom", () => {
  it("carries this round's items, the KOT number and the running flag", () => {
    const t = kitchenTicketFrom({
      ...src,
      order: { ...src.order, isRunning: true },
    });
    expect(t).toMatchObject({ kind: "kitchen", token: 14, kotNumber: 38, seq: 2, isRunning: true });
    expect(t.items).toEqual([
      { quantity: 2, name: "Irani Chai", variant: null },
      { quantity: 1, name: "Osmania Biscuit", variant: null },
    ]);
  });

  it("passes the order's note through, since items have none", () => {
    const t = kitchenTicketFrom({ ...src, order: { ...src.order, note: "less spicy" } });
    expect(t.note).toBe("less spicy");
  });

  it("produces every field, not just the ones checked above", () => {
    // Neither test above touches tableLabel or `at`; both could be dropped
    // or hardcoded and the suite would stay green.
    expect(kitchenTicketFrom(src)).toEqual({
      kind: "kitchen",
      token: 14,
      tableLabel: "7",
      kotNumber: 38,
      seq: 2,
      isRunning: false,
      note: null,
      at: "2026-10-04T15:36:00.000Z",
      items: [
        { quantity: 2, name: "Irani Chai", variant: null },
        { quantity: 1, name: "Osmania Biscuit", variant: null },
      ],
    });
  });
});

describe("billTicketFrom", () => {
  it("names the tax rate when every line shares one", () => {
    // "GST 5% (incl.)" is only honest if 5% is what every line was charged.
    expect(billTicketFrom(bill, 14).taxLine).toBe("GST 5% (incl.)");
  });

  it("drops the rate when the lines disagree", () => {
    // A price change mid-meal snapshots two different rates. Naming one of
    // them on the paper would state a rate the customer was not charged.
    const mixed: Bill = {
      ...bill,
      lines: [bill.lines[0]!, { ...bill.lines[1]!, taxRate: "12.00" }],
    };
    expect(billTicketFrom(mixed, 14).taxLine).toBe("GST");
  });

  it("omits the tax line entirely when there is no tax", () => {
    expect(billTicketFrom({ ...bill, taxTotal: "0.00" }, 14).taxLine).toBeNull();
  });

  it("says excl. when prices do not include tax", () => {
    expect(billTicketFrom({ ...bill, pricesIncludeTax: false }, 14).taxLine).toBe("GST 5% (excl.)");
  });

  it("folds the address into lines, skipping the parts that are not set", () => {
    // Most venues fill in two of these six fields. Blank lines on a
    // receipt look like a broken printer.
    expect(billTicketFrom(bill, 14).addressLines).toEqual([
      "12-3-45 Banjara Hills",
      "Hyderabad 500034",
    ]);
  });

  it("joins city and state with a comma when both are set", () => {
    // The fixture above only ever supplies one of city/state at a time, so
    // it cannot tell a `", "` join from a plain concatenation or a space.
    // This is the one case that actually exercises the separator.
    const withState: Bill = {
      ...bill,
      business: { ...bill.business, state: "Telangana" },
    };
    expect(billTicketFrom(withState, 14).addressLines).toEqual([
      "12-3-45 Banjara Hills",
      "Hyderabad, Telangana 500034",
    ]);
  });

  it("produces no address lines at all when the business has no address on file", () => {
    const bare: Bill = {
      ...bill,
      business: {
        name: "Taste of Hyderabad",
        gstin: null,
        logoPath: null,
        addressLine1: null,
        addressLine2: null,
        city: null,
        state: null,
        postalCode: null,
      },
    };
    expect(billTicketFrom(bare, 14).addressLines).toEqual([]);
    expect(billTicketFrom(bare, 14).gstin).toBeNull();
  });

  it("carries the token so the paper matches the slip in the hand", () => {
    expect(billTicketFrom(bill, 14).token).toBe(14);
  });

  it("produces every pass-through field untouched, not just the ones exercised above", () => {
    // taxLine, addressLines and token are each covered by their own branch
    // test above. Nothing else on BillTicket — businessName, gstin,
    // billNumber, tableLabel, issuedAt, receiptFooter, serviceCharge,
    // serviceChargeRate, roundOff, or a line's name/variant/quantity — was
    // checked anywhere, so any one of them could be hardcoded or swapped
    // for another field and every other test would still pass.
    expect(billTicketFrom(bill, 14)).toEqual({
      kind: "bill",
      businessName: "Taste of Hyderabad",
      addressLines: ["12-3-45 Banjara Hills", "Hyderabad 500034"],
      gstin: "36AABCT1234K1Z5",
      billNumber: 208,
      tableLabel: "7",
      token: 14,
      issuedAt: "2026-10-04T16:01:00.000Z",
      taxLine: "GST 5% (incl.)",
      subtotal: "1223.81",
      taxTotal: "61.19",
      serviceCharge: "0.00",
      serviceChargeRate: "0",
      roundOff: "0.00",
      total: "1290.00",
      receiptFooter: "Thank you",
      lines: [
        { name: "Chicken Biryani", variant: "Full", quantity: 2, unitPrice: "320.00", lineTotal: "640.00" },
        { name: "Irani Chai", variant: null, quantity: 2, unitPrice: "30.00", lineTotal: "60.00" },
      ],
    });
  });

  it("carries subtotal, tax and total through unchanged, even though they do not add up", () => {
    // 1223.81 + 61.19 = 1285.00, not the bill's 1290.00 total — the
    // difference is exactly the point of this fixture. generate_bill is the
    // only place allowed to do that arithmetic; this mapping must carry the
    // string across as-is. A recompute here would silently "fix" the total
    // to 1285.00 and the test would catch it.
    const t = billTicketFrom(bill, 14);
    expect(t.subtotal).toBe("1223.81");
    expect(t.taxTotal).toBe("61.19");
    expect(t.total).toBe("1290.00");
  });

  it("carries each line's total through unchanged even when it disagrees with quantity times unit price", () => {
    // 3 x "100.00" is naively "300.00"; this line's snapshot says "250.00"
    // (a discount applied at order time). Recomputing from quantity and
    // unit price instead of carrying lineTotal across would print a total
    // the customer was never actually charged.
    const discounted: Bill = {
      ...bill,
      lines: [{ id: "l3", name: "Combo", variant: null, quantity: 3, unitPrice: "100.00", lineTotal: "250.00", taxRate: "5.00", taxAmount: "11.90" }],
    };
    expect(billTicketFrom(discounted, 14).lines).toEqual([
      { name: "Combo", variant: null, quantity: 3, unitPrice: "100.00", lineTotal: "250.00" },
    ]);
  });
});
