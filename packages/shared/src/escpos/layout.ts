/**
 * A roll is columns, not pixels.
 *
 * Every ticket's layout is arithmetic over the column count, kept here so
 * the three encoders cannot each invent their own idea of what fits. Width
 * is a property of the output (the printer), not of the ticket, so the
 * encoders take it as an argument and never assume one.
 */

export type PaperWidth = 58 | 80;

export function columnsFor(w: PaperWidth): 32 | 48 {
  return w === 80 ? 48 : 32;
}

/**
 * Text broken to fit, breaking on spaces where it can.
 *
 * A word longer than the roll is cut rather than allowed to overflow:
 * overflow on a thermal printer is silent, and a missing half of a dish
 * name is worse than an ugly break.
 *
 * `indent` applies to continuation lines only, so a wrapped dish name is
 * visibly one dish rather than two.
 */
export function wrap(text: string, cols: number, indent = 0): string[] {
  if (text.length === 0) return [];

  const lines: string[] = [];
  let rest = text;

  while (rest.length > 0) {
    const pad = lines.length === 0 ? 0 : indent;
    const room = Math.max(1, cols - pad);

    if (rest.length <= room) {
      lines.push(" ".repeat(pad) + rest);
      break;
    }

    // Prefer the last space that fits; fall back to a hard cut for one
    // unbroken word.
    const slice = rest.slice(0, room + 1);
    const at = slice.lastIndexOf(" ");
    const cut = at > 0 ? at : room;

    lines.push(" ".repeat(pad) + rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }

  return lines;
}

/**
 * Left-aligned and right-aligned on one line.
 *
 * When the two would collide the LEFT is truncated, because the right is
 * always the short, load-bearing value — a price, a table number, a KOT
 * number — and a price run together with a dish name is unreadable in a way
 * a shortened dish name is not.
 */
export function twoCol(left: string, right: string, cols: number): string {
  const room = cols - right.length - 1;
  const l = left.length > room ? left.slice(0, Math.max(0, room)) : left;
  const gap = Math.max(1, cols - l.length - right.length);
  return l + " ".repeat(gap) + right;
}

/** Centred by left padding only — trailing spaces are wasted bytes. */
export function centre(text: string, cols: number): string {
  if (text.length >= cols) return text;
  return " ".repeat(Math.floor((cols - text.length) / 2)) + text;
}

export function rule(cols: number, ch = "="): string {
  return ch.repeat(cols);
}
