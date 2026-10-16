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
});
