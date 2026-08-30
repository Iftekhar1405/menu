import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { deliveryUrl, signUpload, usesCloudinary } from "./cloudinary";
import type { Env } from "../config/env";

/**
 * A wrong Cloudinary signature fails at upload time, in the browser, with a
 * 401 the owner sees as "that photo didn't upload" — so it is worth checking
 * the arithmetic here rather than discovering it against a live account.
 */
const env = {
  CLOUDINARY_CLOUD_NAME: "demo-cloud",
  CLOUDINARY_API_KEY: "123456789",
  CLOUDINARY_API_SECRET: "s3cr3t",
} as Env;

describe("cloudinary", () => {
  it("is inactive unless all three credentials are set", () => {
    expect(usesCloudinary(env)).toBe(true);
    expect(usesCloudinary({ ...env, CLOUDINARY_API_SECRET: "" } as Env)).toBe(false);
    expect(usesCloudinary({ ...env, CLOUDINARY_CLOUD_NAME: "" } as Env)).toBe(false);
    expect(usesCloudinary({ ...env, CLOUDINARY_API_KEY: "" } as Env)).toBe(false);
  });

  it("signs the sorted parameter list with the secret appended", () => {
    const ticket = signUpload(env, "biz-1/items/item-9/abc");

    // Recomputed independently, the way Cloudinary does it: alphabetical
    // parameters, &-joined, secret appended, SHA-1.
    const expected = createHash("sha1")
      .update(
        `overwrite=false&public_id=biz-1/items/item-9/abc&timestamp=${ticket.fields.timestamp}s3cr3t`,
      )
      .digest("hex");

    expect(ticket.fields.signature).toBe(expected);
  });

  it("never puts the API secret in the ticket", () => {
    const ticket = signUpload(env, "biz-1/logo/x");
    expect(JSON.stringify(ticket)).not.toContain("s3cr3t");
    expect(ticket.fields.api_key).toBe("123456789");
  });

  it("refuses overwrites, so a ticket cannot replace an existing image", () => {
    expect(signUpload(env, "biz-1/logo/x").fields.overwrite).toBe("false");
  });

  it("signs the public_id, so a ticket cannot be redirected elsewhere", () => {
    const a = signUpload(env, "biz-1/items/one");
    const b = signUpload({ ...env }, "biz-2/items/one");
    expect(a.fields.signature).not.toBe(b.fields.signature);
  });

  it("delivers through f_auto,q_auto", () => {
    expect(deliveryUrl(env, "biz-1/items/abc")).toBe(
      "https://res.cloudinary.com/demo-cloud/image/upload/f_auto,q_auto/biz-1/items/abc",
    );
  });
});
