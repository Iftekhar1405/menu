import { describe, expect, it } from "vitest";
import { heatStep, niceTicks, shortDate, thinIndices } from "./chart-math";

describe("niceTicks", () => {
  it("rounds the top up to a clean number and splits it evenly", () => {
    expect(niceTicks(870)).toEqual([0, 250, 500, 750, 1000]);
    expect(niceTicks(12_400)).toEqual([0, 5000, 10000, 15000]);
  });
  it("still draws an axis when everything is zero", () => {
    expect(niceTicks(0)).toEqual([0, 1]);
  });
});

describe("thinIndices", () => {
  it("keeps every label when there is room", () => {
    expect(thinIndices(5, 8)).toEqual([0, 1, 2, 3, 4]);
  });
  it("keeps at most the limit, always including first and last", () => {
    const kept = thinIndices(31, 8);
    expect(kept.length).toBeLessThanOrEqual(8);
    expect(kept[0]).toBe(0);
    expect(kept.at(-1)).toBe(30);
  });
});

describe("heatStep", () => {
  it("maps empty to 0 and the busiest cell to the top step", () => {
    expect(heatStep(0, 10)).toBe(0);
    expect(heatStep(10, 10)).toBe(4);
    expect(heatStep(1, 10)).toBe(1);
  });
});

describe("shortDate", () => {
  it("labels days and months without a year", () => {
    expect(shortDate("2026-10-03", "day")).toBe("3 Oct");
    expect(shortDate("2026-10-01", "month")).toBe("Oct");
  });
});
