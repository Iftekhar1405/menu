import { CELL_ASPECT } from "@menu/shared";
import { describe, expect, it } from "vitest";
import { buildCompactCellSvg } from "./compact.svg";
import { decodeQrFromSvg } from "./decode-qr.testutil";

const URL = "http://localhost:3000/t/9f8e7d6c5b4a";

describe("buildCompactCellSvg", () => {
  it("encodes the table's own URL, not the menu URL", async () => {
    const svg = await buildCompactCellSvg({ url: URL, tableLabel: "Table 7" });

    expect(decodeQrFromSvg(svg)).toBe(URL);
  });

  it("prints the table label so a stack can be sorted", async () => {
    const svg = await buildCompactCellSvg({ url: URL, tableLabel: "Table 7" });

    expect(svg).toContain("Table 7");
  });

  it("escapes a label that would otherwise break the markup", async () => {
    const svg = await buildCompactCellSvg({ url: URL, tableLabel: 'Bar & "Patio"' });

    expect(svg).toContain("Bar &amp; &quot;Patio&quot;");
    expect(svg).not.toContain('"Patio"');
  });

  it("stays at the compact cell proportion the sheet planner assumes", async () => {
    const svg = await buildCompactCellSvg({ url: URL, tableLabel: "Table 7" });
    const viewBox = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);

    expect(viewBox).not.toBeNull();
    const w = Number(viewBox![1]);
    const h = Number(viewBox![2]);
    expect(h / w).toBeCloseTo(CELL_ASPECT.compact, 5);
  });

  it("still scans with a long label that has to be truncated", async () => {
    const svg = await buildCompactCellSvg({
      url: URL,
      tableLabel: "Terrace table by the window, second from the left",
    });

    expect(decodeQrFromSvg(svg)).toBe(URL);
  });
});
