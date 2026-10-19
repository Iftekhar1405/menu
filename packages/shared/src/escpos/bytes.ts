/**
 * ESC/POS, byte by byte.
 *
 * A thermal printer in text mode takes a stream of single-byte characters
 * with escape sequences interleaved. There is no library here because the
 * subset a kitchen ticket needs is a dozen commands, and the dependency
 * would have to be audited for exactly the codepage problem below.
 */

const ESC = 0x1b;
const GS = 0x1d;

/**
 * Characters outside the printer's codepage, spelled in characters that are
 * inside it. Accents fold to their base letter rather than disappearing: a
 * menu with an accented dish name should print the dish, not a hole.
 */
const FOLD: Record<string, string> = {
  "à": "a", "á": "a", "â": "a", "ä": "a", "ã": "a", "å": "a",
  "è": "e", "é": "e", "ê": "e", "ë": "e",
  "ì": "i", "í": "i", "î": "i", "ï": "i",
  "ò": "o", "ó": "o", "ô": "o", "ö": "o", "õ": "o",
  "ù": "u", "ú": "u", "û": "u", "ü": "u",
  "ñ": "n", "ç": "c", "ß": "ss",
  "₹": "Rs.",
  "“": '"', "”": '"', "‘": "'", "’": "'",
  "–": "-", "—": "-", "…": "...", "•": "*",
};

/**
 * Text the printer can actually render.
 *
 * Three things happen here, and the third is the important one:
 *
 *  1. Printable ASCII passes through.
 *  2. Anything in FOLD is replaced by its spelled-out equivalent.
 *  3. Everything else is DROPPED — not replaced with a question mark, not
 *     passed through as UTF-8.
 *
 * Passing through is the dangerous option. Text mode is a single-byte
 * codepage, so a Devanagari character arrives as two or three bytes, each
 * printed as a separate wrong glyph; and bytes below 0x20 are commands, so
 * a sequence can leave the printer in a mode the next ticket inherits.
 * Rasterising those lines as a bitmap is the real fix and is a named
 * follow-up, not part of this.
 */
export function toCp437(s: string): string {
  let out = "";
  for (const ch of s) {
    const folded = FOLD[ch];
    if (folded !== undefined) {
      out += folded;
      continue;
    }
    const code = ch.codePointAt(0)!;
    // Printable ASCII only. Newlines are added by the builder, never carried
    // in from a dish name.
    if (code >= 0x20 && code <= 0x7e) out += ch;
  }
  return out;
}

export class EscPos {
  private readonly parts: number[] = [];

  private push(...b: number[]): this {
    this.parts.push(...b);
    return this;
  }

  /** ESC @ - resets font, alignment and emphasis left over from the last ticket. */
  init(): this {
    return this.push(ESC, 0x40);
  }

  text(s: string): this {
    for (const ch of toCp437(s)) this.parts.push(ch.charCodeAt(0));
    return this;
  }

  line(s = ""): this {
    return this.text(s).push(0x0a);
  }

  align(a: "left" | "center" | "right"): this {
    return this.push(ESC, 0x61, a === "center" ? 1 : a === "right" ? 2 : 0);
  }

  bold(on: boolean): this {
    return this.push(ESC, 0x45, on ? 1 : 0);
  }

  /** GS ! 0x11 - double width and double height, the token's size. */
  double(on: boolean): this {
    return this.push(GS, 0x21, on ? 0x11 : 0x00);
  }

  /** GS ! 0x01 - double height only, which is how item lines are read over a pass. */
  doubleHeight(on: boolean): this {
    return this.push(GS, 0x21, on ? 0x01 : 0x00);
  }

  feed(n = 1): this {
    for (let i = 0; i < n; i++) this.parts.push(0x0a);
    return this;
  }

  /**
   * GS V A 0 - partial cut, after four blank lines.
   *
   * The blade sits a couple of centimetres past the print head, so cutting
   * flush would slice through the last line of the ticket.
   */
  cut(): this {
    return this.feed(4).push(GS, 0x56, 0x41, 0x00);
  }

  bytes(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}
