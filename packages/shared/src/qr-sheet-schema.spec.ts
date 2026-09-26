import { describe, expect, it } from "vitest";
import { qrSheetSchema } from "./schemas";

const TABLE_ID = "3f1c4a0e-1b2d-4c3e-8a9f-0d1e2f3a4b5c";

describe("qrSheetSchema", () => {
  it("defaults to a portrait A4 sheet of medium cards", () => {
    const parsed = qrSheetSchema.parse({ tableIds: [TABLE_ID] });

    expect(parsed).toMatchObject({
      paper: "a4",
      orientation: "portrait",
      size: "medium",
      style: "card",
    });
  });

  it("rejects a sheet with no tables on it", () => {
    const result = qrSheetSchema.safeParse({ tableIds: [] });

    expect(result.success).toBe(false);
  });

  it("rejects a table id that is not a uuid", () => {
    const result = qrSheetSchema.safeParse({ tableIds: ["../../etc/passwd"] });

    expect(result.success).toBe(false);
  });

  it("rejects a paper size it cannot lay out", () => {
    const result = qrSheetSchema.safeParse({ tableIds: [TABLE_ID], paper: "a0" });

    expect(result.success).toBe(false);
  });
});
