import { randomInt } from "node:crypto";

/**
 * Crockford base32: no I, L, O or U. Removing them kills the 1/l/I and 0/O
 * confusions when someone reads a code off a printed card, and dropping U
 * avoids most accidental profanity.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;

/**
 * The permanent public identifier for a business. It goes into the QR that
 * gets printed onto PVC cards, so it is minted once and never changes — not
 * when the business is renamed, not when the owner picks a vanity slug.
 *
 * 32^8 is about 1.1 x 10^12, so collisions are not a practical concern; the
 * caller retries on the unique constraint regardless.
 */
export function generatePublicCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return out;
}

export function isValidPublicCode(code: string): boolean {
  return new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`).test(code);
}
