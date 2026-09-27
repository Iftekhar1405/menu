import { describe, expect, it } from "vitest";
import { businessChannel, tableChannel } from "./channel-name";

const SECRET = "test-realtime-channel-secret";
const BUSINESS = "3f2b1c7e-8a44-4f0d-9c21-0d5e6a7b8c9d";
const OTHER = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

/**
 * A business id is not a secret — it sits in every `/businesses/:bid/...`
 * URL, and therefore in history, logs and referrers. The channel name has to
 * be something a leaked id does not yield.
 */
describe("channel names", () => {
  it("does not contain the id it was derived from", () => {
    const name = businessChannel(BUSINESS, SECRET);
    expect(name).not.toContain(BUSINESS);
    expect(name).not.toContain(BUSINESS.replace(/-/g, ""));
  });

  it("is stable for the same id and secret", () => {
    expect(businessChannel(BUSINESS, SECRET)).toBe(businessChannel(BUSINESS, SECRET));
  });

  it("differs per business", () => {
    expect(businessChannel(BUSINESS, SECRET)).not.toBe(businessChannel(OTHER, SECRET));
  });

  it("differs when the secret is rotated", () => {
    expect(businessChannel(BUSINESS, SECRET)).not.toBe(
      businessChannel(BUSINESS, "a-different-secret"),
    );
  });

  it("keeps a table and a business with the same id apart", () => {
    // Nothing stops a uuid appearing as both in test data, and the two
    // audiences must never collide onto one topic.
    expect(tableChannel(BUSINESS, SECRET)).not.toBe(businessChannel(BUSINESS, SECRET));
  });

  it("is prefixed so a topic is recognisable in Supabase's dashboard", () => {
    expect(businessChannel(BUSINESS, SECRET)).toMatch(/^business:[0-9a-f]{32}$/);
    expect(tableChannel(BUSINESS, SECRET)).toMatch(/^table:[0-9a-f]{32}$/);
  });
});
