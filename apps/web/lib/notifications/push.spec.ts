import { describe, expect, it } from "vitest";
import { decodeVapidKey } from "./push";

/**
 * A VAPID public key is 65 raw bytes carried as unpadded base64url. Getting
 * the padding or the two substituted characters wrong fails as an opaque
 * DOMException at subscribe time, which points nowhere near here.
 */
describe("decodeVapidKey", () => {
  it("decodes a key that needs no padding", () => {
    expect(Array.from(decodeVapidKey("AAAA"))).toEqual([0, 0, 0]);
  });

  it("restores the padding base64url omits", () => {
    // "aGk" is "hi" with its single "=" stripped.
    expect(new TextDecoder().decode(decodeVapidKey("aGk"))).toBe("hi");
  });

  it("substitutes the url-safe characters back", () => {
    // 0xFB 0xFF encodes as "-_8" in base64url and "+/8" in standard base64.
    expect(Array.from(decodeVapidKey("-_8"))).toEqual([251, 255]);
  });

  it("produces the 65 bytes a real VAPID public key is", () => {
    const key =
      "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
    expect(decodeVapidKey(key)).toHaveLength(65);
    // Uncompressed EC point, which is what the push API requires.
    expect(decodeVapidKey(key)[0]).toBe(0x04);
  });
});
