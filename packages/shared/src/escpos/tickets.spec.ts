import { describe, expect, it } from "vitest";
import { encodeTicket, type BillTicket, type KitchenTicket, type TokenTicket } from "./tickets";

/**
 * Bytes back to the lines a human would read off the paper.
 *
 * Golden-byte assertions on a 48-column ticket are unreadable and unfixable
 * when they break — nobody can see from a hex diff that a dish name moved
 * one column. So escape sequences are stripped and the text asserted
 * exactly, which is the part that goes wrong; the escapes that matter (the
 * double-size token) get their own byte assertion below.
 */
function decode(bytes: Uint8Array): string[] {
  const out: string[] = [];
  let line = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    // Skip counts are exact on purpose: one byte too many eats the space
    // after a size change, and the assertion then fails for a reason that
    // has nothing to do with the layout.
    if (b === 0x1b) { i += bytes[i + 1] === 0x40 ? 1 : 2; continue; } // ESC @ (2) / ESC x n (3)
    if (b === 0x1d) { i += bytes[i + 1] === 0x56 ? 3 : 2; continue; } // GS V A 0 (4) / GS x n (3)
    if (b === 0x0a) { out.push(line); line = ""; continue; }
    line += String.fromCharCode(b);
  }
  if (line) out.push(line);
  // The blank lines the cut feeds through the blade are not content.
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

const token: TokenTicket = {
  kind: "token",
  businessName: "Taste of Hyderabad",
  token: 14,
  seq: 1,
  tableLabel: "7",
  at: "2026-10-04T15:12:00.000Z", // 8:42 PM IST
};

describe("encodeTicket: token slip", () => {
  it("prints the approved 58mm slip", () => {
    expect(decode(encodeTicket(token, 58))).toEqual([
      " ".repeat(7) + "Taste of Hyderabad",
      "",
      " ".repeat(13) + "TOKEN",
      " ".repeat(7) + "14",
      "",
      " ".repeat(12) + "Table 7",
      " ".repeat(8) + "04 Oct, 8:42 pm",
      "",
      "=".repeat(32),
      " ".repeat(5) + "Please keep this slip",
    ]);
  });

  it("prints the token double-size and turns the size back off", () => {
    // The point of the slip is a number readable across a counter — and the
    // point of the reset is that the table, the time and the footer are not.
    //
    // The reset needs its own assertion because no text assertion can see
    // it: decode() strips every GS ! triple whatever its parameter, so a
    // ticket missing the reset decodes to exactly the same lines while
    // printing everything after the token at double size.
    const bytes = Array.from(encodeTicket(token, 58));
    const at = bytes.findIndex(
      (_, i) => bytes[i] === 0x1d && bytes[i + 1] === 0x21 && bytes[i + 2] === 0x11,
    );
    expect(at).toBeGreaterThan(-1);

    const after = bytes.slice(at + 3);
    const eol = after.indexOf(0x0a);
    expect(String.fromCharCode(...after.slice(0, eol))).toContain("14");
    // Immediately after the token's own line, and nowhere later.
    expect(after.slice(eol + 1, eol + 4)).toEqual([0x1d, 0x21, 0x00]);
  });

  it("names the round only from the second one on", () => {
    // Round 1 is just "the order". Labelling it would make every single
    // -round table look like it was part of something longer.
    expect(decode(encodeTicket(token, 58))).not.toContain(" ".repeat(12) + "Round 1");

    const second = decode(encodeTicket({ ...token, seq: 2 }, 58));
    expect(second).toContain(" ".repeat(12) + "Round 2");
  });

  it("centres against 48 columns on an 80mm roll", () => {
    // Width is a property of the output, not the ticket.
    const wide = decode(encodeTicket(token, 80));
    expect(wide[0]).toBe(" ".repeat(15) + "Taste of Hyderabad");
    expect(wide).toContain("=".repeat(48));
  });

  it("carries no dishes and no prices", () => {
    const text = decode(encodeTicket(token, 58)).join("\n");
    expect(text).not.toMatch(/\d+\.\d\d/);
  });
});

const kitchen: KitchenTicket = {
  kind: "kitchen",
  token: 14,
  tableLabel: "7",
  kotNumber: 31,
  seq: 1,
  isRunning: false,
  note: null,
  at: "2026-10-04T15:12:00.000Z",
  items: [
    { quantity: 2, name: "Chicken Biryani", variant: "Full" },
    { quantity: 1, name: "Mutton Haleem", variant: null },
    { quantity: 3, name: "Butter Naan", variant: null },
    { quantity: 1, name: "Hyderabadi Double Ka Meetha", variant: null },
  ],
};

describe("encodeTicket: kitchen ticket", () => {
  it("prints the approved 80mm ticket", () => {
    expect(decode(encodeTicket(kitchen, 80))).toEqual([
      "=".repeat(48),
      "TOKEN 14                                 TABLE 7",
      "8:42 pm                                  KOT #31",
      "=".repeat(48),
      "",
      "2 x Chicken Biryani",
      "    (Full)",
      "1 x Mutton Haleem",
      "3 x Butter Naan",
      "1 x Hyderabadi Double Ka Meetha",
      "",
      "-".repeat(48),
      "Items                                          7",
    ]);
  });

  it("banners a later round, and says when the table is running", () => {
    // The pass has to see at a glance that this is an addition to a table
    // already eating, not a new table. The em dash folds to a hyphen in the
    // printer's codepage, which is expected.
    const second = decode(
      encodeTicket(
        {
          ...kitchen,
          seq: 2,
          kotNumber: 38,
          isRunning: true,
          at: "2026-10-04T15:36:00.000Z",
          items: [
            { quantity: 2, name: "Irani Chai", variant: null },
            { quantity: 1, name: "Osmania Biscuit", variant: null },
          ],
        },
        80,
      ),
    );
    expect(second[2]).toBe("          *** ROUND 2 - NEW ITEMS ***");
    expect(second[3]).toBe("              ** RUNNING TABLE **");
    expect(second[4]).toBe("9:06 pm                                  KOT #38");
  });

  it("prints only the items it was given", () => {
    // Round 2's ticket must not reprint round 1. The round is the unit of
    // cooking; a reprint would have the kitchen make the biryani twice.
    const second = decode(
      encodeTicket({ ...kitchen, seq: 2, items: [{ quantity: 2, name: "Irani Chai", variant: null }] }, 80),
    );
    expect(second.join("\n")).not.toContain("Biryani");
    expect(second).toContain("Items                                          2");
  });

  it("prints the order's note once, below the items", () => {
    const withNote = decode(encodeTicket({ ...kitchen, note: "less spicy" }, 80));
    expect(withNote).toContain(">> less spicy");
    expect(withNote.filter((l) => l.startsWith(">>"))).toHaveLength(1);
  });

  it("carries no prices", () => {
    // The kitchen role never sees money anywhere else in this product, and
    // paper is not an exception.
    expect(decode(encodeTicket(kitchen, 80)).join("\n")).not.toMatch(/\d+\.\d\d/);
  });

  it("turns double height back off after the items", () => {
    // Item lines print double-height so they read over a pass; the note and
    // the item count must not. Like the token slip's reset, this needs a
    // byte assertion — decode() strips every GS ! triple whatever its
    // parameter, so deleting the reset changes no decoded line while
    // printing the rest of the ticket at double height on real hardware.
    const bytes = Array.from(encodeTicket(kitchen, 80));
    const on = bytes.findIndex(
      (_, i) => bytes[i] === 0x1d && bytes[i + 1] === 0x21 && bytes[i + 2] === 0x01,
    );
    expect(on).toBeGreaterThan(-1);

    // The reset lands immediately after the last item's newline, so this
    // four-byte run exists only if the items ended and the size was reset.
    const seq = [0x0a, 0x1d, 0x21, 0x00];
    const at = bytes.findIndex((_, i) => seq.every((b, k) => bytes[i + k] === b));
    expect(at).toBeGreaterThan(on);
  });

  it("does not merge identical dishes", () => {
    // The bill merges across rounds; the ticket never does. Two is what the
    // kitchen has to cook, and a merged line would hide one of them.
    const out = decode(
      encodeTicket(
        {
          ...kitchen,
          items: [
            { quantity: 1, name: "Dum Biryani", variant: null },
            { quantity: 2, name: "Dum Biryani", variant: null },
          ],
        },
        80,
      ),
    );
    expect(out.filter((l) => l.includes("Dum Biryani"))).toHaveLength(2);
  });
});

const bill: BillTicket = {
  kind: "bill",
  businessName: "Taste of Hyderabad",
  addressLines: ["12-3-45 Banjara Hills, Hyderabad 500034"],
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
  receiptFooter: "Thank you — see you again!",
  lines: [
    { name: "Chicken Biryani", variant: "Full", quantity: 2, unitPrice: "320.00", lineTotal: "640.00" },
    { name: "Mutton Haleem", variant: null, quantity: 1, unitPrice: "280.00", lineTotal: "280.00" },
    { name: "Butter Naan", variant: null, quantity: 3, unitPrice: "45.00", lineTotal: "135.00" },
    { name: "Hyderabadi Double Ka Meetha", variant: null, quantity: 1, unitPrice: "150.00", lineTotal: "150.00" },
    { name: "Irani Chai", variant: null, quantity: 2, unitPrice: "30.00", lineTotal: "60.00" },
    { name: "Osmania Biscuit", variant: null, quantity: 1, unitPrice: "25.00", lineTotal: "25.00" },
  ],
};

describe("encodeTicket: bill slip", () => {
  it("prints the approved 80mm bill", () => {
    expect(decode(encodeTicket(bill, 80))).toEqual([
      " ".repeat(15) + "Taste of Hyderabad",
      "    12-3-45 Banjara Hills, Hyderabad 500034",
      "             GSTIN 36AABCT1234K1Z5",
      "",
      "Bill #208                                Table 7",
      "Token 14                         04 Oct, 9:31 pm",
      "=".repeat(48),
      "Chicken Biryani                           640.00",
      "   2 x 320.00 - Full",
      "Mutton Haleem                             280.00",
      "   1 x 280.00",
      "Butter Naan                               135.00",
      "   3 x 45.00",
      "Hyderabadi Double Ka Meetha               150.00",
      "   1 x 150.00",
      "Irani Chai                                 60.00",
      "   2 x 30.00",
      "Osmania Biscuit                            25.00",
      "   1 x 25.00",
      "-".repeat(48),
      "Subtotal                                 1223.81",
      "GST 5% (incl.)                             61.19",
      "=".repeat(48),
      "TOTAL                                    1290.00",
      "=".repeat(48),
      "",
      "   This is a receipt, not a GST tax invoice.",
      "",
      "           Thank you - see you again!",
    ]);
  });

  it("ties the paper to the slip in the customer's hand", () => {
    // Without the token there is nothing connecting this bill to the
    // numbered slip the customer is holding.
    expect(decode(encodeTicket(bill, 80)).join("\n")).toContain("Token 14");
  });

  it("prints the service charge with the sentence that must accompany it", () => {
    // Legally load-bearing, and already on the screen and the PDF. Paper
    // cannot be the one place it is missing.
    const out = decode(
      encodeTicket({ ...bill, serviceCharge: "64.50", serviceChargeRate: "5", total: "1354.50" }, 80),
    ).join("\n");
    expect(out).toContain("Service charge 5%");
    expect(out).toContain("64.50");
    expect(out).toMatch(/voluntary/i);
  });

  it("omits the service charge entirely when it is off", () => {
    // Off by default, and a "Service charge 0.00" line reads like a bug.
    expect(decode(encodeTicket(bill, 80)).join("\n")).not.toMatch(/Service charge/i);
  });

  it("prints a round-off only when there is one", () => {
    expect(decode(encodeTicket(bill, 80)).join("\n")).not.toMatch(/Round off/i);
    const rounded = decode(encodeTicket({ ...bill, roundOff: "-0.19" }, 80)).join("\n");
    expect(rounded).toContain("Round off");
  });

  it("fits every roll it can be printed on, service charge or not", () => {
    // A bill is the longest ticket and a line past the edge is not
    // truncated by the printer, it is silently lost.
    //
    // Both fixtures, because the base one has the service charge switched
    // off and "Service charge is voluntary. Ask us to remove it." is 49
    // characters — longer than even an 80mm roll. Checking only the
    // default bill would leave the one sentence that MUST wrap unexercised
    // at either width.
    const withService: BillTicket = {
      ...bill,
      serviceCharge: "64.50",
      serviceChargeRate: "5",
      total: "1354.50",
    };

    for (const t of [bill, withService]) {
      for (const width of [58, 80] as const) {
        for (const line of decode(encodeTicket(t, width))) {
          expect(line.length).toBeLessThanOrEqual(width === 80 ? 48 : 32);
        }
      }
    }
  });

  it("turns bold back off after the total", () => {
    // The third reset in this file to need a byte assertion, for the same
    // reason as the other two: decode() strips every ESC E whatever its
    // parameter, so a missing reset prints the disclaimer, the voluntary
    // notice and the footer in bold while every text assertion still
    // passes.
    const bytes = Array.from(encodeTicket(bill, 80));
    const on = bytes.findIndex(
      (_, i) => bytes[i] === 0x1b && bytes[i + 1] === 0x45 && bytes[i + 2] === 0x01,
    );
    expect(on).toBeGreaterThan(-1);

    // Immediately after the TOTAL line's newline.
    const seq = [0x0a, 0x1b, 0x45, 0x00];
    const at = bytes.findIndex((_, i) => seq.every((b, k) => bytes[i + k] === b));
    expect(at).toBeGreaterThan(on);
  });
});
