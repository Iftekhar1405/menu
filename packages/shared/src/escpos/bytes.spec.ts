import { describe, expect, it } from "vitest";
import { EscPos, toCp437 } from "./bytes";

/** Readable assertions: bytes as a hex string. */
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");

describe("toCp437", () => {
  it("passes plain ASCII through untouched", () => {
    expect(toCp437("Chicken Biryani (Full)")).toBe("Chicken Biryani (Full)");
  });

  it("transliterates what Latin-1 can express", () => {
    // A cafe on the menu must not print with a hole where the accent was.
    expect(toCp437("Café")).toBe("Cafe");
    expect(toCp437("Crème Brûlée")).toBe("Creme Brulee");
  });

  it("drops what it cannot render rather than emitting garbage", () => {
    // Devanagari in a single-byte codepage is one wrong glyph per byte, and
    // some of those bytes are commands. Dropping is the safe failure.
    expect(toCp437("बिरयानी Biryani")).toBe(" Biryani");
  });

  it("never emits a byte the printer would read as a command", () => {
    // Escape sequences, not literal control bytes: a raw NUL in a source
    // file truncates half the tools that read it.
    const out = toCp437("a\x07b\x1bc\x00d");
    for (const ch of out) expect(ch.charCodeAt(0)).toBeGreaterThanOrEqual(0x20);
  });

  it("keeps the rupee sign printable", () => {
    // The rupee sign is not in CP437. Money on a bill must still read as money.
    expect(toCp437("₹320.00")).toBe("Rs.320.00");
  });
});

describe("EscPos", () => {
  it("opens with the initialise command", () => {
    expect(hex(new EscPos().init().bytes())).toBe("1b 40");
  });

  it("writes a line as codepage bytes with a newline", () => {
    expect(hex(new EscPos().line("AB").bytes())).toBe("41 42 0a");
  });

  it("turns double width and height on and off", () => {
    // GS ! 0x11 is the double-width-and-height mode the spec names for the token.
    expect(hex(new EscPos().double(true).bytes())).toBe("1d 21 11");
    expect(hex(new EscPos().double(false).bytes())).toBe("1d 21 00");
  });

  it("cuts with a feed first, so the tear is below the last line", () => {
    // Cutting flush would slice the final line in half: the blade sits a
    // couple of centimetres past the print head.
    expect(hex(new EscPos().cut().bytes())).toBe("0a 0a 0a 0a 1d 56 41 00");
  });

  it("chains", () => {
    const out = new EscPos().init().align("center").line("HI").align("left").bytes();
    expect(hex(out)).toBe("1b 40 1b 61 01 48 49 0a 1b 61 00");
  });
});
