"use client";

import { useRef, useState } from "react";
import { PAYMENT_MODE_LABEL, type SalesFilter } from "@menu/shared";
import { api, apiBinary } from "@/lib/api-client";
import { runExport, exportFileName } from "@/lib/sales/export";
import type { ExportPage } from "@/lib/sales/types";
import { Banner, Button, Sheet, SheetGrabber } from "@/components/ui";

const LARGE = 3000;

function describe(f: SalesFilter): string {
  const parts: string[] = [];
  if (f.modes?.length) parts.push(`payment: ${f.modes.map((m) => (m === "unpaid" ? "Unpaid" : PAYMENT_MODE_LABEL[m])).join(", ")}`);
  if (f.tables?.length) parts.push(`tables: ${f.tables.join(", ")}`);
  if (f.categoryId) parts.push("one category");
  if (f.menuItemId) parts.push("one dish");
  if (f.minTotal !== undefined || f.maxTotal !== undefined) parts.push(`total ${f.minTotal ?? 0}–${f.maxTotal ?? "any"}`);
  if (f.billNo !== undefined) parts.push(`bill #${f.billNo}`);
  return parts.length ? parts.join("; ") : "None";
}

export function ExportDialog({
  businessId,
  businessName,
  filter,
  query,
  billCount,
  onClose,
}: {
  businessId: string;
  businessName: string;
  filter: SalesFilter;
  query: string;
  billCount: number;
  onClose: () => void;
}) {
  const [includePdfs, setIncludePdfs] = useState(true);
  const [progress, setProgress] = useState<{ phase: "rows" | "pdfs"; done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  async function start() {
    setError(null);
    ctrl.current = new AbortController();
    try {
      const zip = await runExport({
        fetchRows: (cursor) =>
          api.get<ExportPage>(`/businesses/${businessId}/bills/export/rows?${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
        fetchPdfs: (billIds) => apiBinary(`/businesses/${businessId}/bills/export/pdfs`, { billIds }),
        includePdfs,
        meta: { businessName, from: filter.from, to: filter.to, filtersText: describe(filter), generatedAt: new Date().toISOString() },
        onProgress: setProgress,
        signal: ctrl.current.signal,
      });
      const url = URL.createObjectURL(new Blob([zip as BlobPart], { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = exportFileName(businessName, filter.from, filter.to);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed");
      setProgress(null);
    }
  }

  const running = progress !== null && !error;

  return (
    <Sheet label="Export sales" onClose={() => { ctrl.current?.abort(); onClose(); }}>
      <SheetGrabber />
      <div className="px-5 pb-6 pt-4 sm:px-6">
        <h2 className="text-[17px] font-semibold">Export {billCount} bill{billCount === 1 ? "" : "s"}</h2>
        <p className="mt-1 text-[13.5px] text-muted">{filter.from} → {filter.to}. Filters: {describe(filter)}.</p>

        {!running && (
          <fieldset className="mt-5 space-y-2">
            <label className="flex items-start gap-3">
              <input type="radio" checked={includePdfs} onChange={() => setIncludePdfs(true)} className="mt-1" />
              <span><strong>Bills + spreadsheets</strong><br /><span className="text-[13px] text-muted">Every bill as a PDF, plus the CSVs.</span></span>
            </label>
            <label className="flex items-start gap-3">
              <input type="radio" checked={!includePdfs} onChange={() => setIncludePdfs(false)} className="mt-1" />
              <span><strong>Spreadsheets only</strong><br /><span className="text-[13px] text-muted">Sales register, items and daily summary. Fast.</span></span>
            </label>
          </fieldset>
        )}

        {includePdfs && billCount > LARGE && !running && (
          <div className="mt-4">
            <Banner tone="info">This is a large export and takes a few minutes. Keep this tab open until it finishes.</Banner>
          </div>
        )}

        {running && (
          <div className="mt-5" aria-live="polite">
            <p className="tnum text-[14px]">
              {progress.phase === "rows" ? `Reading bills… ${progress.done}` : `Preparing bills ${progress.done} / ${progress.total}`}
            </p>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-line">
              <div className="h-full bg-[var(--accent)] transition-[width]"
                style={{ width: progress.phase === "pdfs" && progress.total ? `${(progress.done / progress.total) * 100}%` : "8%" }} />
            </div>
          </div>
        )}

        {error && <p role="alert" className="mt-4 text-[13.5px] text-[var(--danger,#b42318)]">{error}</p>}

        <div className="mt-6 flex gap-3">
          {running ? (
            <Button variant="ghost" onClick={() => ctrl.current?.abort()}>Cancel</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>Close</Button>
              <Button variant="primary" className="flex-1" onClick={() => void start()}>
                {error ? "Try again" : "Download ZIP"}
              </Button>
            </>
          )}
        </div>
      </div>
    </Sheet>
  );
}
