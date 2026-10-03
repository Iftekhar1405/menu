import { describe, expect, it } from "vitest";
import { dailyCsv, itemsCsv, localParts, registerCsv, toCsv } from "./csv";
import type { ExportBill } from "./types";

const bill = (over: Partial<ExportBill> = {}): ExportBill => ({
  id: "b1", billNumber: 12, issuedAt: "2026-10-01T19:00:00.000Z", tableLabel: "Screen 2, Row F",
  paymentMode: "upi", paidAt: "2026-10-01T19:10:00.000Z", subtotal: "100.00", taxTotal: "5.00",
  serviceCharge: "0.00", roundOff: "0.00", total: "105.00", pricesIncludeTax: true, taxLabel: "GST", gstin: null,
  lines: [{ name: 'Tea "masala"', variant: "Large", category: "Drinks", quantity: 2, unitPrice: "52.50",
    lineTotal: "105.00", lineNet: "100.00", taxRate: "5.00", taxAmount: "5.00" }],
  ...over,
});

describe("toCsv", () => {
  it("starts with a BOM, uses CRLF, and quotes commas, quotes and newlines", () => {
    const out = toCsv([["a", 'say "hi"', "x,y", "line\nbreak", null, 3]]);
    expect(out.startsWith("﻿")).toBe(true);
    expect(out).toBe('﻿a,"say ""hi""","x,y","line\nbreak",,3\r\n');
  });
  it("neutralises spreadsheet formulas", () => {
    expect(toCsv([["=SUM(A1)"]])).toBe("﻿'=SUM(A1)\r\n");
  });
});

describe("localParts", () => {
  it("puts an after-midnight IST bill on the IST date", () => {
    expect(localParts("2026-10-01T19:00:00.000Z", "Asia/Kolkata")).toEqual({ date: "2026-10-02", time: "00:30" });
  });
});

describe("registerCsv", () => {
  it("has the agreed header and one row per bill", () => {
    const lines = registerCsv([bill(), bill({ id: "b2", billNumber: 13, paymentMode: null, paidAt: null })], "Asia/Kolkata")
      .replace("﻿", "").trim().split("\r\n");
    expect(lines[0]).toBe("Bill No,Date,Time,Table,Status,Payment Mode,Paid At,Items,Subtotal,Tax,Service Charge,Round Off,Total,Prices Include Tax,Tax Label,GSTIN");
    expect(lines[1]).toBe('12,2026-10-02,00:30,"Screen 2, Row F",Paid,UPI,2026-10-02 00:40,2,100.00,5.00,0.00,0.00,105.00,Yes,GST,');
    expect(lines[2]).toContain(",Unpaid,,,");
  });
});

describe("itemsCsv", () => {
  it("has one row per line with category", () => {
    const lines = itemsCsv([bill()], "Asia/Kolkata").replace("﻿", "").trim().split("\r\n");
    expect(lines[0]).toBe("Bill No,Date,Item,Variant,Category,Qty,Unit Price,Line Total,Net,Tax Rate %,Tax Amount");
    expect(lines[1]).toBe('12,2026-10-02,"Tea ""masala""",Large,Drinks,2,52.50,105.00,100.00,5.00,5.00');
  });
});

describe("dailyCsv", () => {
  it("sums per local day with a mode split and a total row", () => {
    const out = dailyCsv(
      [bill(), bill({ id: "b2", billNumber: 13, paymentMode: "cash", total: "50.00", subtotal: "47.62", taxTotal: "2.38" })],
      "Asia/Kolkata",
    ).replace("﻿", "").trim().split("\r\n");
    expect(out[0]).toBe("Date,Bills,Gross,Net,Tax,Service Charge,Round Off,Cash,UPI,Card,Other,Unpaid");
    expect(out[1]).toBe("2026-10-02,2,155.00,147.62,7.38,0.00,0.00,50.00,105.00,0.00,0.00,0.00");
    expect(out.at(-1)).toBe("Total,2,155.00,147.62,7.38,0.00,0.00,50.00,105.00,0.00,0.00,0.00");
  });
});
