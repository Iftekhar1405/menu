import { strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { dailyCsv, itemsCsv, readmeText, registerCsv } from "./csv";
import type { ExportBill, ExportPage } from "./types";

export interface RunExportOptions {
  fetchRows: (cursor: string | null) => Promise<ExportPage>;
  fetchPdfs: (billIds: string[]) => Promise<Uint8Array>;
  includePdfs: boolean;
  meta: { businessName: string; from: string; to: string; filtersText: string; generatedAt: string };
  onProgress: (p: { phase: "rows" | "pdfs"; done: number; total: number }) => void;
  signal: AbortSignal;
  batchSize?: number;
  concurrency?: number;
  retries?: number;
}

function checkCancelled(signal: AbortSignal) {
  if (signal.aborted) throw new Error("Export cancelled");
}

/**
 * Builds the export in the browser from small, quick requests — the API is
 * serverless and cannot render a year of PDFs in one 30-second call.
 *
 * All or nothing: a batch that fails after its retries, or returns fewer
 * PDFs than asked for, aborts the export. A ZIP with a bill silently missing
 * is worse than no ZIP.
 */
export async function runExport(o: RunExportOptions): Promise<Uint8Array> {
  const batchSize = o.batchSize ?? 25;
  const concurrency = o.concurrency ?? 2;
  const retries = o.retries ?? 2;

  const bills: ExportBill[] = [];
  let timezone = "UTC";
  let cursor: string | null = null;
  do {
    checkCancelled(o.signal);
    const page: ExportPage = await o.fetchRows(cursor);
    timezone = page.business.timezone;
    bills.push(...page.bills);
    cursor = page.nextCursor;
    o.onProgress({ phase: "rows", done: bills.length, total: bills.length });
  } while (cursor);

  const files: Zippable = {
    "sales-register.csv": strToU8(registerCsv(bills, timezone)),
    "bill-items.csv": strToU8(itemsCsv(bills, timezone)),
    "daily-summary.csv": strToU8(dailyCsv(bills, timezone)),
    "README.txt": strToU8(readmeText({ ...o.meta, timezone, bills: bills.length, includesPdfs: o.includePdfs })),
  };

  if (o.includePdfs && bills.length) {
    const batches: ExportBill[][] = [];
    for (let i = 0; i < bills.length; i += batchSize) batches.push(bills.slice(i, i + batchSize));
    let done = 0;
    let next = 0;
    o.onProgress({ phase: "pdfs", done, total: bills.length });

    const worker = async () => {
      while (next < batches.length) {
        const batch = batches[next++]!;
        const ids = batch.map((b) => b.id);
        let attempt = 0;
        for (;;) {
          checkCancelled(o.signal);
          try {
            const entries = unzipSync(await o.fetchPdfs(ids));
            const names = Object.keys(entries);
            if (names.length !== batch.length) throw new Error("short batch");
            for (const name of names) files[`bills/${name}`] = [entries[name]!, { level: 0 }];
            break;
          } catch (err) {
            if (o.signal.aborted) throw new Error("Export cancelled");
            if (attempt++ >= retries) {
              throw new Error(
                `Could not fetch bills ${batch[0]!.billNumber}–${batch[batch.length - 1]!.billNumber}. Check your connection and try again.`,
              );
            }
          }
        }
        done += batch.length;
        o.onProgress({ phase: "pdfs", done, total: bills.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  }

  checkCancelled(o.signal);
  return zipSync(files);
}

export function exportFileName(business: string, from: string, to: string): string {
  const slug = business
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `sales_${slug || "business"}_${from}_to_${to}.zip`;
}
