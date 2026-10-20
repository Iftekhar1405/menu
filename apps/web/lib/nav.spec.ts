import { describe, expect, it } from "vitest";
import { canSee, navFor } from "./nav";

describe("navigation by role", () => {
  it("gives the kitchen only what a service needs", () => {
    expect(navFor("kitchen").map((i) => i.href)).toEqual(["/orders", "/dishes"]);
  });

  it("keeps the owner's nine sections", () => {
    expect(navFor("owner")).toHaveLength(9);
    expect(navFor("owner").map((i) => i.href)).toContain("/billing");
  });

  it("adds our section for platform admins only", () => {
    expect(navFor("platform_admin").map((i) => i.href)).toContain("/admin");
    expect(navFor("owner").map((i) => i.href)).not.toContain("/admin");
  });

  it("keeps the kitchen out of every money screen", () => {
    for (const path of ["/billing", "/settings", "/qr", "/merch", "/appearance", "/dashboard", "/tables", "/menu"]) {
      expect(canSee("kitchen", path)).toBe(false);
    }
  });

  it("lets the kitchen reach its own two screens", () => {
    expect(canSee("kitchen", "/orders")).toBe(true);
    expect(canSee("kitchen", "/dishes")).toBe(true);
  });

  it("keeps owners off the kitchen-only dish screen", () => {
    expect(canSee("owner", "/dishes")).toBe(false);
  });

  it("lets every role reach the station screen without listing it in anyone's nav", () => {
    // The machine that stays open at the counter all day is reached by its
    // own bookmark, not by navigating in from a staff member's session —
    // so it must pass canSee without ever showing up in navFor.
    for (const role of ["owner", "kitchen", "platform_admin"] as const) {
      expect(canSee(role, "/station")).toBe(true);
      expect(navFor(role).map((i) => i.href)).not.toContain("/station");
    }
  });
});

describe("the printing settings screen", () => {
  it("is the owner's, and not the kitchen's", () => {
    // This passes today with no nav.ts change — `canSee` matches by prefix
    // and "/settings" is already in the owner and admin lists. It is here
    // as a REGRESSION GUARD, not as a test of new work: it fails the day
    // someone drops "/settings" from an owner's list or grants it to the
    // kitchen, either of which would silently change who sees this page.
    expect(canSee("owner", "/settings/printing")).toBe(true);
    expect(canSee("platform_admin", "/settings/printing")).toBe(true);
    expect(canSee("kitchen", "/settings/printing")).toBe(false);
  });

  it("hangs off Settings rather than taking its own nav entry", () => {
    expect(navFor("owner").map((n) => n.href)).not.toContain("/settings/printing");
  });
});

// Note: the /station screen's own nav test already exists, written by
// Task 13 — it asserts every role can reach the page and that it appears
// in nobody's sidebar. Do not duplicate it.
