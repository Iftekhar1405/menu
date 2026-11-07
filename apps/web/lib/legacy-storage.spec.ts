import { describe, expect, it } from "vitest";
import { readMigrating, type KeyValueStore } from "./legacy-storage";

function memory(initial: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k]! : null),
    setItem: (k, v) => { data[k] = v; },
    removeItem: (k) => { delete data[k]; },
  };
}

describe("reading a key renamed from menu to supermenu", () => {
  it("prefers the new key", () => {
    const s = memory({ "supermenu.x": "new", "menu.x": "old" });
    expect(readMigrating(s, "supermenu.x", "menu.x")).toBe("new");
  });

  it("still reads a value saved under the old name, and moves it", () => {
    const s = memory({ "menu.x": "old" });
    expect(readMigrating(s, "supermenu.x", "menu.x")).toBe("old");
    expect(s.data).toEqual({ "supermenu.x": "old" });
  });

  it("returns null when neither exists", () => {
    expect(readMigrating(memory(), "supermenu.x", "menu.x")).toBeNull();
  });
});
