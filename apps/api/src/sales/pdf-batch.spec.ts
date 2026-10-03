import { NotFoundException } from "@nestjs/common";
import { unzipSync, strFromU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { assertAllFound, billPdfName, zipPdfs } from "./pdf-batch";

describe("pdf batch", () => {
  it("names bills with a zero-padded number so they sort", () => {
    expect(billPdfName(7)).toBe("bill-000007.pdf");
    expect(billPdfName(1234567)).toBe("bill-1234567.pdf");
  });

  it("zips files that unzip back to the same bytes", () => {
    const zip = zipPdfs([
      { name: "bill-000001.pdf", bytes: new TextEncoder().encode("%PDF-one") },
      { name: "bill-000002.pdf", bytes: new TextEncoder().encode("%PDF-two") },
    ]);
    const out = unzipSync(zip);
    expect(Object.keys(out).sort()).toEqual(["bill-000001.pdf", "bill-000002.pdf"]);
    expect(strFromU8(out["bill-000002.pdf"]!)).toBe("%PDF-two");
  });

  it("refuses the whole batch if any id was not found", () => {
    expect(() => assertAllFound(["a", "b"], [{ id: "a" }])).toThrow(NotFoundException);
    expect(() => assertAllFound(["a", "a"], [{ id: "a" }])).not.toThrow();
  });
});
