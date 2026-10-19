import { describe, expect, it } from "vitest";
import { centre, columnsFor, rule, twoCol, wrap } from "./layout";

describe("columnsFor", () => {
  it("maps paper width to the columns the roll actually has", () => {
    expect(columnsFor(58)).toBe(32);
    expect(columnsFor(80)).toBe(48);
  });
});

describe("wrap", () => {
  it("leaves a line that fits alone", () => {
    expect(wrap("Chicken Biryani", 32)).toEqual(["Chicken Biryani"]);
  });

  it("breaks on a space rather than mid-word", () => {
    expect(wrap("Hyderabadi Double Ka Meetha with extra nuts", 32)).toEqual([
      "Hyderabadi Double Ka Meetha with",
      "extra nuts",
    ]);
  });

  it("breaks a single word longer than the roll", () => {
    // Not hypothetical: a dish name pasted without spaces would otherwise
    // run off the edge of the paper, where nobody can see it is missing.
    expect(wrap("Supercalifragilisticexpialidocious", 16)).toEqual([
      "Supercalifragili",
      "sticexpialidocio",
      "us",
    ]);
  });

  it("indents every line after the first", () => {
    // Continuation lines are indented so a wrapped dish name cannot be read
    // as a second dish.
    expect(wrap("Mutton Haleem Slow Cooked", 16, 4)).toEqual([
      "Mutton Haleem",
      "    Slow Cooked",
    ]);
  });

  it("returns nothing for empty text", () => {
    expect(wrap("", 32)).toEqual([]);
  });
});

describe("twoCol", () => {
  it("pushes the right column to the right edge", () => {
    expect(twoCol("TOKEN 14", "TABLE 7", 32)).toBe("TOKEN 14" + " ".repeat(17) + "TABLE 7");
    expect(twoCol("TOKEN 14", "TABLE 7", 32)).toHaveLength(32);
  });

  it("keeps at least one space between the columns when they nearly collide", () => {
    // Truncating the left is better than two values run together into one
    // unreadable string, which is what a naive padEnd would produce.
    const out = twoCol("A very long dish name indeed", "1290.00", 24);
    expect(out).toHaveLength(24);
    expect(out.endsWith(" 1290.00")).toBe(true);
  });
});

describe("centre", () => {
  it("pads the left so the text sits in the middle", () => {
    expect(centre("TOKEN", 11)).toBe("   TOKEN");
  });

  it("does not pad text already wider than the roll", () => {
    expect(centre("ABCDEF", 4)).toBe("ABCDEF");
  });
});

describe("rule", () => {
  it("fills the width", () => {
    expect(rule(8)).toBe("========");
    expect(rule(8, "-")).toBe("--------");
  });
});
