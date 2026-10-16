import { describe, expect, it } from "vitest";
import { columnsFor, showsMoney } from "./board-actions";

describe("board actions by role", () => {
  it("starts the kitchen's board at Accepted, not New", () => {
    expect(columnsFor("kitchen").map((c) => c.status))
      .toEqual(["accepted", "preparing", "ready"]);
  });

  it("keeps New for the owner, who is the one who works it", () => {
    expect(columnsFor("owner").map((c) => c.status))
      .toEqual(["placed", "accepted", "preparing", "ready"]);
  });

  it("still shows the kitchen Ready, so they can see the pass backing up", () => {
    expect(columnsFor("kitchen").map((c) => c.status)).toContain("ready");
  });

  it("removes Served from the kitchen's Ready column", () => {
    expect(columnsFor("kitchen").find((c) => c.status === "ready")?.next).toBeUndefined();
  });

  it("leaves the kitchen the two actions its board can reach", () => {
    const c = columnsFor("kitchen");
    expect(c.find((x) => x.status === "accepted")?.next).toBe("preparing");
    expect(c.find((x) => x.status === "preparing")?.next).toBe("ready");
  });

  it("never shows the kitchen an order nobody has accepted yet", () => {
    expect(columnsFor("kitchen").some((c) => c.status === "placed")).toBe(false);
  });

  it("gives the owner Served back", () => {
    expect(columnsFor("owner").find((c) => c.status === "ready")?.next).toBe("completed");
  });

  it("shows no money to the kitchen", () => {
    expect(showsMoney("kitchen")).toBe(false);
    expect(showsMoney("owner")).toBe(true);
  });
});
