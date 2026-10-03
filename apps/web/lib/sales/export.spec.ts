import { strFromU8, unzipSync, zipSync, strToU8 } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { exportFileName, runExport } from "./export";
import type { ExportBill, ExportPage } from "./types";

const mk = (n: number): ExportBill => ({
  id: `id${n}`, billNumber: n, issuedAt: "2026-10-02T06:00:00.000Z", tableLabel: "1", paymentMode: "cash",
  paidAt: "2026-10-02T06:05:00.000Z", subtotal: "10.00", taxTotal: "0.00", serviceCharge: "0.00", roundOff: "0.00",
  total: "10.00", pricesIncludeTax: true, taxLabel: "GST", gstin: null, lines: [],
});

const meta = { businessName: "Cafe", from: "2026-10-01", to: "2026-10-31", filtersText: "None", generatedAt: "2026-10-03T00:00:00Z" };

function pages(total: number, per: number) {
  const bills = Array.from({ length: total }, (_, i) => mk(i + 1));
  return vi.fn(async (cursor: string | null): Promise<ExportPage> => {
    const start = cursor ? Number(cursor) : 0;
    const slice = bills.slice(start, start + per);
    return { business: { name: "Cafe", timezone: "Asia/Kolkata", currency: "INR" }, bills: slice,
      nextCursor: start + per < total ? String(start + per) : null };
  });
}

const pdfZip = (ids: string[]) =>
  zipSync(Object.fromEntries(ids.map((id) => [`bill-${id.replace("id", "").padStart(6, "0")}.pdf`, strToU8(`%PDF ${id}`)])));

describe("runExport", () => {
  it("pages rows, batches PDFs, and writes CSVs + README", async () => {
    const fetchPdfs = vi.fn(async (ids: string[]) => pdfZip(ids));
    const zip = await runExport({
      fetchRows: pages(60, 25), fetchPdfs, includePdfs: true, meta,
      onProgress: () => {}, signal: new AbortController().signal, batchSize: 25,
    });
    const files = unzipSync(zip);
    expect(Object.keys(files).filter((f) => f.startsWith("bills/"))).toHaveLength(60);
    expect(files["sales-register.csv"]).toBeDefined();
    expect(files["bill-items.csv"]).toBeDefined();
    expect(files["daily-summary.csv"]).toBeDefined();
    expect(strFromU8(files["README.txt"]!)).toContain("not GST tax invoices");
    expect(fetchPdfs).toHaveBeenCalledTimes(3); // 25 + 25 + 10
  });

  it("retries a failed batch, then succeeds", async () => {
    let fails = 1;
    const fetchPdfs = vi.fn(async (ids: string[]) => {
      if (fails-- > 0) throw new Error("network");
      return pdfZip(ids);
    });
    await runExport({ fetchRows: pages(5, 25), fetchPdfs, includePdfs: true, meta, onProgress: () => {}, signal: new AbortController().signal });
    expect(fetchPdfs).toHaveBeenCalledTimes(2);
  });

  it("gives up after retries and produces nothing", async () => {
    const fetchPdfs = vi.fn(async () => { throw new Error("network"); });
    await expect(
      runExport({ fetchRows: pages(5, 25), fetchPdfs, includePdfs: true, meta, onProgress: () => {}, signal: new AbortController().signal, retries: 2 }),
    ).rejects.toThrow(/bills 1–5/);
    expect(fetchPdfs).toHaveBeenCalledTimes(3);
  });

  it("refuses a batch that came back short", async () => {
    const fetchPdfs = vi.fn(async (ids: string[]) => pdfZip(ids.slice(1)));
    await expect(
      runExport({ fetchRows: pages(3, 25), fetchPdfs, includePdfs: true, meta, onProgress: () => {}, signal: new AbortController().signal, retries: 0 }),
    ).rejects.toThrow();
  });

  it("CSV-only skips PDFs entirely", async () => {
    const fetchPdfs = vi.fn();
    const zip = await runExport({ fetchRows: pages(3, 25), fetchPdfs, includePdfs: false, meta, onProgress: () => {}, signal: new AbortController().signal });
    expect(fetchPdfs).not.toHaveBeenCalled();
    expect(Object.keys(unzipSync(zip)).some((f) => f.startsWith("bills/"))).toBe(false);
  });

  it("stops when cancelled", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      runExport({ fetchRows: pages(3, 25), fetchPdfs: vi.fn(), includePdfs: true, meta, onProgress: () => {}, signal: ctrl.signal }),
    ).rejects.toThrow(/cancel/i);
  });
});

describe("exportFileName", () => {
  it("slugs the business name", () => {
    expect(exportFileName("Chai & Co. Café", "2026-04-01", "2027-03-31")).toBe("sales_chai-co-cafe_2026-04-01_to_2027-03-31.zip");
  });
});
