import { NotFoundException } from "@nestjs/common";
import { zipSync } from "fflate";

export function billPdfName(billNumber: number): string {
  return `bill-${String(billNumber).padStart(6, "0")}.pdf`;
}

/**
 * All or nothing. A batch that silently dropped an id would produce an
 * export missing a bill, and nobody would notice until the books disagreed.
 */
export function assertAllFound(asked: string[], found: { id: string }[]): void {
  const have = new Set(found.map((f) => f.id));
  if (!asked.every((id) => have.has(id))) throw new NotFoundException("Bill not found");
}

/** Store-only: PDFs are already compressed, so deflating again is wasted CPU. */
export function zipPdfs(files: { name: string; bytes: Uint8Array }[]): Uint8Array {
  return zipSync(Object.fromEntries(files.map((f) => [f.name, [f.bytes, { level: 0 }]])));
}
