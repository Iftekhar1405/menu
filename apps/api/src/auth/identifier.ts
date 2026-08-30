import { BadRequestException } from "@nestjs/common";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import type { CountryCode } from "libphonenumber-js";

/**
 * One login field accepts either an email or a phone number. This resolves
 * which one the owner typed and normalises it, so that `9876543210` typed in
 * India and `+91 98765 43210` typed anywhere land on the same account.
 */

export type Identifier =
  | { kind: "email"; email: string }
  | { kind: "phone"; phone: string };

// Deliberately permissive. Real validation is "does an OTP reach it", not a
// regex; the job here is only to tell an email apart from a phone number.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Anything that could plausibly be a phone number rather than an email. */
const PHONE_ISH_RE = /^[+()\d][\d\s\-().]*$/;

export function looksLikePhone(raw: string): boolean {
  const trimmed = raw.trim();
  return !trimmed.includes("@") && PHONE_ISH_RE.test(trimmed);
}

export function parseIdentifier(raw: string, defaultCountry = "IN"): Identifier {
  const trimmed = raw.trim();

  if (trimmed.includes("@")) {
    const email = trimmed.toLowerCase();
    if (!EMAIL_RE.test(email)) {
      throw new BadRequestException("That does not look like a valid email address");
    }
    return { kind: "email", email };
  }

  if (!looksLikePhone(trimmed)) {
    throw new BadRequestException("Enter a valid email address or phone number");
  }

  const parsed = parsePhoneNumberFromString(trimmed, defaultCountry as CountryCode);
  if (!parsed || !parsed.isValid()) {
    throw new BadRequestException("Enter a valid phone number, including country code");
  }

  return { kind: "phone", phone: parsed.number };
}

/** The Prisma `where` clause for looking an account up by either identifier. */
export function identifierWhere(id: Identifier): { email: string } | { phone: string } {
  return id.kind === "email" ? { email: id.email } : { phone: id.phone };
}

/** How the identifier is shown back to the owner, e.g. on the OTP screen. */
export function maskIdentifier(id: Identifier): string {
  if (id.kind === "email") {
    const [user = "", domain = ""] = id.email.split("@");
    const head = user.slice(0, 2);
    return `${head}${"•".repeat(Math.max(user.length - 2, 1))}@${domain}`;
  }
  const tail = id.phone.slice(-3);
  return `${id.phone.slice(0, 3)}${"•".repeat(Math.max(id.phone.length - 6, 1))}${tail}`;
}
