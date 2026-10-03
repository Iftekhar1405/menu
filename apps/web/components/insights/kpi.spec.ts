import { describe, expect, it } from "vitest";
import { pctChange } from "./kpi";

describe("pctChange", () => {
  it("computes change against the previous period", () => {
    expect(pctChange("150", "100")).toBe(50);
    expect(pctChange("50", "100")).toBe(-50);
  });
  it("has no percentage when there was nothing before", () => {
    expect(pctChange("100", "0")).toBeNull();
  });
});
