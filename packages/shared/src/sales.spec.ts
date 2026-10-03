import { describe, expect, it } from "vitest";
import {
  addDays,
  bucketFor,
  daySpan,
  localToday,
  paramsToObject,
  presetRange,
  previousPeriod,
  salesFilterSchema,
  salesFilterToParams,
  timezoneFor,
} from "./sales";

describe("timezoneFor", () => {
  it("maps India to Kolkata and anything unknown to UTC", () => {
    expect(timezoneFor("IN")).toBe("Asia/Kolkata");
    expect(timezoneFor("in")).toBe("Asia/Kolkata");
    expect(timezoneFor("ZZ")).toBe("UTC");
  });
});

describe("localToday", () => {
  it("is already tomorrow in IST at 19:00 UTC", () => {
    const now = new Date("2026-10-01T19:00:00Z"); // 00:30 IST on 2 Oct
    expect(localToday("Asia/Kolkata", now)).toBe("2026-10-02");
    expect(localToday("UTC", now)).toBe("2026-10-01");
  });
});

describe("date math", () => {
  it("adds days across month and year ends", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("counts both ends", () => {
    expect(daySpan("2026-10-01", "2026-10-01")).toBe(1);
    expect(daySpan("2026-10-01", "2026-10-31")).toBe(31);
  });
});

describe("presetRange", () => {
  const today = "2026-10-03"; // a Saturday
  it("starts the week on Monday", () => {
    expect(presetRange("this_week", today)).toEqual({ from: "2026-09-28", to: today });
  });
  it("handles months", () => {
    expect(presetRange("this_month", today)).toEqual({ from: "2026-10-01", to: today });
    expect(presetRange("last_month", today)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(presetRange("last_month", "2026-01-15")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });
  it("uses April–March financial years", () => {
    expect(presetRange("this_fy", today)).toEqual({ from: "2026-04-01", to: today });
    expect(presetRange("this_fy", "2026-02-10")).toEqual({ from: "2025-04-01", to: "2026-02-10" });
    expect(presetRange("last_fy", today)).toEqual({ from: "2025-04-01", to: "2026-03-31" });
  });
  it("does today and yesterday", () => {
    expect(presetRange("today", today)).toEqual({ from: today, to: today });
    expect(presetRange("yesterday", today)).toEqual({ from: "2026-10-02", to: "2026-10-02" });
  });
});

describe("previousPeriod", () => {
  it("is the same length, immediately before", () => {
    expect(previousPeriod({ from: "2026-10-01", to: "2026-10-31" })).toEqual({
      from: "2026-08-31",
      to: "2026-09-30",
    });
    expect(previousPeriod({ from: "2026-10-03", to: "2026-10-03" })).toEqual({
      from: "2026-10-02",
      to: "2026-10-02",
    });
  });
});

describe("bucketFor", () => {
  it("chooses day, week, month by span", () => {
    expect(bucketFor({ from: "2026-10-01", to: "2026-11-30" })).toBe("day"); // 61
    expect(bucketFor({ from: "2026-10-01", to: "2026-12-31" })).toBe("week"); // 92
    expect(bucketFor({ from: "2026-04-01", to: "2027-03-31" })).toBe("month");
  });
});

describe("salesFilterSchema", () => {
  it("accepts a Nest-style query object with repeated params", () => {
    const parsed = salesFilterSchema.parse({
      from: "2026-10-01",
      to: "2026-10-31",
      modes: ["cash", "unpaid"],
      tables: "Balcony 3",
      minTotal: "100",
      maxTotal: "",
      billNo: "",
    });
    expect(parsed.modes).toEqual(["cash", "unpaid"]);
    expect(parsed.tables).toEqual(["Balcony 3"]);
    expect(parsed.minTotal).toBe(100);
    expect(parsed.maxTotal).toBeUndefined();
    expect(parsed.billNo).toBeUndefined();
  });
  it("refuses a reversed or over-long range and bad dates", () => {
    expect(salesFilterSchema.safeParse({ from: "2026-10-31", to: "2026-10-01" }).success).toBe(false);
    expect(salesFilterSchema.safeParse({ from: "2025-01-01", to: "2026-10-01" }).success).toBe(false);
    expect(salesFilterSchema.safeParse({ from: "2026-02-30", to: "2026-03-01" }).success).toBe(false);
  });
  it("refuses min above max and unknown modes", () => {
    expect(
      salesFilterSchema.safeParse({ from: "2026-10-01", to: "2026-10-02", minTotal: "500", maxTotal: "100" }).success,
    ).toBe(false);
    expect(salesFilterSchema.safeParse({ from: "2026-10-01", to: "2026-10-02", modes: ["bitcoin"] }).success).toBe(false);
  });
  it("round-trips through URL params, including a label with a comma", () => {
    const f = salesFilterSchema.parse({
      from: "2026-10-01",
      to: "2026-10-31",
      modes: ["upi", "card"],
      tables: ["Screen 2, Row F", "12"],
      billNo: "42",
    });
    const back = salesFilterSchema.parse(paramsToObject(salesFilterToParams(f)));
    expect(back).toEqual(f);
  });
});
