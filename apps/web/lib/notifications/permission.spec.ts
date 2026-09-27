import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPromptRecord,
  recordPromptAnswered,
  shouldOfferAlerts,
  type PromptStore,
} from "./permission";

function memoryStore(): PromptStore {
  const map = new Map<string, string>();
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => void map.set(k, v),
    remove: (k) => void map.delete(k),
  };
}

let store: PromptStore;
beforeEach(() => {
  store = memoryStore();
});

describe("shouldOfferAlerts", () => {
  it("offers on a fresh browser that supports notifications", () => {
    expect(shouldOfferAlerts({ supported: true, permission: "default", store })).toBe(true);
  });

  it("never offers where notifications do not exist", () => {
    // Safari on iOS outside a Home Screen install, among others. Offering
    // something that cannot work is worse than offering nothing.
    expect(shouldOfferAlerts({ supported: false, permission: "default", store })).toBe(false);
  });

  it("does not offer once permission is granted", () => {
    expect(shouldOfferAlerts({ supported: true, permission: "granted", store })).toBe(false);
  });

  it("does not offer when the browser has been denied", () => {
    // The browser will not re-prompt after a denial, so a card offering to
    // enable alerts is a button that provably does nothing.
    expect(shouldOfferAlerts({ supported: true, permission: "denied", store })).toBe(false);
  });

  it("does not offer again after the card was dismissed", () => {
    // The whole requirement: asked once, never nagged. Dismissal counts as
    // an answer — it is the answer "no".
    recordPromptAnswered(store);
    expect(shouldOfferAlerts({ supported: true, permission: "default", store })).toBe(false);
  });

  it("stays silent across reloads, not just within one session", () => {
    recordPromptAnswered(store);
    // A second read of the same persisted store is what a reload looks like.
    expect(shouldOfferAlerts({ supported: true, permission: "default", store })).toBe(false);
    expect(shouldOfferAlerts({ supported: true, permission: "default", store })).toBe(false);
  });

  it("offers again only when Settings explicitly resets it", () => {
    recordPromptAnswered(store);
    clearPromptRecord(store);
    expect(shouldOfferAlerts({ supported: true, permission: "default", store })).toBe(true);
  });

  it("still refuses after a reset if the browser is denied", () => {
    // Resetting our own record cannot undo a browser-level denial; only the
    // person can, in site settings.
    clearPromptRecord(store);
    expect(shouldOfferAlerts({ supported: true, permission: "denied", store })).toBe(false);
  });

  it("survives a storage that throws", () => {
    // Private browsing and some embedded webviews make localStorage throw
    // on access. A dashboard that white-screens because of a preference is
    // a far worse failure than a prompt shown twice.
    const hostile: PromptStore = {
      get: () => {
        throw new Error("denied");
      },
      set: () => {
        throw new Error("denied");
      },
      remove: () => {
        throw new Error("denied");
      },
    };
    expect(() =>
      shouldOfferAlerts({ supported: true, permission: "default", store: hostile }),
    ).not.toThrow();
    expect(() => recordPromptAnswered(hostile)).not.toThrow();
  });
});
