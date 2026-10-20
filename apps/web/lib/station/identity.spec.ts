import { beforeEach, describe, expect, it } from "vitest";
import { forgetStation, rememberStation, stationIdFor } from "./identity";

/** A minimal localStorage, because this runs in node. */
beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});

describe("station identity", () => {
  it("remembers which station this machine is, per business", () => {
    // One machine, two venues in the switcher. Remembering a single id
    // would have the second venue's tab claim the first venue's tickets.
    rememberStation("b1", "s1");
    rememberStation("b2", "s2");
    expect(stationIdFor("b1")).toBe("s1");
    expect(stationIdFor("b2")).toBe("s2");
  });

  it("is nothing on a machine that was never set up", () => {
    expect(stationIdFor("b1")).toBeNull();
  });

  it("forgets, which is what a revoked station does", () => {
    rememberStation("b1", "s1");
    forgetStation("b1");
    expect(stationIdFor("b1")).toBeNull();
  });

  it("survives a localStorage whose methods throw", () => {
    // THE test for the try/catch. Private mode and some embedded webviews
    // give you a localStorage object whose METHODS throw on call — access
    // succeeds, so the optional chaining below does nothing. Without this,
    // deleting every try/catch in identity.ts leaves the whole file's
    // suite green on the strength of `?.` alone.
    const boom = () => {
      throw new Error("SecurityError: access denied");
    };
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: boom,
      setItem: boom,
      removeItem: boom,
    };

    expect(() => stationIdFor("b1")).not.toThrow();
    expect(stationIdFor("b1")).toBeNull();
    expect(() => rememberStation("b1", "s1")).not.toThrow();
    expect(() => forgetStation("b1")).not.toThrow();
  });

  it("survives a browser with no localStorage at all", () => {
    // Private mode and some embedded webviews throw on access. A station
    // that crashes on load cannot even show why.
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(() => stationIdFor("b1")).not.toThrow();
    expect(stationIdFor("b1")).toBeNull();
  });
});
