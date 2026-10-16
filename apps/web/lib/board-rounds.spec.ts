import { describe, expect, it } from "vitest";
import { columnFor, nextActionFor } from "./board-actions";

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

describe("columnFor", () => {
  it("keeps a cooking table on the kitchen's board when a new round lands on it", () => {
    // The dosa is being made and the diner adds a chai. As an order that
    // derives to placed — which is no column on a kitchen board — so the card
    // used to vanish mid-cook, taking the dish they were actually cooking
    // with it. The kitchen's lane comes from the rounds the kitchen can see.
    expect(columnFor("kitchen", ["preparing", "placed"])).toBe("preparing");
    expect(columnFor("owner", ["preparing", "placed"])).toBe("placed");
  });

  it("keeps a table nobody has accepted yet off the kitchen's board", () => {
    // Accepting is a counter decision, not a kitchen one. A card with no
    // kitchen-visible round is not theirs yet.
    expect(columnFor("kitchen", ["placed"])).toBeNull();
    expect(columnFor("owner", ["placed"])).toBe("placed");
  });

  it("puts a finished table in no column at all", () => {
    expect(columnFor("owner", ["completed", "cancelled"])).toBeNull();
    expect(columnFor("kitchen", ["ready", "placed"])).toBe("ready");
  });
});
