import { describe, expect, it } from "vitest";
import { columnsFor, showsMoney } from "./board-actions";

describe("board actions by role", () => {
  it("keeps all four columns for the kitchen, so they can see what is waiting", () => {
    expect(columnsFor("kitchen").map((c) => c.status))
      .toEqual(["placed", "accepted", "preparing", "ready"]);
  });

  it("removes Served from the kitchen's Ready column", () => {
    expect(columnsFor("kitchen").find((c) => c.status === "ready")?.next).toBeUndefined();
  });

  it("leaves the kitchen its three real actions", () => {
    const c = columnsFor("kitchen");
    expect(c.find((x) => x.status === "placed")?.next).toBe("accepted");
    expect(c.find((x) => x.status === "accepted")?.next).toBe("preparing");
    expect(c.find((x) => x.status === "preparing")?.next).toBe("ready");
  });

  it("gives the owner Served back", () => {
    expect(columnsFor("owner").find((c) => c.status === "ready")?.next).toBe("completed");
  });

  it("shows no money to the kitchen", () => {
    expect(showsMoney("kitchen")).toBe(false);
    expect(showsMoney("owner")).toBe(true);
  });
});
