import { describe, expect, it } from "vitest";
import { fillSeries } from "./series";

describe("fillSeries", () => {
  it("fills missing days with zeros, in order", () => {
    const out = fillSeries(
      [{ start: "2026-10-03", gross: "300.00", bills: 2 }],
      { from: "2026-10-01", to: "2026-10-03" },
      "day",
    );
    expect(out).toEqual([
      { start: "2026-10-01", gross: "0", bills: 0 },
      { start: "2026-10-02", gross: "0", bills: 0 },
      { start: "2026-10-03", gross: "300.00", bills: 2 },
    ]);
  });

  it("starts weeks on the Monday on or before `from`", () => {
    const out = fillSeries([], { from: "2026-10-01", to: "2026-10-14" }, "week");
    expect(out.map((p) => p.start)).toEqual(["2026-09-28", "2026-10-05", "2026-10-12"]);
  });

  it("walks months by calendar month", () => {
    const out = fillSeries([], { from: "2026-01-15", to: "2026-03-02" }, "month");
    expect(out.map((p) => p.start)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
  });
});
