import { describe, expect, it } from "vitest";
import { encodeTicket, type TokenTicket } from "./tickets";

/**
 * Bytes back to the lines a human would read off the paper.
 *
 * Golden-byte assertions on a 48-column ticket are unreadable and unfixable
 * when they break — nobody can see from a hex diff that a dish name moved
 * one column. So escape sequences are stripped and the text asserted
 * exactly, which is the part that goes wrong; the escapes that matter (the
 * double-size token) get their own byte assertion below.
 */
function decode(bytes: Uint8Array): string[] {
  const out: string[] = [];
  let line = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    // Skip counts are exact on purpose: one byte too many eats the space
    // after a size change, and the assertion then fails for a reason that
    // has nothing to do with the layout.
    if (b === 0x1b) { i += bytes[i + 1] === 0x40 ? 1 : 2; continue; } // ESC @ (2) / ESC x n (3)
    if (b === 0x1d) { i += bytes[i + 1] === 0x56 ? 3 : 2; continue; } // GS V A 0 (4) / GS x n (3)
    if (b === 0x0a) { out.push(line); line = ""; continue; }
    line += String.fromCharCode(b);
  }
  if (line) out.push(line);
  // The blank lines the cut feeds through the blade are not content.
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

const token: TokenTicket = {
  kind: "token",
  businessName: "Taste of Hyderabad",
  token: 14,
  seq: 1,
  tableLabel: "7",
  at: "2026-10-04T15:12:00.000Z", // 8:42 PM IST
};

describe("encodeTicket: token slip", () => {
  it("prints the approved 58mm slip", () => {
    expect(decode(encodeTicket(token, 58))).toEqual([
      " ".repeat(7) + "Taste of Hyderabad",
      "",
      " ".repeat(13) + "TOKEN",
      " ".repeat(7) + "14",
      "",
      " ".repeat(12) + "Table 7",
      " ".repeat(8) + "04 Oct, 8:42 pm",
      "",
      "=".repeat(32),
      " ".repeat(5) + "Please keep this slip",
    ]);
  });

  it("prints the token double-size and turns the size back off", () => {
    // The point of the slip is a number readable across a counter — and the
    // point of the reset is that the table, the time and the footer are not.
    //
    // The reset needs its own assertion because no text assertion can see
    // it: decode() strips every GS ! triple whatever its parameter, so a
    // ticket missing the reset decodes to exactly the same lines while
    // printing everything after the token at double size.
    const bytes = Array.from(encodeTicket(token, 58));
    const at = bytes.findIndex(
      (_, i) => bytes[i] === 0x1d && bytes[i + 1] === 0x21 && bytes[i + 2] === 0x11,
    );
    expect(at).toBeGreaterThan(-1);

    const after = bytes.slice(at + 3);
    const eol = after.indexOf(0x0a);
    expect(String.fromCharCode(...after.slice(0, eol))).toContain("14");
    // Immediately after the token's own line, and nowhere later.
    expect(after.slice(eol + 1, eol + 4)).toEqual([0x1d, 0x21, 0x00]);
  });

  it("names the round only from the second one on", () => {
    // Round 1 is just "the order". Labelling it would make every single
    // -round table look like it was part of something longer.
    expect(decode(encodeTicket(token, 58))).not.toContain(" ".repeat(12) + "Round 1");

    const second = decode(encodeTicket({ ...token, seq: 2 }, 58));
    expect(second).toContain(" ".repeat(12) + "Round 2");
  });

  it("centres against 48 columns on an 80mm roll", () => {
    // Width is a property of the output, not the ticket.
    const wide = decode(encodeTicket(token, 80));
    expect(wide[0]).toBe(" ".repeat(15) + "Taste of Hyderabad");
    expect(wide).toContain("=".repeat(48));
  });

  it("carries no dishes and no prices", () => {
    const text = decode(encodeTicket(token, 58)).join("\n");
    expect(text).not.toMatch(/\d+\.\d\d/);
  });
});
