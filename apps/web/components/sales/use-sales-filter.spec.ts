import { describe, expect, it } from "vitest";
import { filterFromSearch } from "./use-sales-filter";

const now = new Date("2026-10-03T06:00:00Z");

describe("filterFromSearch", () => {
  it("defaults to this month in the business timezone", () => {
    const r = filterFromSearch(new URLSearchParams(), "Asia/Kolkata", now);
    expect(r.preset).toBe("this_month");
    expect(r.filter).toMatchObject({ from: "2026-10-01", to: "2026-10-03" });
  });

  it("recomputes a preset from today rather than trusting stale dates", () => {
    const r = filterFromSearch(new URLSearchParams("p=yesterday&from=2026-01-01&to=2026-01-01"), "Asia/Kolkata", now);
    expect(r.filter).toMatchObject({ from: "2026-10-02", to: "2026-10-02" });
  });

  it("keeps custom dates and the other filters", () => {
    const r = filterFromSearch(
      new URLSearchParams("p=custom&from=2026-09-01&to=2026-09-15&modes=cash&modes=unpaid&tables=12"),
      "Asia/Kolkata",
      now,
    );
    expect(r.preset).toBe("custom");
    expect(r.filter).toMatchObject({ from: "2026-09-01", to: "2026-09-15", modes: ["cash", "unpaid"], tables: ["12"] });
  });

  it("falls back to the default on an invalid range instead of crashing", () => {
    const r = filterFromSearch(new URLSearchParams("p=custom&from=2026-09-30&to=2026-09-01"), "UTC", now);
    expect(r.preset).toBe("this_month");
  });
});
