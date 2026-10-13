import { describe, expect, it } from "vitest";
import { nextActionFor } from "./board-actions";

describe("nextActionFor", () => {
  it("offers Accept on a new round and Served on a ready one", () => {
    expect(nextActionFor("owner", "placed")?.label).toBe("Accept");
    expect(nextActionFor("owner", "ready")?.label).toBe("Served");
  });

  it("withholds Served from the kitchen but keeps Ready", () => {
    // The button is the permission. A screen that offers an action the API
    // will refuse is worse than a screen with no button.
    expect(nextActionFor("kitchen", "ready")).toBeNull();
    expect(nextActionFor("kitchen", "preparing")?.label).toBe("Ready");
  });

  it("offers nothing on a finished round", () => {
    expect(nextActionFor("owner", "completed")).toBeNull();
  });
});
