import { describe, expect, it } from "vitest";
import { ROLE_TARGETS, canRoleSetStatus, ORDER_STATUSES } from "./roles";

describe("role targets", () => {
  it("lets the kitchen take, start and finish cooking", () => {
    expect(canRoleSetStatus("kitchen", "placed", "accepted")).toBe(true);
    expect(canRoleSetStatus("kitchen", "accepted", "preparing")).toBe(true);
    expect(canRoleSetStatus("kitchen", "preparing", "ready")).toBe(true);
  });

  it("refuses the kitchen the two acts that touch a bill", () => {
    expect(canRoleSetStatus("kitchen", "ready", "completed")).toBe(false);
    expect(canRoleSetStatus("kitchen", "placed", "cancelled")).toBe(false);
  });

  // Review Focus 5: `accepted` is a legal kitchen target and an illegal move
  // from `ready`. Only the intersection of the two tables is correct.
  it("refuses a backward move even to a status the role may otherwise set", () => {
    expect(ROLE_TARGETS.kitchen).toContain("accepted");
    expect(canRoleSetStatus("kitchen", "ready", "accepted")).toBe(false);
    expect(canRoleSetStatus("kitchen", "preparing", "accepted")).toBe(false);
  });

  it("leaves the owner every move the state machine already allows", () => {
    expect(canRoleSetStatus("owner", "ready", "completed")).toBe(true);
    expect(canRoleSetStatus("owner", "placed", "cancelled")).toBe(true);
    expect(canRoleSetStatus("owner", "completed", "placed")).toBe(false);
  });

  it("never lets any role move a finished order", () => {
    for (const role of ["owner", "kitchen"] as const) {
      for (const to of ORDER_STATUSES) {
        expect(canRoleSetStatus(role, "completed", to)).toBe(false);
        expect(canRoleSetStatus(role, "cancelled", to)).toBe(false);
      }
    }
  });
});
