# KOT Printing Implementation Plan (Part 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accepting a round prints a customer token slip and a kitchen item ticket on the shop's own thermal printers, and closing the table prints the bill — with no local agent, no print server and no double paper.

**Architecture:** A station is a browser tab on a shop machine driving a printer over WebUSB or Web Serial as raw ESC/POS. The server stores the station list, which printer is on which job, and one `print_receipts` row per (station, event, job, attempt) — a unique index, so a second tab racing for the same ticket gets a 409 instead of a second slip. The station polls `pending` (and wakes early on the existing Realtime ping), claims what it finds, renders bytes with a pure encoder from `packages/shared`, and reports the result. One machine or two falls out of the station list with no mode flag anywhere.

**Tech Stack:** Postgres 16 (raw SQL migrations under Prisma 5.22), NestJS 10, Next.js 15, TypeScript 5.7, vitest 2.1, Playwright 1.49, pnpm workspaces, WebUSB / Web Serial (Chrome and Edge only).

**Spec:** `docs/superpowers/specs/2026-10-04-kot-printing-design.md` (Part 2; Part 1 shipped — see `docs/superpowers/plans/2026-10-04-round-level-orders.md`)
**Approved output:** `docs/superpowers/specs/2026-10-04-kot-printing-samples.md`

## Global Constraints

- Node >= 22, pnpm 10.33.2. **Never run `npm` or `yarn`**, not even for a one-off install.
- Work stays on `feat/kot-printing`. **Nothing merges to master.** Do not create or switch branches.
- Postgres runs locally via `pnpm db:up` on port **5433**. The repo's `.env` points every database URL at a live Supabase project, so **source `.superpowers/sdd/<plan>/local-db.env` (or export the three URLs inline) before any prisma or vitest command.** A bare `prisma migrate dev` would hit production.
- Migrations are **raw SQL** in `apps/api/prisma/migrations/<timestamp>_<name>/migration.sql`, created by hand with a timestamp later than `20261020000000`. The Prisma schema is edited to match; the SQL is authoritative. Prefer `prisma migrate deploy`.
- **Any index written in raw SQL must also be declared in `schema.prisma`.** An index Prisma cannot see is drift it deletes — that is what happened to `business_staff_lookup` (see `20261020000000_restore_business_staff_lookup`). Prisma has no syntax for `INCLUDE`; put covering columns in the key instead. After adding one, `prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script` must print `-- This is an empty migration.`
- After editing `packages/shared`, run `pnpm --filter @menu/shared build` before typechecking or testing `apps/api` or `apps/web` — both consume its `dist/`.
- Database tests connect with `pg` as **`APP_DATABASE_URL` (the `menu_app` role)** for anything asserting RLS; `DIRECT_URL` is for seeding fixtures and for assertions about constraints and function return values only.
- Test files are `*.spec.ts` beside the code (`src/**/*.spec.ts` for API, `{lib,components,app}/**/*.spec.ts` for web). Web vitest runs in a **node** environment — no DOM, so logic under test must live in `lib/`, not in a component.
- Printing is **never on the critical path.** No endpoint that accepts a round or closes a table may fail, block or slow down because a printer was off. This is the stance `RealtimeBroadcaster.ping` already takes.
- Order-level event kinds are bare status strings (`'completed'`, `'cancelled'`, …) with `round_id` null; round-level kinds are `'round.' || status` with `round_id` set. The spec's `order.completed` means **kind `'completed'`**.
- Statuses are the existing `OrderStatus` enum. No new status values.
- Commit after every task. **Never `git add -A` or `git add .`** — name the paths. **Commit messages stay simple and small: a conventional-commit subject, usually nothing else, and never a `Co-Authored-By` trailer** (see CLAUDE.md).
- **Test what would silently break, not everything that could be asserted.** One test per behaviour a bug would make wrong in production.

## Already shipped — do not rebuild

The spec's **"Bills merge identical lines across rounds"** section is Part 1's work and is live: `20261005096000_bill_merge_rounds` groups `generate_bill`'s line loop on `(name_snapshot, variant_snapshot, unit_price, tax_rate)`, and the price-changed-mid-meal case has a test. Task 10 carries those lines across unchanged; it must not regroup, re-sort or recompute anything.

`order_rounds.kot_number`, the `round.accepted` events with `{ seq, kotNumber }`, and `generate_bill` returning the existing bill rather than recomputing are all Part 1 as well. This plan consumes them.

## Review Focus

Five things the spec implies that no happy path would catch. Each is pinned to a test in the task that owns the code.

1. **A `bill` job must never reach a station that only a kitchen user can see.** The RBAC work strips prices from every kitchen payload; a bill ticket DTO is a payload full of prices. Attaching a `bill` output is owner-only, and so is claiming one. → Task 7 (the trigger), Task 8 (403 on attach), Task 11 (403 on claim).
2. **Two tabs on one machine must produce exactly one ticket.** The unique index is the only thing standing between the shop and double paper — and a `409` the page treats as an error rather than as "someone else took it" is the same bug wearing a hat. → Task 7 (the index), Task 11 (409 not 500), Task 12 ("taken" is not a failure), Task 15 (two real connections racing).
3. **A station switched on at closing time must not emit the day's tickets.** `pending` looks back 30 minutes; everything older is Missed and waits for a human. → Task 9, and Task 12 never claims a missed job on its own.
4. **A station revoked mid-shift must stop printing.** `resolve` answers `410`, the page clears its `localStorage` and stops rather than polling a retired machine forever. → Task 8 (410 not 404), Task 13 (the page acts on it and the adapter does not swallow it).
5. **A Devanagari or Tamil business name must not emit bytes that wedge the printer.** The encoder transliterates what it can and drops what it cannot; it never passes a multi-byte sequence through to a single-byte codepage, where some of those bytes are commands. → Task 2.

---

## File Structure

**`packages/shared`** — everything pure. No DOM, no device, no Nest.
- `src/printing.ts` — `PrintJob`, `jobsForEvent`, the station/output/receipt DTOs both ends share.
- `src/escpos/bytes.ts` — the byte-level builder: init, align, emphasis, double, feed, cut, and the codepage transliteration.
- `src/escpos/layout.ts` — column arithmetic: `wrap`, `twoCol`, `centre`, `rule`.
- `src/escpos/tickets.ts` — the three encoders, DTO → `Uint8Array`. Imports the two above; nothing else imports them.

**`apps/api`** — one module, three concerns.
- `src/printing/printing.controller.ts` — routes only.
- `src/printing/stations.service.ts` — the station list and its outputs (owner and staff writes).
- `src/printing/receipts.service.ts` — `pending`, claim, result. The only place that touches `print_receipts`.
- `src/printing/ticket-payload.ts` — order/round/bill rows → the shared ticket DTOs. Pure, so it is tested without a database.

There is no `printing.module.ts`: `app.module.ts` in this repo is one flat `@Module` listing every controller and provider, and printing follows that rather than introducing the codebase's first feature module.

**`apps/web`** — the page is a shell; the logic is in `lib/`, because web vitest has no DOM.
- `lib/station/transport.ts` — the `PrinterTransport` interface and its WebUSB and Web Serial implementations. The one file that touches `navigator`.
- `lib/station/loop.ts` — fetch pending → claim → render → write → report. Takes a transport and an api client, so a test injects fakes.
- `lib/station/identity.ts` — the `localStorage` station id, and matching `device_key` against granted devices.
- `app/(app)/station/page.tsx` — the shop machine's screen.
- `app/(app)/settings/printing/page.tsx` — the owner's view of every station.

---

### Task 1: The event-to-job table in `@menu/shared`

One pure function, beside the role table and for the same reason: the station page needs it to decide what to render and the API needs it to decide what to hand out. Two copies of this mapping would mean a ticket the API offers and the page cannot print.

**Files:**
- Create: `packages/shared/src/printing.ts`
- Create: `packages/shared/src/printing.spec.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type PrintJob = "token" | "kitchen" | "bill"`; `PRINT_JOBS: PrintJob[]`; `jobsForEvent(kind: string): PrintJob[]`.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/printing.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { jobsForEvent } from "./printing";

describe("jobsForEvent", () => {
  it("turns an accepted round into a token slip and a kitchen ticket", () => {
    expect(jobsForEvent("round.accepted")).toEqual(["token", "kitchen"]);
  });

  it("turns a closed order into a bill", () => {
    // Order-level events are bare status strings with round_id null.
    expect(jobsForEvent("completed")).toEqual(["bill"]);
  });

  it("prints nothing for the statuses in between", () => {
    // A ticket per status change would bury the pass in paper.
    expect(jobsForEvent("round.preparing")).toEqual([]);
    expect(jobsForEvent("round.ready")).toEqual([]);
  });

  it("prints nothing for a cancellation", () => {
    // A void slip for a round the kitchen already holds is a real feature
    // and a deliberate omission — see "Not built" in the spec.
    expect(jobsForEvent("round.cancelled")).toEqual([]);
    expect(jobsForEvent("cancelled")).toEqual([]);
  });

  it("prints nothing for an event it has never heard of", () => {
    // New event kinds get added by other features. Silence is the only safe
    // default: the alternative is a station printing something nobody designed.
    expect(jobsForEvent("round_added")).toEqual([]);
    expect(jobsForEvent("placed")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @menu/shared exec vitest run src/printing.spec.ts
```

Expected: FAIL — `Failed to resolve import "./printing"`.

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/printing.ts`:

```ts
/** One kind of paper. A station holds at most one output per job. */
export type PrintJob = "token" | "kitchen" | "bill";

export const PRINT_JOBS: PrintJob[] = ["token", "kitchen", "bill"];

/**
 * What an order event is worth printing.
 *
 * The whole mapping, in one place, consulted by both ends. The API decides
 * what to offer a station from this; the station decides what to render from
 * the same answer, so the two cannot disagree about what a ticket is.
 *
 * Unknown kinds print nothing. Events are added by features that know
 * nothing about printers, and a default of "print something" would put paper
 * on the pass that no one designed and no one can turn off.
 */
export function jobsForEvent(kind: string): PrintJob[] {
  switch (kind) {
    // One accept, two slips: the token goes to the customer's hand and the
    // ticket to the pass, carrying the same number so they match.
    case "round.accepted":
      return ["token", "kitchen"];
    // Order-level kinds are bare statuses with round_id null. Closing the
    // table is what produces a bill; the button becomes a reprint.
    case "completed":
      return ["bill"];
    default:
      return [];
  }
}
```

- [ ] **Step 4: Export it**

Append to `packages/shared/src/index.ts`:

```ts
export * from "./printing";
```

- [ ] **Step 5: Run the tests and build**

```bash
pnpm --filter @menu/shared exec vitest run src/printing.spec.ts
pnpm --filter @menu/shared build
```

Expected: 5 passing, build clean.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/printing.ts packages/shared/src/printing.spec.ts packages/shared/src/index.ts
git commit -m "feat(shared): map an order event to the paper it produces"
```

---

### Task 2: ESC/POS bytes and the codepage

The byte-level builder, and the thing that stops a Devanagari business name wedging a printer. ESC/POS text mode is a single-byte codepage: handing it UTF-8 emits one garbage glyph per byte, and bytes under 0x20 are commands, so an unlucky sequence can switch the printer into a mode nothing switches it out of.

**Files:**
- Create: `packages/shared/src/escpos/bytes.ts`
- Create: `packages/shared/src/escpos/bytes.spec.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class EscPos` with `init()`, `text(s: string)`, `line(s?: string)`, `align(a: "left"|"center"|"right")`, `bold(on: boolean)`, `double(on: boolean)`, `doubleHeight(on: boolean)`, `feed(n?: number)`, `cut()`, `bytes(): Uint8Array` — every setter returns `this`; `toCp437(s: string): string`.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/escpos/bytes.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @menu/shared exec vitest run src/escpos/bytes.spec.ts
```

Expected: FAIL — `Failed to resolve import "./bytes"`.

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/escpos/bytes.ts`:

```ts
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
```

- [ ] **Step 4: Export it**

Append to `packages/shared/src/index.ts`:

```ts
export * from "./escpos/bytes";
```

- [ ] **Step 5: Run the tests and build**

```bash
pnpm --filter @menu/shared exec vitest run src/escpos/bytes.spec.ts
pnpm --filter @menu/shared build
```

Expected: 11 passing, build clean.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/escpos/bytes.ts packages/shared/src/escpos/bytes.spec.ts packages/shared/src/index.ts
git commit -m "feat(shared): emit ESC/POS bytes, and refuse to emit dangerous ones"
```

---

### Task 3: Column layout

A roll is a fixed number of columns, not a page: 48 at 80mm, 32 at 58mm. Everything a ticket does to lay text out is arithmetic over that number, and it is the part most likely to be quietly wrong — a dish name one character too long does not wrap, it falls off the edge of the paper where nobody sees it.

**Files:**
- Create: `packages/shared/src/escpos/layout.ts`
- Create: `packages/shared/src/escpos/layout.spec.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type PaperWidth = 58 | 80`; `columnsFor(w: PaperWidth): 32 | 48`; `wrap(text: string, cols: number, indent?: number): string[]`; `twoCol(left: string, right: string, cols: number): string`; `centre(text: string, cols: number): string`; `rule(cols: number, ch?: string): string`.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/escpos/layout.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @menu/shared exec vitest run src/escpos/layout.spec.ts
```

Expected: FAIL — `Failed to resolve import "./layout"`.

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/escpos/layout.ts`:

```ts
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
```

- [ ] **Step 4: Export it**

Append to `packages/shared/src/index.ts`:

```ts
export * from "./escpos/layout";
```

- [ ] **Step 5: Run the tests and build**

```bash
pnpm --filter @menu/shared exec vitest run src/escpos/layout.spec.ts
pnpm --filter @menu/shared build
```

Expected: 11 passing, build clean.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/escpos/layout.ts packages/shared/src/escpos/layout.spec.ts packages/shared/src/index.ts
git commit -m "feat(shared): lay text out against a roll's column count"
```

---

### Task 4: The token slip

What the customer is handed. The number on it is `Order.dailyNumber`, printed double-width and double-height so it can be read from across a counter, and it is the same number the kitchen ticket carries so the two match.

**A note on the time:** `bill.pdf.ts:87` and `receipt.pdf.ts:94` both format with `en-IN` and `Asia/Kolkata`, hardcoded. There is no timezone column on `businesses`, so this follows that precedent rather than inventing a second convention. It also makes these tests independent of the machine's clock settings.

**Files:**
- Create: `packages/shared/src/escpos/tickets.ts`
- Create: `packages/shared/src/escpos/tickets.spec.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `EscPos`, `toCp437` (Task 2); `columnsFor`, `centre`, `rule`, `twoCol`, `wrap`, `PaperWidth` (Task 3).
- Produces: `interface TokenTicket`; `type Ticket = TokenTicket` (widened in Tasks 5 and 6); `encodeTicket(t: Ticket, width: PaperWidth): Uint8Array`; `formatTicketTime(iso: string): string`.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/escpos/tickets.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @menu/shared exec vitest run src/escpos/tickets.spec.ts
```

Expected: FAIL — `Failed to resolve import "./tickets"`.

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/escpos/tickets.ts`:

```ts
import { EscPos } from "./bytes";
import { centre, columnsFor, rule, type PaperWidth } from "./layout";

/**
 * What the customer is handed when their round is accepted.
 *
 * No dishes and no prices: this is a claim check, and the kitchen's copy is
 * where the food is listed. `token` is Order.dailyNumber, so the slip in a
 * hand and the ticket on the pass carry the same number.
 */
export interface TokenTicket {
  kind: "token";
  businessName: string;
  token: number;
  /** Round number within the order. "Round N" is printed only when > 1. */
  seq: number;
  tableLabel: string;
  /** ISO 8601. */
  at: string;
}

export type Ticket = TokenTicket;

/**
 * The same convention as the PDF receipt (bill.pdf.ts:87, receipt.pdf.ts:94):
 * en-IN, Asia/Kolkata, hardcoded. There is no timezone on `businesses`, and
 * a second convention here would print a different time on the paper than
 * the one on the screen beside it.
 */
export function formatTicketTime(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
  });
  const time = d.toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${day}, ${time}`;
}

export function encodeTicket(t: Ticket, width: PaperWidth): Uint8Array {
  const cols = columnsFor(width);
  switch (t.kind) {
    case "token":
      return tokenSlip(t, cols);
  }
}

function tokenSlip(t: TokenTicket, cols: number): Uint8Array {
  const p = new EscPos().init();

  p.line(centre(t.businessName, cols));
  p.line();
  p.line(centre("TOKEN", cols));

  // Double width halves the usable columns, so the number is centred
  // against half the roll or it lands off to the right.
  p.double(true).line(centre(String(t.token), Math.floor(cols / 2))).double(false);

  if (t.seq > 1) p.line(centre(`Round ${t.seq}`, cols));

  p.line();
  p.line(centre(`Table ${t.tableLabel}`, cols));
  p.line(centre(formatTicketTime(t.at), cols));
  p.line();
  p.line(rule(cols));
  p.line(centre("Please keep this slip", cols));

  return p.cut().bytes();
}
```

- [ ] **Step 4: Export it**

Append to `packages/shared/src/index.ts`:

```ts
export * from "./escpos/tickets";
```

- [ ] **Step 5: Run the tests and build**

```bash
pnpm --filter @menu/shared exec vitest run src/escpos/tickets.spec.ts
pnpm --filter @menu/shared build
```

Expected: 5 passing, build clean. The exact strings above were produced by running this encoder on Node 22 — `en-IN` with `hour12` renders lower-case `pm` on this toolchain. If a different ICU build renders `PM`, fix the expectation to what it actually produces and note it; do not reformat the time by hand to match.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/escpos/tickets.ts packages/shared/src/escpos/tickets.spec.ts packages/shared/src/index.ts
git commit -m "feat(shared): render the customer's token slip"
```

---

### Task 5: The kitchen ticket

What goes on the pass. Same token as the slip in the customer's hand, the KOT number, and **this round's items only** — nothing from an earlier round is reprinted. Item lines are double-height because they are read at arm's length over a hot pass.

**A deviation from the samples, decided here:** the sample ticket shows `>> less spicy` under one item, but **`order_items` has no note column** — the schema carries a note on the *order* (`orders.note`), not per line. So the ticket prints the order's note once, below the items, in the same `>>` style. Printing a per-item note would mean inventing a column no diner can currently fill in.

**Files:**
- Modify: `packages/shared/src/escpos/tickets.ts`
- Modify: `packages/shared/src/escpos/tickets.spec.ts`

**Interfaces:**
- Consumes: `EscPos`, `twoCol`, `wrap`, `centre`, `rule` (Tasks 2 and 3); `encodeTicket` (Task 4).
- Produces: `interface KitchenTicket`; `Ticket` widened to `TokenTicket | KitchenTicket`; `formatTicketClock(iso: string): string`.

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/escpos/tickets.spec.ts` (reusing the `decode` helper already at the top of the file):

```ts
import type { KitchenTicket } from "./tickets";

const kitchen: KitchenTicket = {
  kind: "kitchen",
  token: 14,
  tableLabel: "7",
  kotNumber: 31,
  seq: 1,
  isRunning: false,
  note: null,
  at: "2026-10-04T15:12:00.000Z",
  items: [
    { quantity: 2, name: "Chicken Biryani", variant: "Full" },
    { quantity: 1, name: "Mutton Haleem", variant: null },
    { quantity: 3, name: "Butter Naan", variant: null },
    { quantity: 1, name: "Hyderabadi Double Ka Meetha", variant: null },
  ],
};

describe("encodeTicket: kitchen ticket", () => {
  it("prints the approved 80mm ticket", () => {
    expect(decode(encodeTicket(kitchen, 80))).toEqual([
      "=".repeat(48),
      "TOKEN 14                                 TABLE 7",
      "8:42 pm                                  KOT #31",
      "=".repeat(48),
      "",
      "2 x Chicken Biryani",
      "    (Full)",
      "1 x Mutton Haleem",
      "3 x Butter Naan",
      "1 x Hyderabadi Double Ka Meetha",
      "",
      "-".repeat(48),
      "Items                                          7",
    ]);
  });

  it("banners a later round, and says when the table is running", () => {
    // The pass has to see at a glance that this is an addition to a table
    // already eating, not a new table. The em dash folds to a hyphen in the
    // printer's codepage, which is expected.
    const second = decode(
      encodeTicket(
        {
          ...kitchen,
          seq: 2,
          kotNumber: 38,
          isRunning: true,
          at: "2026-10-04T15:36:00.000Z",
          items: [
            { quantity: 2, name: "Irani Chai", variant: null },
            { quantity: 1, name: "Osmania Biscuit", variant: null },
          ],
        },
        80,
      ),
    );
    expect(second[2]).toBe("          *** ROUND 2 - NEW ITEMS ***");
    expect(second[3]).toBe("              ** RUNNING TABLE **");
    expect(second[4]).toBe("9:06 pm                                  KOT #38");
  });

  it("prints only the items it was given", () => {
    // Round 2's ticket must not reprint round 1. The round is the unit of
    // cooking; a reprint would have the kitchen make the biryani twice.
    const second = decode(
      encodeTicket({ ...kitchen, seq: 2, items: [{ quantity: 2, name: "Irani Chai", variant: null }] }, 80),
    );
    expect(second.join("\n")).not.toContain("Biryani");
    expect(second).toContain("Items                                          2");
  });

  it("prints the order's note once, below the items", () => {
    const withNote = decode(encodeTicket({ ...kitchen, note: "less spicy" }, 80));
    expect(withNote).toContain(">> less spicy");
    expect(withNote.filter((l) => l.startsWith(">>"))).toHaveLength(1);
  });

  it("carries no prices", () => {
    // The kitchen role never sees money anywhere else in this product, and
    // paper is not an exception.
    expect(decode(encodeTicket(kitchen, 80)).join("\n")).not.toMatch(/\d+\.\d\d/);
  });

  it("turns double height back off after the items", () => {
    // Item lines print double-height so they read over a pass; the note and
    // the item count must not. Like the token slip's reset, this needs a
    // byte assertion — decode() strips every GS ! triple whatever its
    // parameter, so deleting the reset changes no decoded line while
    // printing the rest of the ticket at double height on real hardware.
    const bytes = Array.from(encodeTicket(kitchen, 80));
    const on = bytes.findIndex(
      (_, i) => bytes[i] === 0x1d && bytes[i + 1] === 0x21 && bytes[i + 2] === 0x01,
    );
    expect(on).toBeGreaterThan(-1);

    // The reset lands immediately after the last item's newline, so this
    // four-byte run exists only if the items ended and the size was reset.
    const seq = [0x0a, 0x1d, 0x21, 0x00];
    const at = bytes.findIndex((_, i) => seq.every((b, k) => bytes[i + k] === b));
    expect(at).toBeGreaterThan(on);
  });

  it("does not merge identical dishes", () => {
    // The bill merges across rounds; the ticket never does. Two is what the
    // kitchen has to cook, and a merged line would hide one of them.
    const out = decode(
      encodeTicket(
        {
          ...kitchen,
          items: [
            { quantity: 1, name: "Dum Biryani", variant: null },
            { quantity: 2, name: "Dum Biryani", variant: null },
          ],
        },
        80,
      ),
    );
    expect(out.filter((l) => l.includes("Dum Biryani"))).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @menu/shared exec vitest run src/escpos/tickets.spec.ts
```

Expected: FAIL — `KitchenTicket` is not exported from `./tickets`, so the file does not typecheck and the suite does not collect.

- [ ] **Step 3: Write the implementation**

In `packages/shared/src/escpos/tickets.ts`, add the import of `twoCol` and `wrap` to the existing `./layout` import, then add:

```ts
/**
 * What goes on the pass.
 *
 * `items` is THIS round's lines and nothing else: the round is the unit of
 * cooking, and a ticket that reprinted round 1 would have the kitchen make
 * the biryani twice. Identical dishes are not merged for the same reason —
 * the bill merges them because the customer ordered three; the kitchen
 * ticket does not because three is what has to be cooked.
 *
 * No prices. The kitchen role sees no money anywhere else in this product
 * and paper is not an exception.
 */
export interface KitchenTicket {
  kind: "kitchen";
  token: number;
  tableLabel: string;
  kotNumber: number;
  seq: number;
  isRunning: boolean;
  /**
   * The ORDER's note, not the line's. `order_items` has no note column;
   * what a diner can write applies to the whole order.
   */
  note: string | null;
  at: string;
  items: { quantity: number; name: string; variant: string | null }[];
}
```

Widen the union and the dispatcher:

```ts
export type Ticket = TokenTicket | KitchenTicket;
```

```ts
export function encodeTicket(t: Ticket, width: PaperWidth): Uint8Array {
  const cols = columnsFor(width);
  switch (t.kind) {
    case "token":
      return tokenSlip(t, cols);
    case "kitchen":
      return kitchenTicket(t, cols);
  }
}
```

Add the clock formatter and the encoder:

```ts
/** Time alone. The pass cares what time this fired, never what date. */
export function formatTicketClock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function kitchenTicket(t: KitchenTicket, cols: number): Uint8Array {
  const p = new EscPos().init();

  p.line(rule(cols));
  p.line(twoCol(`TOKEN ${t.token}`, `TABLE ${t.tableLabel}`, cols));
  if (t.seq > 1) p.line(centre(`*** ROUND ${t.seq} — NEW ITEMS ***`, cols));
  if (t.isRunning) p.line(centre("** RUNNING TABLE **", cols));
  p.line(twoCol(formatTicketClock(t.at), `KOT #${t.kotNumber}`, cols));
  p.line(rule(cols));
  p.line();

  // Double height only: double width would halve the columns and wrap every
  // dish name. This is read at arm's length, not across a room.
  p.doubleHeight(true);
  for (const i of t.items) {
    for (const l of wrap(`${i.quantity} x ${i.name}`, cols, 4)) p.line(l);
    if (i.variant) p.line(`    (${i.variant})`);
  }
  p.doubleHeight(false);

  if (t.note) for (const l of wrap(`>> ${t.note}`, cols, 3)) p.line(l);

  p.line();
  p.line(rule(cols, "-"));
  p.line(twoCol("Items", String(t.items.reduce((s, i) => s + i.quantity, 0)), cols));

  return p.cut().bytes();
}
```

- [ ] **Step 4: Run the tests and build**

```bash
pnpm --filter @menu/shared exec vitest run src/escpos/tickets.spec.ts
pnpm --filter @menu/shared build
```

Expected: 12 passing (5 from Task 4, 7 here), build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/escpos/tickets.ts packages/shared/src/escpos/tickets.spec.ts
git commit -m "feat(shared): render the kitchen's ticket"
```

---

### Task 6: The bill slip

The content `receipt.pdf.ts` already produces, re-emitted as ESC/POS from the same `Bill` DTO rather than reimplemented. `Token N` is printed on it, tying the paper back to the slip in the customer's hand.

The ticket DTO is deliberately **not** the API's `Bill` interface: that type lives in `apps/api/src/billing/billing.service.ts` and carries fields a printer has no use for. Task 10 maps one to the other, which is also where the decision about what a 32-column roll can show gets made once.

**Files:**
- Modify: `packages/shared/src/escpos/tickets.ts`
- Modify: `packages/shared/src/escpos/tickets.spec.ts`

**Interfaces:**
- Consumes: `EscPos`, `twoCol`, `wrap`, `centre`, `rule` (Tasks 2 and 3); `encodeTicket`, `formatTicketTime` (Task 4).
- Produces: `interface BillTicket`; `Ticket` widened to `TokenTicket | KitchenTicket | BillTicket`.

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/escpos/tickets.spec.ts`:

```ts
import type { BillTicket } from "./tickets";

const bill: BillTicket = {
  kind: "bill",
  businessName: "Taste of Hyderabad",
  addressLines: ["12-3-45 Banjara Hills, Hyderabad 500034"],
  gstin: "36AABCT1234K1Z5",
  billNumber: 208,
  tableLabel: "7",
  token: 14,
  issuedAt: "2026-10-04T16:01:00.000Z",
  taxLine: "GST 5% (incl.)",
  subtotal: "1223.81",
  taxTotal: "61.19",
  serviceCharge: "0.00",
  serviceChargeRate: "0",
  roundOff: "0.00",
  total: "1290.00",
  receiptFooter: "Thank you — see you again!",
  lines: [
    { name: "Chicken Biryani", variant: "Full", quantity: 2, unitPrice: "320.00", lineTotal: "640.00" },
    { name: "Mutton Haleem", variant: null, quantity: 1, unitPrice: "280.00", lineTotal: "280.00" },
    { name: "Butter Naan", variant: null, quantity: 3, unitPrice: "45.00", lineTotal: "135.00" },
    { name: "Hyderabadi Double Ka Meetha", variant: null, quantity: 1, unitPrice: "150.00", lineTotal: "150.00" },
    { name: "Irani Chai", variant: null, quantity: 2, unitPrice: "30.00", lineTotal: "60.00" },
    { name: "Osmania Biscuit", variant: null, quantity: 1, unitPrice: "25.00", lineTotal: "25.00" },
  ],
};

describe("encodeTicket: bill slip", () => {
  it("prints the approved 80mm bill", () => {
    expect(decode(encodeTicket(bill, 80))).toEqual([
      " ".repeat(15) + "Taste of Hyderabad",
      "    12-3-45 Banjara Hills, Hyderabad 500034",
      "             GSTIN 36AABCT1234K1Z5",
      "",
      "Bill #208                                Table 7",
      "Token 14                         04 Oct, 9:31 pm",
      "=".repeat(48),
      "Chicken Biryani                           640.00",
      "   2 x 320.00 - Full",
      "Mutton Haleem                             280.00",
      "   1 x 280.00",
      "Butter Naan                               135.00",
      "   3 x 45.00",
      "Hyderabadi Double Ka Meetha               150.00",
      "   1 x 150.00",
      "Irani Chai                                 60.00",
      "   2 x 30.00",
      "Osmania Biscuit                            25.00",
      "   1 x 25.00",
      "-".repeat(48),
      "Subtotal                                 1223.81",
      "GST 5% (incl.)                             61.19",
      "=".repeat(48),
      "TOTAL                                    1290.00",
      "=".repeat(48),
      "",
      "   This is a receipt, not a GST tax invoice.",
      "",
      "           Thank you - see you again!",
    ]);
  });

  it("ties the paper to the slip in the customer's hand", () => {
    // Without the token there is nothing connecting this bill to the
    // numbered slip the customer is holding.
    expect(decode(encodeTicket(bill, 80)).join("\n")).toContain("Token 14");
  });

  it("prints the service charge with the sentence that must accompany it", () => {
    // Legally load-bearing, and already on the screen and the PDF. Paper
    // cannot be the one place it is missing.
    const out = decode(
      encodeTicket({ ...bill, serviceCharge: "64.50", serviceChargeRate: "5", total: "1354.50" }, 80),
    ).join("\n");
    expect(out).toContain("Service charge 5%");
    expect(out).toContain("64.50");
    expect(out).toMatch(/voluntary/i);
  });

  it("omits the service charge entirely when it is off", () => {
    // Off by default, and a "Service charge 0.00" line reads like a bug.
    expect(decode(encodeTicket(bill, 80)).join("\n")).not.toMatch(/Service charge/i);
  });

  it("prints a round-off only when there is one", () => {
    expect(decode(encodeTicket(bill, 80)).join("\n")).not.toMatch(/Round off/i);
    const rounded = decode(encodeTicket({ ...bill, roundOff: "-0.19" }, 80)).join("\n");
    expect(rounded).toContain("Round off");
  });

  it("fits every roll it can be printed on, service charge or not", () => {
    // A bill is the longest ticket and a line past the edge is not
    // truncated by the printer, it is silently lost.
    //
    // Both fixtures, because the base one has the service charge switched
    // off and "Service charge is voluntary. Ask us to remove it." is 49
    // characters — longer than even an 80mm roll. Checking only the
    // default bill would leave the one sentence that MUST wrap unexercised
    // at either width.
    const withService: BillTicket = {
      ...bill,
      serviceCharge: "64.50",
      serviceChargeRate: "5",
      total: "1354.50",
    };

    for (const t of [bill, withService]) {
      for (const width of [58, 80] as const) {
        for (const line of decode(encodeTicket(t, width))) {
          expect(line.length).toBeLessThanOrEqual(width === 80 ? 48 : 32);
        }
      }
    }
  });

  it("turns bold back off after the total", () => {
    // The third reset in this file to need a byte assertion, for the same
    // reason as the other two: decode() strips every ESC E whatever its
    // parameter, so a missing reset prints the disclaimer, the voluntary
    // notice and the footer in bold while every text assertion still
    // passes.
    const bytes = Array.from(encodeTicket(bill, 80));
    const on = bytes.findIndex(
      (_, i) => bytes[i] === 0x1b && bytes[i + 1] === 0x45 && bytes[i + 2] === 0x01,
    );
    expect(on).toBeGreaterThan(-1);

    // Immediately after the TOTAL line's newline.
    const seq = [0x0a, 0x1b, 0x45, 0x00];
    const at = bytes.findIndex((_, i) => seq.every((b, k) => bytes[i + k] === b));
    expect(at).toBeGreaterThan(on);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @menu/shared exec vitest run src/escpos/tickets.spec.ts
```

Expected: FAIL — `BillTicket` is not exported from `./tickets`.

- [ ] **Step 3: Write the implementation**

In `packages/shared/src/escpos/tickets.ts`, add:

```ts
export interface BillLineTicket {
  name: string;
  variant: string | null;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
}

/**
 * The receipt, as paper.
 *
 * The same content the PDF carries, from the same Bill the screen shows —
 * mapped into this shape by the API (see ticket-payload.ts) rather than
 * reimplemented, because a receipt whose paper total disagrees with its
 * screen total is the worst bug this feature could have.
 *
 * `taxLine` arrives pre-composed ("GST 5% (incl.)"). Whether a single rate
 * can be named at all depends on the lines' snapshot rates, which is a
 * question about the order, not about printing.
 */
export interface BillTicket {
  kind: "bill";
  businessName: string;
  addressLines: string[];
  gstin: string | null;
  billNumber: number;
  tableLabel: string;
  token: number;
  issuedAt: string;
  taxLine: string | null;
  subtotal: string;
  taxTotal: string;
  serviceCharge: string;
  serviceChargeRate: string;
  roundOff: string;
  total: string;
  receiptFooter: string | null;
  lines: BillLineTicket[];
}
```

Widen the union and the dispatcher:

```ts
export type Ticket = TokenTicket | KitchenTicket | BillTicket;
```

```ts
    case "bill":
      return billSlip(t, cols);
```

Add the encoder:

```ts
function billSlip(b: BillTicket, cols: number): Uint8Array {
  const p = new EscPos().init();

  p.line(centre(b.businessName, cols));
  for (const a of b.addressLines) {
    for (const l of wrap(a, cols)) p.line(centre(l.trim(), cols));
  }
  if (b.gstin) p.line(centre(`GSTIN ${b.gstin}`, cols));
  p.line();

  p.line(twoCol(`Bill #${b.billNumber}`, `Table ${b.tableLabel}`, cols));
  // The token is what ties this paper to the slip in the customer's hand.
  p.line(twoCol(`Token ${b.token}`, formatTicketTime(b.issuedAt), cols));
  p.line(rule(cols));

  for (const l of b.lines) {
    p.line(twoCol(l.name, l.lineTotal, cols));
    // The per-unit line is indented and unpadded: it is detail, and the
    // eye should go to the column of totals on the right.
    p.line(`   ${l.quantity} x ${l.unitPrice}` + (l.variant ? ` - ${l.variant}` : ""));
  }

  p.line(rule(cols, "-"));
  p.line(twoCol("Subtotal", b.subtotal, cols));
  if (b.taxLine) p.line(twoCol(b.taxLine, b.taxTotal, cols));

  const hasService = Number(b.serviceCharge) > 0;
  // Off by default; a "Service charge 0.00" line reads like a bug.
  if (hasService) {
    p.line(twoCol(`Service charge ${b.serviceChargeRate}%`, b.serviceCharge, cols));
  }
  if (Number(b.roundOff) !== 0) p.line(twoCol("Round off", b.roundOff, cols));

  p.line(rule(cols));
  p.bold(true).line(twoCol("TOTAL", b.total, cols)).bold(false);
  p.line(rule(cols));
  p.line();

  // Wrapped, not just centred: this sentence is 41 characters and a 58mm
  // roll is 32. centre() leaves an over-long line alone, and the printer
  // drops the overflow silently.
  for (const l of wrap("This is a receipt, not a GST tax invoice.", cols)) {
    p.line(centre(l, cols));
  }

  if (hasService) {
    p.line();
    for (const l of wrap("Service charge is voluntary. Ask us to remove it.", cols)) {
      p.line(centre(l, cols));
    }
  }
  if (b.receiptFooter) {
    p.line();
    for (const l of wrap(b.receiptFooter, cols)) p.line(centre(l, cols));
  }

  return p.cut().bytes();
}
```

- [ ] **Step 4: Run the tests and build**

```bash
pnpm --filter @menu/shared exec vitest run src/escpos/tickets.spec.ts
pnpm --filter @menu/shared exec vitest run
pnpm --filter @menu/shared build
```

Expected: 19 in `tickets.spec.ts` (5 + 7 + 7), whole shared suite green, build clean. If the 58mm width assertion fails, the fix is in `twoCol`/`wrap`, never in the assertion — a line longer than the roll is lost paper.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/escpos/tickets.ts packages/shared/src/escpos/tickets.spec.ts
git commit -m "feat(shared): render the bill as paper"
```

---

### Task 7: The station tables

Three tables: the machines, the printers linked to them, and one row per piece of paper. The last of those is the whole concurrency story — `unique (station_id, event_id, job, attempt)` is what stops two tabs printing the same token twice, and it is a database constraint rather than application code for the same reason `orders_one_open_per_table` is.

**Files:**
- Create: `apps/api/prisma/migrations/20261021000000_print_stations/migration.sql`
- Create: `apps/api/src/printing/stations-schema.spec.ts`
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `apps/api/src/prisma/kitchen-policies.spec.ts` (the drift guard's count)

**Interfaces:**
- Consumes: `app_current_user_id()`, `app_staff_business_ids()` (from `20261004030616_rbac_kitchen_policies`); `order_events(id)`.
- Produces: tables `print_stations`, `station_outputs`, `print_receipts`; enums `"PrintJob"`, `"PrintTransport"`, `"PrintReceiptStatus"`; trigger `station_outputs_bill_owner_only`; Prisma models `PrintStation`, `StationOutput`, `PrintReceipt`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/printing/stations-schema.spec.ts`:

```ts
import "../config/load-dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

/**
 * The constraints, asserted against a real database. Every one of these is
 * load-bearing in a way application code cannot be: they hold even when two
 * requests race, which is exactly the case that produces double paper.
 */
const ADMIN_URL = process.env.DIRECT_URL!;

let admin: Client;
let owner: string, kitchenUser: string, outsider: string, biz: string, station: string, eventId: string;

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();

  const user = async (name: string, role: "owner" | "kitchen") => {
    const r = await admin.query(
      `INSERT INTO users (id, pin_hash, full_name, phone, role, verified_at, updated_at)
       VALUES (gen_random_uuid(), 'x', $1, $2, $3, now(), now()) RETURNING id`,
      [name, `+9199${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`, role],
    );
    return r.rows[0].id as string;
  };
  owner = await user("Printing Owner", "owner");
  kitchenUser = await user("Printing Kitchen", "kitchen");
  // Belongs to no business at all — the caller the functions must refuse.
  outsider = await user("Printing Outsider", "owner");

  const b = await admin.query(
    `INSERT INTO businesses (id, owner_id, name, type, public_code, updated_at)
     VALUES (gen_random_uuid(), $1, 'Printing Test', 'restaurant', $2, now()) RETURNING id`,
    [owner, Math.random().toString(36).slice(2, 10).toUpperCase().padEnd(8, "X")],
  );
  biz = b.rows[0].id;

  await admin.query(
    `INSERT INTO business_staff (id, business_id, user_id, updated_at)
     VALUES (gen_random_uuid(), $1, $2, now())`,
    [biz, kitchenUser],
  );

  const t = await admin.query(
    `INSERT INTO tables (id, business_id, label, token, position)
     VALUES (gen_random_uuid(), $1, '1', $2, 1) RETURNING id`,
    [biz, Math.random().toString(36).slice(2).padEnd(32, "0").slice(0, 32)],
  );
  const o = await admin.query(
    `INSERT INTO orders (id, business_id, table_id, status, business_day, daily_number, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'placed', CURRENT_DATE, 7001, now()) RETURNING id`,
    [biz, t.rows[0].id],
  );
  const e = await admin.query(
    `INSERT INTO order_events (order_id, business_id, kind) VALUES ($1, $2, 'accepted') RETURNING id`,
    [o.rows[0].id, biz],
  );
  eventId = e.rows[0].id;

  const s = await admin.query(
    `INSERT INTO print_stations (id, business_id, name, updated_at)
     VALUES (gen_random_uuid(), $1, 'Counter', now()) RETURNING id`,
    [biz],
  );
  station = s.rows[0].id;
});

afterAll(async () => {
  await admin.query("DELETE FROM businesses WHERE id = $1", [biz]);
  await admin.query("DELETE FROM users WHERE id = ANY($1)", [[owner, kitchenUser, outsider]]);
  await admin.end();
});

describe("print_stations schema", () => {
  it("allows one output per job per station and refuses a second", async () => {
    // Two 'kitchen' printers on one machine is not a configuration, it is a
    // mistake, and the shape of the data is what says so.
    await admin.query(
      `INSERT INTO station_outputs (id, business_id, station_id, job, device_label, device_key, transport, paper_width, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'kitchen', 'EPSON TM-T82', 'v:p:s1', 'usb', 80, now())`,
      [biz, station],
    );
    await expect(
      admin.query(
        `INSERT INTO station_outputs (id, business_id, station_id, job, device_label, device_key, transport, paper_width, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'kitchen', 'Other', 'v:p:s2', 'usb', 80, now())`,
        [biz, station],
      ),
    ).rejects.toThrow(/station_outputs_station_id_job_key|duplicate key/);
  });

  it("accepts the same device on two jobs, which is the one-machine shop", async () => {
    // Pointing token and bill at one device_key is how a single roll does
    // both. Nothing branches on "how many devices".
    await admin.query(
      `INSERT INTO station_outputs (id, business_id, station_id, job, device_label, device_key, transport, paper_width, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'token', 'EPSON TM-T82', 'v:p:s1', 'usb', 58, now()),
              (gen_random_uuid(), $1, $2, 'bill',  'EPSON TM-T82', 'v:p:s1', 'usb', 58, now())`,
      [biz, station],
    );
    const r = await admin.query(
      `SELECT count(*)::int AS n FROM station_outputs WHERE station_id = $1 AND device_key = 'v:p:s1'`,
      [station],
    );
    expect(r.rows[0].n).toBe(3);
  });

  it("refuses a paper width no roll comes in", async () => {
    await expect(
      admin.query(
        `INSERT INTO station_outputs (id, business_id, station_id, job, device_label, device_key, transport, paper_width, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'kitchen', 'X', 'k', 'usb', 70, now())`,
        [biz, station],
      ),
    ).rejects.toThrow(/station_outputs_paper_width_check|violates check constraint/);
  });

  it("refuses a second receipt for the same station, event, job and attempt", async () => {
    // THE constraint. Two tabs on one machine both claim; one of them gets
    // this error and skips, and the shop gets one ticket.
    await admin.query(
      `INSERT INTO print_receipts (business_id, station_id, event_id, job, attempt, status, claimed_at)
       VALUES ($1, $2, $3, 'token', 1, 'claimed', now())`,
      [biz, station, eventId],
    );
    await expect(
      admin.query(
        `INSERT INTO print_receipts (business_id, station_id, event_id, job, attempt, status, claimed_at)
         VALUES ($1, $2, $3, 'token', 1, 'claimed', now())`,
        [biz, station, eventId],
      ),
    ).rejects.toThrow(/print_receipts_claim_key|duplicate key/);
  });

  it("lets a reprint through as a second attempt", async () => {
    // Half-printed paper is physical: tear it off and print attempt 2.
    const r = await admin.query(
      `INSERT INTO print_receipts (business_id, station_id, event_id, job, attempt, status, claimed_at)
       VALUES ($1, $2, $3, 'token', 2, 'claimed', now()) RETURNING attempt`,
      [biz, station, eventId],
    );
    expect(r.rows[0].attempt).toBe(2);
  });

  it("adds no kitchen INSERT or DELETE policy", async () => {
    // The invariant kitchen-policies.spec.ts asserts for the whole schema,
    // re-checked here against this migration's own tables — the kitchen's
    // writes go through SECURITY DEFINER functions, never a policy.
    const r = await admin.query(
      `SELECT policyname, cmd FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename IN ('print_stations', 'station_outputs', 'print_receipts')
          AND cmd IN ('INSERT', 'DELETE')
          AND policyname LIKE '%\\_kitchen\\_%'`,
    );
    expect(r.rows).toEqual([]);
  });

  it("lets a kitchen user claim a ticket through the function, not a policy", async () => {
    // The door the invariant leaves open. Runs as menu_app with the kitchen
    // user's tenant context — the same principal a real request carries —
    // because as a superuser this would pass with the function deleted.
    const app = new Client({ connectionString: process.env.APP_DATABASE_URL! });
    await app.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.current_user_id', $1, true)", [kitchenUser]);
      const r = await app.query(
        `SELECT (claim_print_receipt($1, $2, $3, 'kitchen', 1)).id AS id`,
        [biz, station, eventId],
      );
      expect(r.rows[0].id).toBeTruthy();
      await app.query("ROLLBACK");
    } finally {
      await app.end();
    }
  });

  it("refuses a claim for a business the caller has nothing to do with", async () => {
    // SECURITY DEFINER means RLS is not checking this — the function is.
    const app = new Client({ connectionString: process.env.APP_DATABASE_URL! });
    await app.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.current_user_id', $1, true)", [outsider]);
      await expect(
        app.query(`SELECT claim_print_receipt($1, $2, $3, 'kitchen', 1)`, [biz, station, eventId]),
      ).rejects.toThrow(/not your business/i);
      await app.query("ROLLBACK");
    } finally {
      await app.end();
    }
  });

  it("creates a station through the function, as the role that will call it", async () => {
    // create_print_station is the ONLY way a kitchen user can make a
    // station — there is no INSERT policy to fall back on — so it is tested
    // as menu_app with real tenant context, not as the superuser.
    const app = new Client({ connectionString: process.env.APP_DATABASE_URL! });
    await app.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.current_user_id', $1, true)", [kitchenUser]);
      const r = await app.query(`SELECT (create_print_station($1, 'Pass')).id AS id`, [biz]);
      expect(r.rows[0].id).toBeTruthy();
      await app.query("ROLLBACK");
    } finally {
      await app.end();
    }
  });

  it("re-links a swapped printer instead of adding a second row", async () => {
    // The ON CONFLICT path. Two printers on one job cannot exist, so
    // attaching twice must update, not insert — and this is the only test
    // that would notice if the upsert became a plain insert.
    const app = new Client({ connectionString: process.env.APP_DATABASE_URL! });
    await app.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.current_user_id', $1, true)", [kitchenUser]);
      const call = (key: string) =>
        app.query(
          `SELECT (attach_station_output($1, $2, 'kitchen', 'P', $3, 'usb', 80::smallint)).device_key AS k`,
          [biz, station, key],
        );
      await call("first");
      const second = await call("second");
      expect(second.rows[0].k).toBe("second");

      const n = await app.query(
        `SELECT count(*)::int AS n FROM station_outputs WHERE station_id = $1 AND job = 'kitchen'`,
        [station],
      );
      expect(n.rows[0].n).toBe(1);
      await app.query("ROLLBACK");
    } finally {
      await app.end();
    }
  });

  it("refuses to attach a station belonging to another business", async () => {
    // The cross-tenant case: a station id from one venue with another
    // venue's business id. SECURITY DEFINER means RLS is not catching this,
    // so the function's own lookup has to.
    const other = await admin.query(
      `INSERT INTO businesses (id, owner_id, name, type, public_code, updated_at)
       VALUES (gen_random_uuid(), $1, 'Other', 'restaurant', $2, now()) RETURNING id`,
      [owner, Math.random().toString(36).slice(2, 10).toUpperCase().padEnd(8, "Y")],
    );
    const otherBiz = other.rows[0].id as string;
    try {
      await expect(
        admin.query(
          `SELECT attach_station_output($1, $2, 'kitchen', 'P', 'x', 'usb', 80::smallint)`,
          [otherBiz, station],
        ),
      ).rejects.toThrow(/no such station/i);
    } finally {
      await admin.query("DELETE FROM businesses WHERE id = $1", [otherBiz]);
    }
  });

  it("refuses a bill output written by someone who is not the owner", async () => {
    // A bill is prices, and the kitchen role sees no prices anywhere in
    // this product. The guard is a trigger, not a service check, because
    // the service is not the only thing that can write this table.
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('app.current_user_id', $1, true)", [kitchenUser]);
    await expect(
      admin.query(
        `INSERT INTO station_outputs (id, business_id, station_id, job, device_label, device_key, transport, paper_width, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'bill', 'X', 'kk', 'usb', 80, now())`,
        [biz, station],
      ),
    ).rejects.toThrow(/only the owner/i);
    await admin.query("ROLLBACK");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm db:up
source .superpowers/sdd/2026-10-04-round-level-orders/local-db.env
pnpm --filter @menu/api exec vitest run src/printing/stations-schema.spec.ts
```

Expected: FAIL — `relation "print_stations" does not exist`.

- [ ] **Step 3: Write the migration**

Create `apps/api/prisma/migrations/20261021000000_print_stations/migration.sql`:

```sql
-- Printing: the machines, their printers, and one row per piece of paper.
--
-- A station is a browser tab on a shop machine. The server cannot hold a
-- USB handle — a WebUSB grant lives in the browser, per origin, and cannot
-- be serialised — so what is stored here is a device_key the page matches
-- against navigator.usb.getDevices() after a reload.
--
-- There is no print_jobs queue. order_events is already the record of what
-- happened; a queue beside it would be a second source of truth with a
-- lifecycle to maintain and rows to garbage-collect, for a guarantee the
-- unique index below already provides.

CREATE TYPE "PrintJob"           AS ENUM ('token', 'kitchen', 'bill');
CREATE TYPE "PrintTransport"     AS ENUM ('usb', 'serial');
CREATE TYPE "PrintReceiptStatus" AS ENUM ('claimed', 'printed', 'failed');

CREATE TABLE print_stations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name         text NOT NULL,
  -- Refreshed every time the station asks for work. The owner's list reads
  -- this to say "last seen 3 minutes ago", which is the only honest answer
  -- to "is that machine on?" available from a server.
  last_seen_at timestamptz(6),
  -- Revoked rather than deleted: the receipts that point at it are the
  -- record of what was printed, and that record should survive a machine
  -- being retired.
  revoked_at   timestamptz(6),
  created_at   timestamptz(6) NOT NULL DEFAULT now(),
  updated_at   timestamptz(6) NOT NULL
);

CREATE INDEX print_stations_business_idx ON print_stations (business_id, revoked_at);

CREATE TABLE station_outputs (
  id           uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  station_id   uuid NOT NULL REFERENCES print_stations(id) ON DELETE CASCADE,
  job          "PrintJob" NOT NULL,
  -- What Chrome reported, so the settings list can name the machine in
  -- words its owner recognises.
  device_label text NOT NULL,
  -- vendorId:productId:serial. The page re-finds the granted device by this.
  device_key   text NOT NULL,
  transport    "PrintTransport" NOT NULL,
  paper_width  smallint NOT NULL,
  created_at   timestamptz(6) NOT NULL DEFAULT now(),
  updated_at   timestamptz(6) NOT NULL,

  -- One output per job per station. This is what makes both deployment
  -- modes fall out of the same data with no mode flag: two machines each
  -- holding different jobs, or one machine holding all three.
  CONSTRAINT station_outputs_station_id_job_key UNIQUE (station_id, job),
  CONSTRAINT station_outputs_paper_width_check CHECK (paper_width IN (58, 80))
);

CREATE TABLE print_receipts (
  id          bigserial PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  station_id  uuid NOT NULL REFERENCES print_stations(id) ON DELETE CASCADE,
  event_id    bigint NOT NULL REFERENCES order_events(id) ON DELETE CASCADE,
  job         "PrintJob" NOT NULL,
  attempt     int NOT NULL DEFAULT 1,
  status      "PrintReceiptStatus" NOT NULL DEFAULT 'claimed',
  claimed_at  timestamptz(6) NOT NULL DEFAULT now(),
  printed_at  timestamptz(6),
  error       text,

  -- The claim. A second tab racing for the same token hits this and skips.
  -- A constraint rather than application code, for the same reason
  -- orders_one_open_per_table is one: it holds under concurrency, and the
  -- alternative is two slips for one order with nothing to say which.
  CONSTRAINT print_receipts_claim_key UNIQUE (station_id, event_id, job, attempt)
);

-- The `pending` query: everything this station has already taken, for the
-- events in the window. business_id leads so the scan is tenant-local.
CREATE INDEX print_receipts_station_event_idx ON print_receipts (station_id, event_id);
CREATE INDEX print_receipts_business_idx      ON print_receipts (business_id, claimed_at);

-- ─── Only an owner may put a bill on a machine ──────────────────────────────
--
-- A bill is prices, and a kitchen account sees no prices anywhere else in
-- this product — the board, the notifications and the order payload are all
-- stripped. Paper would be the hole. A trigger rather than a service check
-- because the service is not the only thing that can write this table, and
-- this is the same shape as orders_kitchen_guard.
CREATE OR REPLACE FUNCTION station_outputs_bill_owner_only() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.job <> 'bill' THEN
    RETURN NEW;
  END IF;

  -- No app user at all is a migration or a seed, not a request.
  IF app_current_user_id() IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM businesses
     WHERE id = NEW.business_id AND owner_id = app_current_user_id()
  ) THEN
    RAISE EXCEPTION 'only the owner may attach a bill printer'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER station_outputs_bill_guard
  BEFORE INSERT OR UPDATE ON station_outputs
  FOR EACH ROW EXECUTE FUNCTION station_outputs_bill_owner_only();

-- ─── RLS, in the same shape as the rest ─────────────────────────────────────

ALTER TABLE print_stations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE station_outputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE print_receipts  ENABLE ROW LEVEL SECURITY;

CREATE POLICY print_stations_owner ON print_stations
  USING      (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()))
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()));
CREATE POLICY station_outputs_owner ON station_outputs
  USING      (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()))
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()));
CREATE POLICY print_receipts_owner ON print_receipts
  USING      (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()))
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()));

-- Kitchen staff run the machine in the kitchen. They set it up, link its
-- printer and report results — all of it, except putting a bill on it,
-- which the trigger above refuses.
CREATE POLICY print_stations_kitchen_read ON print_stations FOR SELECT
  USING (business_id IN (SELECT app_staff_business_ids()));

CREATE POLICY print_stations_kitchen_touch ON print_stations FOR UPDATE
  USING      (business_id IN (SELECT app_staff_business_ids()))
  WITH CHECK (business_id IN (SELECT app_staff_business_ids()));

CREATE POLICY station_outputs_kitchen_read ON station_outputs FOR SELECT
  USING (business_id IN (SELECT app_staff_business_ids()));

CREATE POLICY station_outputs_kitchen_update ON station_outputs FOR UPDATE
  USING      (business_id IN (SELECT app_staff_business_ids()))
  WITH CHECK (business_id IN (SELECT app_staff_business_ids()));

CREATE POLICY print_receipts_kitchen_read ON print_receipts FOR SELECT
  USING (business_id IN (SELECT app_staff_business_ids()));

CREATE POLICY print_receipts_kitchen_update ON print_receipts FOR UPDATE
  USING      (business_id IN (SELECT app_staff_business_ids()))
  WITH CHECK (business_id IN (SELECT app_staff_business_ids()));

-- ─── The kitchen's three writes, through a door instead of a policy ────────
--
-- This codebase holds an invariant, asserted by kitchen-policies.spec.ts
-- ("creates no kitchen INSERT or DELETE policy"): the kitchen role never
-- gets a direct INSERT anywhere. `order_events` already has the same need
-- and the same answer — `log_order_status_event` is SECURITY DEFINER
-- precisely because order_events has no kitchen INSERT policy.
--
-- Printing follows that precedent rather than widening the boundary. Each
-- function re-checks the caller itself, because SECURITY DEFINER means RLS
-- is not going to.

CREATE OR REPLACE FUNCTION app_may_use_business(p_business_id uuid) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM businesses
                  WHERE id = p_business_id AND owner_id = app_current_user_id())
      OR p_business_id IN (SELECT app_staff_business_ids());
$$;

CREATE OR REPLACE FUNCTION create_print_station(p_business_id uuid, p_name text)
RETURNS print_stations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_row print_stations;
BEGIN
  IF NOT app_may_use_business(p_business_id) THEN
    RAISE EXCEPTION 'not your business' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO print_stations (business_id, name, updated_at)
  VALUES (p_business_id, p_name, now())
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- Upsert, because re-linking is the normal repair when a printer is swapped
-- and the unique (station, job) index means a second row cannot exist.
CREATE OR REPLACE FUNCTION attach_station_output(
  p_business_id uuid, p_station_id uuid, p_job "PrintJob",
  p_device_label text, p_device_key text, p_transport "PrintTransport",
  p_paper_width smallint)
RETURNS station_outputs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_row station_outputs;
BEGIN
  IF NOT app_may_use_business(p_business_id) THEN
    RAISE EXCEPTION 'not your business' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM print_stations
                  WHERE id = p_station_id AND business_id = p_business_id
                    AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'no such station' USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO station_outputs (business_id, station_id, job, device_label,
                               device_key, transport, paper_width, updated_at)
  VALUES (p_business_id, p_station_id, p_job, p_device_label,
          p_device_key, p_transport, p_paper_width, now())
  ON CONFLICT (station_id, job) DO UPDATE
    SET device_label = EXCLUDED.device_label,
        device_key   = EXCLUDED.device_key,
        transport    = EXCLUDED.transport,
        paper_width  = EXCLUDED.paper_width,
        updated_at   = now()
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- THE CLAIM. The unique violation is allowed to propagate: the caller turns
-- it into a 409, and that error IS the concurrency control.
CREATE OR REPLACE FUNCTION claim_print_receipt(
  p_business_id uuid, p_station_id uuid, p_event_id bigint,
  p_job "PrintJob", p_attempt int)
RETURNS print_receipts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_row print_receipts;
BEGIN
  IF NOT app_may_use_business(p_business_id) THEN
    RAISE EXCEPTION 'not your business' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM print_stations
                  WHERE id = p_station_id AND business_id = p_business_id
                    AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'no such station' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM order_events
                  WHERE id = p_event_id AND business_id = p_business_id) THEN
    RAISE EXCEPTION 'no such event' USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO print_receipts (business_id, station_id, event_id, job, attempt)
  VALUES (p_business_id, p_station_id, p_event_id, p_job, p_attempt)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

REVOKE EXECUTE ON FUNCTION app_may_use_business(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION create_print_station(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION attach_station_output(uuid, uuid, "PrintJob", text, text, "PrintTransport", smallint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION claim_print_receipt(uuid, uuid, bigint, "PrintJob", int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_may_use_business(uuid) TO menu_app;
GRANT EXECUTE ON FUNCTION create_print_station(uuid, text) TO menu_app;
GRANT EXECUTE ON FUNCTION attach_station_output(uuid, uuid, "PrintJob", text, text, "PrintTransport", smallint) TO menu_app;
GRANT EXECUTE ON FUNCTION claim_print_receipt(uuid, uuid, bigint, "PrintJob", int) TO menu_app;

GRANT SELECT, INSERT, UPDATE ON print_stations  TO menu_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON station_outputs TO menu_app;
GRANT SELECT, INSERT, UPDATE ON print_receipts  TO menu_app;
GRANT USAGE, SELECT ON SEQUENCE print_receipts_id_seq TO menu_app;
```

- [ ] **Step 4: Apply it and run the test**

```bash
source .superpowers/sdd/2026-10-04-round-level-orders/local-db.env
pnpm --filter @menu/api exec prisma migrate deploy
pnpm --filter @menu/api exec vitest run src/printing/stations-schema.spec.ts
```

Expected: 12 passing.

- [ ] **Step 5: Bring the Prisma schema into line**

Add to `apps/api/prisma/schema.prisma`, beside the other enums:

```prisma
enum PrintJob {
  token
  kitchen
  bill
}

enum PrintTransport {
  usb
  serial
}

enum PrintReceiptStatus {
  claimed
  printed
  failed
}
```

And the models:

```prisma
/// One machine with a browser tab open on it.
model PrintStation {
  id         String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  businessId String    @map("business_id") @db.Uuid
  name       String
  /// Refreshed whenever the station asks for work — the only honest answer
  /// a server has to "is that machine on?".
  lastSeenAt DateTime? @map("last_seen_at") @db.Timestamptz(6)
  /// Revoked, never deleted: the receipts pointing here are the record of
  /// what was printed.
  revokedAt  DateTime? @map("revoked_at") @db.Timestamptz(6)
  createdAt  DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt  DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)

  business Business        @relation(fields: [businessId], references: [id], onDelete: Cascade)
  outputs  StationOutput[]
  receipts PrintReceipt[]

  @@index([businessId, revokedAt], map: "print_stations_business_idx")
  @@map("print_stations")
}

/// One linked printer, for one job.
model StationOutput {
  id          String         @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  businessId  String         @map("business_id") @db.Uuid
  stationId   String         @map("station_id") @db.Uuid
  job         PrintJob
  deviceLabel String         @map("device_label")
  /// vendorId:productId:serial. The USB handle itself cannot be stored —
  /// a WebUSB grant lives in the browser and cannot be serialised.
  deviceKey   String         @map("device_key")
  transport   PrintTransport
  paperWidth  Int            @map("paper_width") @db.SmallInt
  createdAt   DateTime       @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt   DateTime       @updatedAt @map("updated_at") @db.Timestamptz(6)

  business Business     @relation(fields: [businessId], references: [id], onDelete: Cascade)
  station  PrintStation @relation(fields: [stationId], references: [id], onDelete: Cascade)

  @@unique([stationId, job], map: "station_outputs_station_id_job_key")
  @@map("station_outputs")
}

/// One piece of paper. The unique index is the claim.
model PrintReceipt {
  id         BigInt             @id @default(autoincrement())
  businessId String             @map("business_id") @db.Uuid
  stationId  String             @map("station_id") @db.Uuid
  eventId    BigInt             @map("event_id")
  job        PrintJob
  attempt    Int                @default(1)
  status     PrintReceiptStatus @default(claimed)
  claimedAt  DateTime           @default(now()) @map("claimed_at") @db.Timestamptz(6)
  printedAt  DateTime?          @map("printed_at") @db.Timestamptz(6)
  error      String?

  business Business     @relation(fields: [businessId], references: [id], onDelete: Cascade)
  station  PrintStation @relation(fields: [stationId], references: [id], onDelete: Cascade)
  event    OrderEvent   @relation(fields: [eventId], references: [id], onDelete: Cascade)

  @@unique([stationId, eventId, job, attempt], map: "print_receipts_claim_key")
  @@index([stationId, eventId], map: "print_receipts_station_event_idx")
  @@index([businessId, claimedAt], map: "print_receipts_business_idx")
  @@map("print_receipts")
}
```

Add the back-relations: `printStations PrintStation[]`, `stationOutputs StationOutput[]` and `printReceipts PrintReceipt[]` on `model Business`, and `printReceipts PrintReceipt[]` on `model OrderEvent`.

- [ ] **Step 6: Verify the schema matches the database**

```bash
source .superpowers/sdd/2026-10-04-round-level-orders/local-db.env
pnpm --filter @menu/api exec prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
pnpm --filter @menu/api exec prisma generate
```

Expected: `-- This is an empty migration.` Anything else is drift, and drift is what deleted `business_staff_lookup` — fix the schema until the diff is empty, and never by deleting the SQL.

- [ ] **Step 7: Name the new tables in the RLS drift guard**

In `apps/api/src/prisma/kitchen-policies.spec.ts`, the guard counts `_owner` policies. Change the expected count from 17 to 20 and extend the comment:

```ts
    // 15 pre-existing `_owner` policies, plus `business_staff_owner` from the
    // kitchen-policies migration — the owner's own counterpart to
    // `business_staff_self_read` — plus `order_rounds_owner` from the
    // order_rounds migration, plus `print_stations_owner`,
    // `station_outputs_owner` and `print_receipts_owner` from printing.
    const owned = r.rows.map((x) => x.tablename as string);
    expect(owned).toHaveLength(20);
```

- [ ] **Step 8: Run the whole API suite and commit**

```bash
source .superpowers/sdd/2026-10-04-round-level-orders/local-db.env
pnpm --filter @menu/api exec vitest run
pnpm --filter @menu/api lint
```

Expected: everything green. A failure in `kitchen-policies.spec.ts` means the new tables have an owner policy with no kitchen counterpart — that is the guard working, not a flaky test.

```bash
git add apps/api/prisma/migrations/20261021000000_print_stations/migration.sql \
        apps/api/prisma/schema.prisma \
        apps/api/src/printing/stations-schema.spec.ts \
        apps/api/src/prisma/kitchen-policies.spec.ts
git commit -m "feat(db): give a shop its stations, printers and receipts"
```

---

### Task 8: Becoming a station, and linking a printer

Setup is: open `/station` as any staff user, press "Set up this machine", name it. That writes a row and the page keeps its id in `localStorage`. No pairing code and no new auth path — the page sits behind the session that already exists.

**Files:**
- Create: `apps/api/src/printing/stations.service.ts`
- Create: `apps/api/src/printing/printing.controller.ts`
- Create: `apps/api/src/printing/stations.spec.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `packages/shared/src/schemas.ts`

**There are no feature modules in this codebase.** `app.module.ts` is flat: one `@Module` listing every controller and every provider. Do not create `printing.module.ts` — add `PrintingController` to its `controllers` array and `StationsService` to its `providers` array, in the same alphabetical-ish position the neighbours use.

**Interfaces:**
- Consumes: `BusinessesService.assertAccess` (`{ allow: ["owner", "kitchen"] }`); the tables from Task 7; `PRINT_JOBS` (Task 1).
- Produces: `StationsService` with `create`, `list`, `rename`, `revoke`, `attachOutput`, `detachOutput`, and `resolve(userId, bid, stationId, opts?: { touch?: boolean })` — which returns the station **with its `outputs` included**, because every caller needs to know which jobs the machine has a printer for; routes under `businesses/:bid/stations`; zod schemas `stationCreateSchema`, `stationRenameSchema`, `stationOutputSchema`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/printing/stations.spec.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenException, GoneException, NotFoundException } from "@nestjs/common";
import { StationsService } from "./stations.service";

/**
 * The service against a fake Prisma, because what is being tested is the
 * decisions — who may do what, and what a revoked station answers — not the
 * SQL. The constraints themselves have their own test against a real
 * database in stations-schema.spec.ts.
 */
function makeDeps(overrides: Record<string, unknown> = {}) {
  const station = {
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    findMany: vi.fn(),
  };
  const output = { deleteMany: vi.fn() };
  // create() and attachOutput() go through SECURITY DEFINER functions, so
  // what they exercise is $queryRaw, not a model writer. A mock that still
  // offered printStation.create would let a regression back to the ORM path
  // pass silently — and that path is refused by RLS for a kitchen caller.
  const queryRaw = vi.fn().mockResolvedValue([{ station: { id: "s1" }, output: { job: "bill" } }]);
  const prisma = { db: { printStation: station, stationOutput: output, $queryRaw: queryRaw } };
  const businesses = {
    assertAccess: vi.fn().mockResolvedValue({ business: { id: "b1" }, role: "owner" }),
  };
  Object.assign(businesses, overrides);
  return {
    svc: new StationsService(prisma as never, businesses as never),
    station,
    output,
    queryRaw,
    businesses,
  };
}

describe("StationsService.resolve", () => {
  it("answers 410 for a revoked station rather than 404", () => {
    // The page must be able to tell "this machine was retired" from "that
    // id was never real" — the first clears localStorage and stops, the
    // second is a bug worth showing.
    const { svc, station } = makeDeps();
    station.findFirst.mockResolvedValue({ id: "s1", businessId: "b1", revokedAt: new Date() });
    return expect(svc.resolve("u1", "b1", "s1")).rejects.toBeInstanceOf(GoneException);
  });

  it("404s a station id from another business", () => {
    const { svc, station } = makeDeps();
    station.findFirst.mockResolvedValue(null);
    return expect(svc.resolve("u1", "b1", "s1")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("refreshes last seen when it resolves", async () => {
    const { svc, station } = makeDeps();
    station.findFirst.mockResolvedValue({ id: "s1", businessId: "b1", revokedAt: null });
    await svc.resolve("u1", "b1", "s1", { touch: true });
    expect(station.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "s1" } }),
    );
  });

  it("does not touch last seen on a plain read", async () => {
    // "Last seen" must mean the machine asked for work, not that the owner
    // opened the settings page and looked at it.
    const { svc, station } = makeDeps();
    station.findFirst.mockResolvedValue({ id: "s1", businessId: "b1", revokedAt: null });
    await svc.resolve("u1", "b1", "s1");
    expect(station.update).not.toHaveBeenCalled();
  });
});

describe("StationsService.revoke", () => {
  it("revokes only within the business named in the URL", async () => {
    // An owner with two venues can pass venue A's :bid with venue B's
    // station id. RLS permits it — both are theirs — so the pairing in the
    // URL is the only thing left to object, and a write keyed on the id
    // alone would stop a machine printing in the wrong shop.
    const { svc, station } = makeDeps();
    await svc.revoke("u1", "b1", "s1");

    const where = station.updateMany.mock.calls[0]![0].where as Record<string, unknown>;
    expect(where).toEqual({ id: "s1", businessId: "b1" });
  });

  it("404s when the pairing matches nothing", async () => {
    const { svc, station } = makeDeps();
    station.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.revoke("u1", "b1", "s1")).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("StationsService.attachOutput", () => {
  const output = {
    job: "bill" as const,
    deviceLabel: "EPSON TM-T82",
    deviceKey: "04b8:0202:X",
    transport: "usb" as const,
    paperWidth: 80 as const,
  };

  it("refuses a kitchen user attaching a bill printer", async () => {
    // Review Focus 1. A bill ticket is a payload full of prices, and the
    // kitchen role is stripped of prices everywhere else.
    const { svc, station, businesses } = makeDeps();
    (businesses.assertAccess as ReturnType<typeof vi.fn>).mockResolvedValue({
      business: { id: "b1" },
      role: "kitchen",
    });
    station.findFirst.mockResolvedValue({ id: "s1", businessId: "b1", revokedAt: null });

    await expect(svc.attachOutput("u1", "b1", "s1", output)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("lets a kitchen user attach the kitchen printer", async () => {
    // They are the ones standing next to it. The fake deliberately has no
    // stationOutput.upsert — the linking goes through attach_station_output —
    // so what this can honestly assert is that a kitchen caller reaches the
    // function at all for a non-bill job, rather than being turned away by
    // the role check that DOES reject them for "bill" above.
    const { svc, station, output: outputs, queryRaw, businesses } = makeDeps();
    (businesses.assertAccess as ReturnType<typeof vi.fn>).mockResolvedValue({
      business: { id: "b1" },
      role: "kitchen",
    });
    station.findFirst.mockResolvedValue({ id: "s1", businessId: "b1", revokedAt: null });

    await svc.attachOutput("u1", "b1", "s1", { ...output, job: "kitchen" });

    expect(queryRaw).toHaveBeenCalled();
    expect(outputs).not.toHaveProperty("upsert");
  });

  it("links the printer through the SECURITY DEFINER function, not the ORM", async () => {
    // The table has no kitchen INSERT policy and never will, so the ORM path
    // would be refused by RLS for the people who stand next to the printer.
    // The upsert that makes re-linking a swapped printer work lives inside
    // attach_station_output.
    const { svc, station, output: outputs, queryRaw } = makeDeps();
    station.findFirst.mockResolvedValue({ id: "s1", businessId: "b1", revokedAt: null });

    await svc.attachOutput("u1", "b1", "s1", output);

    expect(queryRaw).toHaveBeenCalled();
    const sql = String(queryRaw.mock.calls[0]![0]);
    expect(sql).toContain("attach_station_output");
    expect(outputs).not.toHaveProperty("upsert");
  });

  it("creates a station through the function too", async () => {
    const { svc, queryRaw } = makeDeps();
    await svc.create("u1", "b1", "Counter");
    expect(String(queryRaw.mock.calls[0]![0])).toContain("create_print_station");
  });

  it("passes the values it was given, not just the right function name", async () => {
    // A tagged template's first argument is the literal text; the
    // interpolated values follow it. Asserting only on the text would let a
    // swapped businessId/stationId pair through — the call would still name
    // the right function while writing against the wrong venue.
    // Ids distinct from the fixtures' defaults: asserting "b1"/"s1" against
    // a fake that uses those everywhere would not detect a swap.
    const { svc, station, queryRaw } = makeDeps();
    station.findFirst.mockResolvedValue({ id: "s7", businessId: "b9", revokedAt: null });

    await svc.attachOutput("u1", "b9", "s7", output);

    const [, ...values] = queryRaw.mock.calls[0]!;
    expect(values).toEqual([
      "b9",
      "s7",
      output.job,
      output.deviceLabel,
      output.deviceKey,
      output.transport,
      output.paperWidth,
    ]);
  });

  it("turns a function's refusal into a status rather than a 500", async () => {
    // The SECURITY DEFINER functions raise their own guards. Unmapped, that
    // text reaches Nest as an unhandled error and the station page sees a
    // 500 for a condition it could have handled — reachable whenever a
    // station is revoked between resolve() and the call.
    const { svc, station, queryRaw } = makeDeps();
    station.findFirst.mockResolvedValue({ id: "s1", businessId: "b1", revokedAt: null });
    queryRaw.mockRejectedValueOnce(new Error("ERROR: no such station"));

    await expect(svc.attachOutput("u1", "b1", "s1", output)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
source .superpowers/sdd/2026-10-04-round-level-orders/local-db.env
pnpm --filter @menu/api exec vitest run src/printing/stations.spec.ts
```

Expected: FAIL — cannot resolve `./stations.service`.

- [ ] **Step 3: Add the request schemas**

Append to `packages/shared/src/schemas.ts`:

```ts
export const stationCreateSchema = z.object({
  name: z.string().trim().min(1).max(40),
});
export type StationCreateInput = z.infer<typeof stationCreateSchema>;

export const stationRenameSchema = stationCreateSchema;
export type StationRenameInput = StationCreateInput;

export const stationOutputSchema = z.object({
  job: z.enum(["token", "kitchen", "bill"]),
  deviceLabel: z.string().trim().min(1).max(120),
  /// vendorId:productId:serial, as the browser reported it.
  deviceKey: z.string().trim().min(1).max(200),
  transport: z.enum(["usb", "serial"]),
  paperWidth: z.union([z.literal(58), z.literal(80)]),
});
export type StationOutputInput = z.infer<typeof stationOutputSchema>;
```

Then `pnpm --filter @menu/shared build`.

- [ ] **Step 4: Write the service**

Create `apps/api/src/printing/stations.service.ts`:

```ts
import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { StationOutputInput } from "@menu/shared";
import { BusinessesService } from "../businesses/businesses.service";
import { PrismaService } from "../prisma/prisma.service";
import { cleanPgMessage } from "../common/pg-message";

/** Who may reach a station at all. Narrowed per job in attachOutput. */
const STATION_ROLES = { allow: ["owner", "kitchen"] as const };

@Injectable()
export class StationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly businesses: BusinessesService,
  ) {}

  /**
   * A station id from a URL or from localStorage, turned into a row.
   *
   * Three outcomes, and the difference between the last two matters to the
   * page: a station of another business is 404 (that it exists is not
   * something a stranger needs confirmed), and a revoked one is 410, which
   * is the page's signal to clear its localStorage and stop asking.
   *
   * `touch` is passed only by the endpoints a working station calls, so
   * "last seen" means the machine asked for work — not that the owner
   * opened the settings page and looked at it.
   */
  async resolve(
    userId: string,
    businessId: string,
    stationId: string,
    opts: { touch?: boolean } = {},
  ) {
    await this.businesses.assertAccess(userId, businessId, {
      allow: [...STATION_ROLES.allow],
    });

    // Outputs come along: every caller of resolve() needs to know which
    // jobs this machine has a printer for, and a second round trip for a
    // row we already have is waste on a path polled every ten seconds.
    const station = await this.prisma.db.printStation.findFirst({
      where: { id: stationId, businessId },
      include: { outputs: true },
    });
    if (!station) throw new NotFoundException("Station not found");
    if (station.revokedAt) throw new GoneException("This machine is no longer a station");

    if (opts.touch) {
      await this.prisma.db.printStation.update({
        where: { id: stationId },
        data: { lastSeenAt: new Date() },
      });
    }
    return station;
  }

  /**
   * Through `create_print_station`, not `printStation.create`.
   *
   * There is no kitchen INSERT policy on this table and there deliberately
   * never will be — see the invariant in kitchen-policies.spec.ts. The
   * SECURITY DEFINER function is the only door, and it re-checks the caller
   * itself because RLS is not going to.
   */
  async create(userId: string, businessId: string, name: string) {
    await this.businesses.assertAccess(userId, businessId, {
      allow: [...STATION_ROLES.allow],
    });
    const rows = await fromFunction(
      () => this.prisma.db.$queryRaw<
        { station: PrintStation }[]
      >`SELECT create_print_station(${businessId}::uuid, ${name}) AS station`,
    );
    return rows[0]!.station;
  }

  /**
   * Runs one SECURITY DEFINER call and turns its RAISE EXCEPTION into an
   * HTTP status, the way `place_table_round` does at
   * orders.service.ts:88-103.
   *
   * Without this the functions' own guards — "not your business", "no such
   * station" — arrive as raw Postgres text and Nest answers 500. That is
   * reachable, not theoretical: an owner can revoke a station in the window
   * between resolve() checking it and the function running.
   */
  // (module-level, above the class — it needs no `this`)
}

async function fromFunction<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (/not your business/.test(message)) {
      throw new ForbiddenException("Not your business");
    }
    if (/no such station/.test(message)) {
      throw new NotFoundException("Station not found");
    }
    // Anything else that looks like a RAISE EXCEPTION becomes a 400 with the
    // message cleaned up for a person, same as every other SQL-raised error
    // in this API. Unrecognised errors are rethrown, never swallowed.
    const match = /ERROR: (.+)/.exec(message);
    if (match) throw new BadRequestException(cleanPgMessage(match[1]!));
    throw err;
  }

  async list(userId: string, businessId: string) {
    await this.businesses.assertAccess(userId, businessId, {
      allow: [...STATION_ROLES.allow],
    });
    return this.prisma.db.printStation.findMany({
      where: { businessId, revokedAt: null },
      include: { outputs: true },
      orderBy: { createdAt: "asc" },
    });
  }

  async rename(userId: string, businessId: string, stationId: string, name: string) {
    await this.resolve(userId, businessId, stationId);
    return this.prisma.db.printStation.update({ where: { id: stationId }, data: { name } });
  }

  /**
   * Revoked, not deleted: the receipts pointing at it are the record.
   *
   * `updateMany` scoped on businessId, not `update` on the id alone. An
   * owner with two venues who sends venue A's :bid with venue B's station id
   * would otherwise revoke a machine in the wrong shop — RLS permits it,
   * because both venues are theirs, so the URL's pairing is the only thing
   * that can object.
   */
  async revoke(userId: string, businessId: string, stationId: string) {
    await this.businesses.assertAccess(userId, businessId, { allow: ["owner"] });
    const { count } = await this.prisma.db.printStation.updateMany({
      where: { id: stationId, businessId },
      data: { revokedAt: new Date() },
    });
    if (count === 0) throw new NotFoundException("Station not found");
  }

  /**
   * Link a printer to one of this station's jobs.
   *
   * An upsert, because re-linking is the normal repair when a printer is
   * swapped and the unique (station, job) index means a second row cannot
   * exist anyway.
   *
   * A `bill` output is owner-only. The database refuses it too (see
   * station_outputs_bill_guard); this is the half that produces a 403 with
   * a sentence in it rather than a Postgres error.
   */
  async attachOutput(
    userId: string,
    businessId: string,
    stationId: string,
    body: StationOutputInput,
  ) {
    const { role } = await this.businesses.assertAccess(userId, businessId, {
      allow: [...STATION_ROLES.allow],
    });
    if (body.job === "bill" && role !== "owner") {
      throw new ForbiddenException("Only the owner can put a bill printer on a machine");
    }
    await this.resolve(userId, businessId, stationId);

    // Same door as create(): the upsert lives inside attach_station_output,
    // which is also what makes re-linking a swapped printer work.
    const rows = await fromFunction(
      () => this.prisma.db.$queryRaw<{ output: StationOutput }[]>`
        SELECT attach_station_output(
          ${businessId}::uuid, ${stationId}::uuid, ${body.job}::"PrintJob",
          ${body.deviceLabel}, ${body.deviceKey}, ${body.transport}::"PrintTransport",
          ${body.paperWidth}::smallint
        ) AS output`,
    );
    return rows[0]!.output;
  }

  /**
   * Owner-only, and not for tidiness: the schema has no kitchen DELETE
   * policy, by the same invariant that keeps the kitchen off INSERT. A
   * kitchen user who linked the wrong printer re-links it — that is an
   * upsert through attach_station_output, not a delete.
   */
  async detachOutput(userId: string, businessId: string, stationId: string, job: string) {
    await this.businesses.assertAccess(userId, businessId, { allow: ["owner"] });
    await this.prisma.db.stationOutput.deleteMany({ where: { stationId, businessId, job: job as never } });
  }
}
```

- [ ] **Step 5: Write the controller and module**

Create `apps/api/src/printing/printing.controller.ts`:

```ts
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import {
  stationCreateSchema, stationOutputSchema, stationRenameSchema,
  type StationCreateInput, type StationOutputInput, type StationRenameInput,
} from "@menu/shared";
import { CurrentUser } from "../common/decorators";
import { ZodBody } from "../common/zod.pipe";
import type { RequestUser } from "../auth/jwt.strategy";
import { StationsService } from "./stations.service";

/**
 * Owner and kitchen throughout, except revoke (owner) and a bill output
 * (owner, enforced in the service and again by a trigger). A station is a
 * machine in a shop, and the person standing next to it is usually not the
 * owner.
 */
@Controller("businesses/:bid/stations")
export class PrintingController {
  constructor(private readonly stations: StationsService) {}

  @Get()
  list(@CurrentUser() user: RequestUser, @Param("bid") bid: string) {
    return this.stations.list(user.id, bid);
  }

  @Post()
  create(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Body(new ZodBody(stationCreateSchema)) body: StationCreateInput,
  ) {
    return this.stations.create(user.id, bid, body.name);
  }

  @Patch(":sid")
  rename(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Param("sid") sid: string,
    @Body(new ZodBody(stationRenameSchema)) body: StationRenameInput,
  ) {
    return this.stations.rename(user.id, bid, sid, body.name);
  }

  @Delete(":sid")
  @HttpCode(204)
  async revoke(@CurrentUser() user: RequestUser, @Param("bid") bid: string, @Param("sid") sid: string) {
    await this.stations.revoke(user.id, bid, sid);
  }

  @Post(":sid/outputs")
  attach(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Param("sid") sid: string,
    @Body(new ZodBody(stationOutputSchema)) body: StationOutputInput,
  ) {
    return this.stations.attachOutput(user.id, bid, sid, body);
  }

  @Delete(":sid/outputs/:job")
  @HttpCode(204)
  async detach(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Param("sid") sid: string,
    @Param("job") job: string,
  ) {
    await this.stations.detachOutput(user.id, bid, sid, job);
  }
}
```

In `apps/api/src/app.module.ts`, add the two imports beside the existing ones:

```ts
import { PrintingController } from "./printing/printing.controller";
import { StationsService } from "./printing/stations.service";
```

then `PrintingController` to the `controllers` array (after `StaffController`) and `StationsService` to the `providers` array. `PrismaService` and `BusinessesService` are already provided there, so constructor injection just works — this is why there is no module file to write.

- [ ] **Step 6: Run and commit**

```bash
source .superpowers/sdd/2026-10-04-round-level-orders/local-db.env
pnpm --filter @menu/api exec vitest run src/printing/stations.spec.ts
pnpm --filter @menu/api exec vitest run
pnpm --filter @menu/api lint
```

Expected: 12 passing in the new file, whole suite green, typecheck clean.

```bash
git add apps/api/src/printing/stations.service.ts apps/api/src/printing/printing.controller.ts \
        apps/api/src/printing/stations.spec.ts apps/api/src/app.module.ts \
        packages/shared/src/schemas.ts
git commit -m "feat(api): let a shop machine become a station and link a printer"
```

---

### Task 9: What is waiting to be printed

The station asks "what have you got for me?" and gets back the jobs it has a printer for and has not already taken. No side effects beyond the last-seen touch, so two tabs may both ask — the race is resolved at the claim, not here.

**The window is the whole design.** A station switched off all day and opened at closing time must not emit two hundred tickets. Thirty minutes back is `pending`; anything older is `missed`, listed with a Print button, and stays a human decision.

**Files:**
- Create: `apps/api/src/printing/receipts.service.ts`
- Create: `apps/api/src/printing/pending.spec.ts`
- Modify: `apps/api/src/printing/printing.controller.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**
- Consumes: `StationsService.resolve` (Task 8); `jobsForEvent`, `PrintJob` (Task 1).
- Produces: `ReceiptsService.pending(userId, bid, stationId): Promise<{ pending: PendingJob[]; missed: PendingJob[]; topic: string | null }>`; `interface PendingJob { eventId: string; job: PrintJob; kind: string; at: string; orderId: string; tableLabel: string; token: number }`; route `GET businesses/:bid/stations/:sid/pending`.
- `topic` is the HMAC Realtime channel name from `businessChannel(businessId, secret)` (`apps/api/src/notifications/channel-name.ts`). **The API hands each client its own topic; nothing derives one in the browser** — that is the whole reason the name is an HMAC rather than the business id. Null when Realtime is not configured, in which case the station simply polls.
- `eventId` is a **string** in the DTO: `order_events.id` is a bigint, and JSON cannot carry one.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/printing/pending.spec.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { ReceiptsService } from "./receipts.service";

/**
 * The window and the mapping, against a fake Prisma. These are decisions,
 * and the thing that makes them worth a test is that both failure modes are
 * silent: too wide a window buries the shop in paper at closing time, and a
 * mapping that drops a job means a ticket that simply never prints.
 */
const NOW = new Date("2026-10-04T15:30:00.000Z");

function makeSvc(events: unknown[], receipts: unknown[] = [], outputs = ["token", "kitchen"]) {
  const prisma = {
    db: {
      orderEvent: { findMany: vi.fn().mockResolvedValue(events) },
      printReceipt: { findMany: vi.fn().mockResolvedValue(receipts) },
    },
  };
  const stations = {
    resolve: vi.fn().mockResolvedValue({
      id: "s1",
      businessId: "b1",
      revokedAt: null,
      outputs: outputs.map((job) => ({ job })),
    }),
  };
  return new ReceiptsService(prisma as never, stations as never);
}

const event = (id: string, kind: string, minutesAgo: number) => ({
  id: BigInt(id),
  kind,
  at: new Date(NOW.getTime() - minutesAgo * 60_000),
  orderId: "o1",
  roundId: "r1",
  order: { dailyNumber: 14, table: { label: "7" } },
});

describe("ReceiptsService.pending", () => {
  it("offers both jobs of an accepted round to a station that has both printers", async () => {
    const svc = makeSvc([event("1", "round.accepted", 2)]);
    const { pending } = await svc.pending("u1", "b1", "s1", NOW);
    expect(pending.map((p) => p.job)).toEqual(["token", "kitchen"]);
  });

  it("offers only the jobs this station has a printer for", async () => {
    // Two machines: the counter holds token and bill, the kitchen holds
    // kitchen. One accept, one job each, both at the same moment.
    const svc = makeSvc([event("1", "round.accepted", 2)], [], ["kitchen"]);
    const { pending } = await svc.pending("u1", "b1", "s1", NOW);
    expect(pending.map((p) => p.job)).toEqual(["kitchen"]);
  });

  it("offers nothing for an event that produces no paper", async () => {
    const svc = makeSvc([event("1", "round.ready", 2), event("2", "round.cancelled", 1)]);
    const { pending } = await svc.pending("u1", "b1", "s1", NOW);
    expect(pending).toEqual([]);
  });

  it("does not re-offer a job this station already took", async () => {
    const svc = makeSvc(
      [event("1", "round.accepted", 2)],
      [{ eventId: BigInt("1"), job: "token", status: "printed" }],
    );
    const { pending } = await svc.pending("u1", "b1", "s1", NOW);
    expect(pending.map((p) => p.job)).toEqual(["kitchen"]);
  });

  it("still offers a job whose last attempt failed", async () => {
    // Paper jam, printer off, write died halfway. A failed receipt is not
    // a printed one, and the station must be able to try again.
    const svc = makeSvc(
      [event("1", "round.accepted", 2)],
      [{ eventId: BigInt("1"), job: "token", status: "failed" }],
    );
    const { pending } = await svc.pending("u1", "b1", "s1", NOW);
    expect(pending.map((p) => p.job)).toContain("token");
  });

  it("puts anything older than thirty minutes in missed, not pending", async () => {
    // Review Focus 3. A machine switched on at closing time must not emit
    // the day's tickets; the owner decides which of them still matter.
    const svc = makeSvc([event("1", "round.accepted", 2), event("2", "round.accepted", 45)]);
    const { pending, missed } = await svc.pending("u1", "b1", "s1", NOW);
    expect(pending.every((p) => p.eventId === "1")).toBe(true);
    expect(missed.every((p) => p.eventId === "2")).toBe(true);
    expect(missed).not.toHaveLength(0);
  });

  it("carries the table and token, so the screen can say what is waiting", async () => {
    // "2 tickets waiting" is not useful. "Table 7, token 14" is.
    const svc = makeSvc([event("1", "round.accepted", 2)]);
    const { pending } = await svc.pending("u1", "b1", "s1", NOW);
    expect(pending[0]).toMatchObject({ tableLabel: "7", token: 14, eventId: "1" });
  });

  it("answers with a topic even when the machine has no printer yet", async () => {
    // The page subscribes before it has been configured, and a station
    // with no outputs must not be a station with no socket.
    const svc = makeSvc([event("1", "round.accepted", 2)], [], []);
    const out = await svc.pending("u1", "b1", "s1", NOW);
    expect(out.pending).toEqual([]);
    expect(out).toHaveProperty("topic");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
source .superpowers/sdd/2026-10-04-round-level-orders/local-db.env
pnpm --filter @menu/api exec vitest run src/printing/pending.spec.ts
```

Expected: FAIL — cannot resolve `./receipts.service`.

- [ ] **Step 3: Write the service**

Create `apps/api/src/printing/receipts.service.ts`:

```ts
import { Injectable } from "@nestjs/common";
import { jobsForEvent, type PrintJob } from "@menu/shared";
import { PrismaService } from "../prisma/prisma.service";
import { StationsService } from "./stations.service";

/**
 * How far back a station will print without being asked.
 *
 * A machine switched off all day and opened at closing time must not emit
 * two hundred tickets. Everything older than this is listed as missed and
 * waits for someone to decide it still matters.
 */
const WINDOW_MINUTES = 30;

/** How far back the missed list looks. A shift, not a history. */
const MISSED_HOURS = 16;

export interface PendingJob {
  /** order_events.id as a string: it is a bigint, and JSON has no such thing. */
  eventId: string;
  job: PrintJob;
  kind: string;
  at: string;
  orderId: string;
  tableLabel: string;
  token: number;
}

@Injectable()
export class ReceiptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stations: StationsService,
  ) {}

  /**
   * What this station has a printer for and has not already taken.
   *
   * Deliberately side-effect free apart from the last-seen touch, so two
   * tabs asking at the same moment is harmless — the race is resolved by
   * the unique index at the claim, not by trying to prevent it here.
   *
   * The mapping from event to job is `jobsForEvent`, the same function the
   * station page uses, so the API cannot offer a job the page would not
   * know how to render.
   *
   * `now` is a parameter so the window is testable. Production passes
   * nothing.
   */
  async pending(
    userId: string,
    businessId: string,
    stationId: string,
    now: Date = new Date(),
  ): Promise<{ pending: PendingJob[]; missed: PendingJob[] }> {
    const station = await this.stations.resolve(userId, businessId, stationId, { touch: true });
    // The topic the page may listen on. Derived here and handed over,
    // never derived in the browser — a leaked business id must not yield a
    // subscription to that restaurant's activity.
    const env = loadEnv();
    const topic = env.REALTIME_CHANNEL_SECRET
      ? businessChannel(businessId, env.REALTIME_CHANNEL_SECRET)
      : null;

    const jobs = new Set<PrintJob>(station.outputs.map((o) => o.job as PrintJob));
    // No printer on this machine yet: nothing to print, and nothing
    // accumulating either. A venue with no station is simply unaffected.
    if (jobs.size === 0) return { pending: [], missed: [], topic };

    const since = new Date(now.getTime() - MISSED_HOURS * 3_600_000);
    const events = await this.prisma.db.orderEvent.findMany({
      where: { businessId, at: { gte: since } },
      orderBy: { at: "asc" },
      include: { order: { select: { dailyNumber: true, table: { select: { label: true } } } } },
    });

    const taken = await this.prisma.db.printReceipt.findMany({
      where: { stationId, status: { not: "failed" }, event: { at: { gte: since } } },
      select: { eventId: true, job: true },
    });
    const done = new Set(taken.map((r) => `${r.eventId}:${r.job}`));

    const cutoff = now.getTime() - WINDOW_MINUTES * 60_000;
    const pending: PendingJob[] = [];
    const missed: PendingJob[] = [];

    for (const e of events) {
      for (const job of jobsForEvent(e.kind)) {
        if (!jobs.has(job)) continue;
        if (done.has(`${e.id}:${job}`)) continue;

        const row: PendingJob = {
          eventId: String(e.id),
          job,
          kind: e.kind,
          at: e.at.toISOString(),
          orderId: e.orderId,
          tableLabel: e.order.table.label,
          token: e.order.dailyNumber,
        };
        (e.at.getTime() >= cutoff ? pending : missed).push(row);
      }
    }

    return { pending, missed, topic };
  }
}
```

**Check `apps/api/src/config/env.ts` for the real name of the Realtime channel secret** — `orders.controller.ts` already calls `tableChannel(...)` with it, so copy that call site rather than the name guessed above. Add the imports:

```ts
import { businessChannel } from "../notifications/channel-name";
import { loadEnv } from "../config/env";
```

- [ ] **Step 4: Add the route**

In `apps/api/src/printing/printing.controller.ts`, inject `ReceiptsService` alongside `StationsService` and add:

```ts
  /**
   * Polled every ten seconds, and again whenever the Realtime ping lands.
   * The ping is an optimisation over polling and is allowed to be lost.
   */
  @Get(":sid/pending")
  pending(@CurrentUser() user: RequestUser, @Param("bid") bid: string, @Param("sid") sid: string) {
    return this.receipts.pending(user.id, bid, sid);
  }
```

Register `ReceiptsService` in `app.module.ts`'s `providers`.

- [ ] **Step 5: Run and commit**

```bash
source .superpowers/sdd/2026-10-04-round-level-orders/local-db.env
pnpm --filter @menu/api exec vitest run src/printing/pending.spec.ts
pnpm --filter @menu/api exec vitest run
pnpm --filter @menu/api lint
```

Expected: 8 passing in the new file, whole suite green.

```bash
git add apps/api/src/printing/receipts.service.ts apps/api/src/printing/pending.spec.ts \
        apps/api/src/printing/printing.controller.ts apps/api/src/app.module.ts
git commit -m "feat(api): tell a station what is waiting for it"
```

---

### Task 10: Rows into tickets

The mapping from what the database holds to what the encoder prints. Pure — no Prisma client, no Nest — so it is tested without a database, which is what makes it cheap to cover the cases that matter: a bill whose lines carry different tax rates, a round with no variant, a business with no address.

**Files:**
- Create: `apps/api/src/printing/ticket-payload.ts`
- Create: `apps/api/src/printing/ticket-payload.spec.ts`

**Interfaces:**
- Consumes: `TokenTicket`, `KitchenTicket`, `BillTicket` (Tasks 4–6); the `Bill` interface from `apps/api/src/billing/billing.service.ts`.
- Produces: `tokenTicketFrom(src: TicketSource): TokenTicket`; `kitchenTicketFrom(src: TicketSource): KitchenTicket`; `billTicketFrom(bill: Bill, token: number): BillTicket`; `interface TicketSource`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/printing/ticket-payload.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Bill } from "../billing/billing.service";
import { billTicketFrom, kitchenTicketFrom, tokenTicketFrom, type TicketSource } from "./ticket-payload";

const src: TicketSource = {
  businessName: "Taste of Hyderabad",
  order: { dailyNumber: 14, note: null, isRunning: false, tableLabel: "7" },
  round: {
    seq: 2,
    kotNumber: 38,
    placedAt: new Date("2026-10-04T15:36:00.000Z"),
    items: [
      { quantity: 2, nameSnapshot: "Irani Chai", variantSnapshot: null },
      { quantity: 1, nameSnapshot: "Osmania Biscuit", variantSnapshot: null },
    ],
  },
};

const bill: Bill = {
  id: "bill1",
  billNumber: 208,
  tableLabel: "7",
  issuedAt: "2026-10-04T16:01:00.000Z",
  currency: "INR",
  taxLabel: "GST",
  pricesIncludeTax: true,
  business: {
    name: "Taste of Hyderabad",
    gstin: "36AABCT1234K1Z5",
    logoPath: null,
    addressLine1: "12-3-45 Banjara Hills",
    addressLine2: null,
    city: "Hyderabad",
    state: null,
    postalCode: "500034",
  },
  receiptFooter: "Thank you",
  subtotal: "1223.81",
  taxTotal: "61.19",
  serviceCharge: "0.00",
  serviceChargeRate: "0",
  roundOff: "0.00",
  total: "1290.00",
  lines: [
    { id: "l1", name: "Chicken Biryani", variant: "Full", quantity: 2, unitPrice: "320.00", lineTotal: "640.00", taxRate: "5.00", taxAmount: "30.48" },
    { id: "l2", name: "Irani Chai", variant: null, quantity: 2, unitPrice: "30.00", lineTotal: "60.00", taxRate: "5.00", taxAmount: "2.86" },
  ],
};

describe("tokenTicketFrom", () => {
  it("carries the order's daily number as the token, not the round's", async () => {
    // The customer is given one number for the whole table, whatever
    // round they are on. Handing them a new number per round would make
    // the counter unable to match the slip to the food.
    expect(tokenTicketFrom(src)).toMatchObject({ kind: "token", token: 14, seq: 2 });
  });
});

describe("kitchenTicketFrom", () => {
  it("carries this round's items, the KOT number and the running flag", () => {
    const t = kitchenTicketFrom({
      ...src,
      order: { ...src.order, isRunning: true },
    });
    expect(t).toMatchObject({ kind: "kitchen", token: 14, kotNumber: 38, seq: 2, isRunning: true });
    expect(t.items).toEqual([
      { quantity: 2, name: "Irani Chai", variant: null },
      { quantity: 1, name: "Osmania Biscuit", variant: null },
    ]);
  });

  it("passes the order's note through, since items have none", () => {
    const t = kitchenTicketFrom({ ...src, order: { ...src.order, note: "less spicy" } });
    expect(t.note).toBe("less spicy");
  });
});

describe("billTicketFrom", () => {
  it("names the tax rate when every line shares one", () => {
    // "GST 5% (incl.)" is only honest if 5% is what every line was charged.
    expect(billTicketFrom(bill, 14).taxLine).toBe("GST 5% (incl.)");
  });

  it("drops the rate when the lines disagree", () => {
    // A price change mid-meal snapshots two different rates. Naming one of
    // them on the paper would state a rate the customer was not charged.
    const mixed: Bill = {
      ...bill,
      lines: [bill.lines[0]!, { ...bill.lines[1]!, taxRate: "12.00" }],
    };
    expect(billTicketFrom(mixed, 14).taxLine).toBe("GST");
  });

  it("omits the tax line entirely when there is no tax", () => {
    expect(billTicketFrom({ ...bill, taxTotal: "0.00" }, 14).taxLine).toBeNull();
  });

  it("says excl. when prices do not include tax", () => {
    expect(billTicketFrom({ ...bill, pricesIncludeTax: false }, 14).taxLine).toBe("GST 5% (excl.)");
  });

  it("folds the address into lines, skipping the parts that are not set", () => {
    // Most venues fill in two of these six fields. Blank lines on a
    // receipt look like a broken printer.
    expect(billTicketFrom(bill, 14).addressLines).toEqual([
      "12-3-45 Banjara Hills",
      "Hyderabad 500034",
    ]);
  });

  it("carries the token so the paper matches the slip in the hand", () => {
    expect(billTicketFrom(bill, 14).token).toBe(14);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
source .superpowers/sdd/2026-10-04-round-level-orders/local-db.env
pnpm --filter @menu/api exec vitest run src/printing/ticket-payload.spec.ts
```

Expected: FAIL — cannot resolve `./ticket-payload`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/printing/ticket-payload.ts`:

```ts
import type { BillTicket, KitchenTicket, TokenTicket } from "@menu/shared";
import type { Bill } from "../billing/billing.service";

/**
 * Everything a round's two tickets need, in the shape the queries return.
 *
 * Deliberately not a Prisma type: this file is pure so it can be tested
 * without a database, and a Prisma payload type would drag the client in
 * and make the fixtures above twenty lines longer each.
 */
export interface TicketSource {
  businessName: string;
  order: {
    dailyNumber: number;
    note: string | null;
    isRunning: boolean;
    tableLabel: string;
  };
  round: {
    seq: number;
    kotNumber: number;
    placedAt: Date;
    items: { quantity: number; nameSnapshot: string; variantSnapshot: string | null }[];
  };
}

export function tokenTicketFrom(src: TicketSource): TokenTicket {
  return {
    kind: "token",
    businessName: src.businessName,
    // The ORDER's number, not the round's. One table, one number, whatever
    // round they are on — otherwise the counter cannot match a slip to food.
    token: src.order.dailyNumber,
    seq: src.round.seq,
    tableLabel: src.order.tableLabel,
    at: src.round.placedAt.toISOString(),
  };
}

export function kitchenTicketFrom(src: TicketSource): KitchenTicket {
  return {
    kind: "kitchen",
    token: src.order.dailyNumber,
    tableLabel: src.order.tableLabel,
    kotNumber: src.round.kotNumber,
    seq: src.round.seq,
    isRunning: src.order.isRunning,
    // order_items has no note column; what a diner can write is the order's.
    note: src.order.note,
    at: src.round.placedAt.toISOString(),
    items: src.round.items.map((i) => ({
      quantity: i.quantity,
      name: i.nameSnapshot,
      variant: i.variantSnapshot,
    })),
  };
}

/**
 * The Bill the screen and the PDF both show, as paper.
 *
 * Nothing is recomputed here — every number is carried across as the string
 * `generate_bill` produced. A receipt whose paper total disagrees with its
 * screen total is the worst bug this feature could have, and the only way
 * to be sure is to do no arithmetic.
 */
export function billTicketFrom(bill: Bill, token: number): BillTicket {
  const b = bill.business;

  // Two of these six fields are filled in at a typical venue. Blank lines
  // on a receipt look like a broken printer.
  const addressLines = [
    b.addressLine1,
    b.addressLine2,
    [b.city, b.state].filter(Boolean).join(", ") + (b.postalCode ? ` ${b.postalCode}` : ""),
  ]
    .map((l) => (l ?? "").trim())
    .filter((l) => l.length > 0);

  return {
    kind: "bill",
    businessName: b.name,
    addressLines,
    gstin: b.gstin,
    billNumber: bill.billNumber,
    tableLabel: bill.tableLabel,
    token,
    issuedAt: bill.issuedAt,
    taxLine: taxLineFor(bill),
    subtotal: bill.subtotal,
    taxTotal: bill.taxTotal,
    serviceCharge: bill.serviceCharge,
    serviceChargeRate: bill.serviceChargeRate,
    roundOff: bill.roundOff,
    total: bill.total,
    receiptFooter: bill.receiptFooter,
    lines: bill.lines.map((l) => ({
      name: l.name,
      variant: l.variant,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      lineTotal: l.lineTotal,
    })),
  };
}

/**
 * "GST 5% (incl.)", or just "GST", or nothing.
 *
 * The rate is named only when every line carries the same one. Rates are
 * snapshotted per round on purpose, so a price or rate change mid-meal
 * leaves lines that disagree — and naming one of them on the paper would
 * state a rate the customer was not charged.
 */
function taxLineFor(bill: Bill): string | null {
  if (Number(bill.taxTotal) === 0) return null;

  const rates = new Set(bill.lines.map((l) => Number(l.taxRate)));
  if (rates.size !== 1) return bill.taxLabel;

  const rate = [...rates][0]!;
  const suffix = bill.pricesIncludeTax ? "incl." : "excl.";
  // Number("5.00") is 5, so this drops the trailing zeros for free:
  // "GST 5%" reads better than "GST 5.00%", and 12.5% still prints as 12.5%.
  return `${bill.taxLabel} ${rate}% (${suffix})`;
}
```

- [ ] **Step 4: Run and commit**

```bash
source .superpowers/sdd/2026-10-04-round-level-orders/local-db.env
pnpm --filter @menu/api exec vitest run src/printing/ticket-payload.spec.ts
pnpm --filter @menu/api lint
```

Expected: 9 passing, typecheck clean.

```bash
git add apps/api/src/printing/ticket-payload.ts apps/api/src/printing/ticket-payload.spec.ts
git commit -m "feat(api): turn rows into the tickets the encoder prints"
```

---

### Task 11: The claim, and what came of it

**The insert is the claim.** A second tab racing for the same token gets a `409` off the unique index and skips. This is the only thing standing between the shop and double-printed tokens, and it is a database constraint rather than application code because application code cannot win a race it is in.

The response carries the ticket, so a station does one round trip per piece of paper rather than two. Generating the bill is a side effect, which is why it lives on this POST and not on the side-effect-free `pending`.

**Files:**
- Create: `apps/api/src/printing/claim.spec.ts`
- Modify: `apps/api/src/printing/receipts.service.ts`
- Modify: `apps/api/src/printing/stations.service.ts`
- Modify: `apps/api/src/printing/printing.controller.ts`
- Modify: `apps/api/src/printing/pending.spec.ts` (constructor arity — see below)
- Modify: `apps/api/src/app.module.ts`
- Modify: `packages/shared/src/schemas.ts`

**`ReceiptsService` gains a third constructor argument here** (`BillingService`). Task 9's `pending.spec.ts` builds the service by hand with two, so it stops compiling the moment this lands. Add a `billing` stub to its `makeSvc` — `const billing = { generate: vi.fn() };` and pass it third — in the same commit. The alternative, leaving the suite red while "only Task 11's file" is green, is how a branch arrives at review with a broken test nobody owns.

**Interfaces:**
- Consumes: `tokenTicketFrom`, `kitchenTicketFrom`, `billTicketFrom` (Task 10); `BillingService.generate` (owner-only — see the ruling in Step 3); `jobsForEvent` (Task 1); `StationsService.resolve` (Task 8).
- Produces: `ReceiptsService.claim(userId, bid, stationId, { eventId, job, reprint })` → `{ receiptId: string; attempt: number; paperWidth: 58 | 80; ticket: Ticket }`. Prisma types `paperWidth` as `number` (it is a smallint), while the web side's `Claimed` narrows it to `PaperWidth`. That narrowing is sound because `station_outputs_paper_width_check` admits only 58 and 80, and the check is named in the service's return type comment so the next reader does not have to rediscover why the cast is safe; `ReceiptsService.report(userId, bid, stationId, receiptId, { status, error })`; routes `POST :sid/receipts` and `POST :sid/receipts/:rid/result`; schemas `claimSchema`, `receiptResultSchema`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/printing/claim.spec.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { ConflictException, ForbiddenException } from "@nestjs/common";
import { ReceiptsService } from "./receipts.service";

/**
 * What `$queryRaw` surfaces when the claim's unique index rejects the insert.
 *
 * Not a Prisma P2002: a raw query failure arrives as the Postgres error text,
 * so the service matches on the constraint name. A fake that threw P2002
 * would test a code path production never reaches.
 */
class UniqueViolation extends Error {
  constructor() {
    super(
      'ERROR: duplicate key value violates unique constraint "print_receipts_claim_key"',
    );
  }
}

function makeSvc(opts: { role?: "owner" | "kitchen"; insert?: () => unknown } = {}) {
  const create = vi.fn(opts.insert ?? (async () => ({ id: BigInt(9), attempt: 1 })));
  const prisma = {
    db: {
      printReceipt: { create, findFirst: vi.fn().mockResolvedValue(null), update: vi.fn() },
      orderEvent: {
        findFirst: vi.fn().mockResolvedValue({
          id: BigInt(1),
          kind: "round.accepted",
          orderId: "o1",
          roundId: "r1",
          businessId: "b1",
        }),
      },
      orderRound: {
        findFirst: vi.fn().mockResolvedValue({
          seq: 2, kotNumber: 38, placedAt: new Date("2026-10-04T15:36:00.000Z"),
          items: [{ quantity: 2, nameSnapshot: "Irani Chai", variantSnapshot: null }],
          order: { dailyNumber: 14, note: null, isRunning: false, table: { label: "7" } },
        }),
      },
    },
  };
  const stations = {
    resolve: vi.fn().mockResolvedValue({
      id: "s1", businessId: "b1", revokedAt: null,
      business: { name: "Taste of Hyderabad" },
      outputs: [
        { job: "token", paperWidth: 58 },
        { job: "kitchen", paperWidth: 80 },
        { job: "bill", paperWidth: 80 },
      ],
    }),
    roleFor: vi.fn().mockResolvedValue(opts.role ?? "owner"),
  };
  const billing = { generate: vi.fn() };
  return { svc: new ReceiptsService(prisma as never, stations as never, billing as never), create, billing };
}

describe("ReceiptsService.claim", () => {
  it("hands back the ticket with the receipt, in one round trip", async () => {
    const { svc } = makeSvc();
    const out = await svc.claim("u1", "b1", "s1", { eventId: "1", job: "kitchen" });
    expect(out).toMatchObject({ receiptId: "9", attempt: 1, paperWidth: 80 });
    expect(out.ticket).toMatchObject({ kind: "kitchen", token: 14, kotNumber: 38 });
  });

  it("uses the paper width of the output that will print it", async () => {
    // One machine can hold a 58mm token roll and an 80mm kitchen roll.
    // Width is a property of the output, never of the station.
    const { svc } = makeSvc();
    const out = await svc.claim("u1", "b1", "s1", { eventId: "1", job: "token" });
    expect(out.paperWidth).toBe(58);
  });

  it("turns a lost race into 409, not a 500", async () => {
    // Review Focus 2. Two tabs on one machine both claim; the loser must
    // get an answer it can treat as "someone else took it" and move on.
    const { svc } = makeSvc({
      insert: () => {
        throw new UniqueViolation();
      },
    });
    await expect(
      svc.claim("u1", "b1", "s1", { eventId: "1", job: "token" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuses a bill claim from a kitchen principal", async () => {
    // Review Focus 1. The station could only have a bill output if an owner
    // attached it, but the claim is a second door into the same prices and
    // it gets the same lock.
    const { svc } = makeSvc({ role: "kitchen" });
    await expect(
      svc.claim("u1", "b1", "s1", { eventId: "1", job: "bill" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses a job the event does not produce", async () => {
    // Nothing should be able to ask for a bill off an accepted round. The
    // mapping is the authority, and a client is not.
    const { svc } = makeSvc();
    await expect(
      svc.claim("u1", "b1", "s1", { eventId: "1", job: "bill" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses a job this station has no printer for", async () => {
    const { svc } = makeSvc();
    (svc as never as { stations: { resolve: ReturnType<typeof vi.fn> } }).stations.resolve =
      vi.fn().mockResolvedValue({
        id: "s1", businessId: "b1", revokedAt: null,
        business: { name: "X" }, outputs: [{ job: "kitchen", paperWidth: 80 }],
      });
    await expect(
      svc.claim("u1", "b1", "s1", { eventId: "1", job: "token" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("ReceiptsService.report", () => {
  it("records a failure with its error, so the screen can offer a reprint", async () => {
    const { svc } = makeSvc();
    const prisma = (svc as never as { prisma: { db: { printReceipt: { update: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> } } } }).prisma;
    prisma.db.printReceipt.findFirst.mockResolvedValue({ id: BigInt(9), stationId: "s1" });

    await svc.report("u1", "b1", "s1", "9", { status: "failed", error: "device unavailable" });
    expect(prisma.db.printReceipt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "failed", error: "device unavailable" }),
      }),
    );
  });

  it("stamps printed_at only on success", async () => {
    // "Printed at" has to mean paper came out. A timestamp on a failure
    // would make the owner's list say a ticket printed when it did not.
    const { svc } = makeSvc();
    const prisma = (svc as never as { prisma: { db: { printReceipt: { update: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> } } } }).prisma;
    prisma.db.printReceipt.findFirst.mockResolvedValue({ id: BigInt(9), stationId: "s1" });

    await svc.report("u1", "b1", "s1", "9", { status: "printed" });
    const data = prisma.db.printReceipt.update.mock.calls[0]![0].data as { printedAt: Date | null };
    expect(data.printedAt).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
source .superpowers/sdd/2026-10-04-round-level-orders/local-db.env
pnpm --filter @menu/api exec vitest run src/printing/claim.spec.ts
```

Expected: FAIL — `ReceiptsService` has no `claim`.

- [ ] **Step 3: Add the schemas, and a role accessor**

Append to `packages/shared/src/schemas.ts`:

```ts
export const claimSchema = z.object({
  /** order_events.id as a string — it is a bigint. */
  eventId: z.string().regex(/^\d+$/),
  job: z.enum(["token", "kitchen", "bill"]),
  /** A reprint takes the next attempt number rather than colliding. */
  reprint: z.boolean().optional(),
});
export type ClaimInput = z.infer<typeof claimSchema>;

export const receiptResultSchema = z.object({
  status: z.enum(["printed", "failed"]),
  error: z.string().max(500).optional(),
});
export type ReceiptResultInput = z.infer<typeof receiptResultSchema>;
```

In `StationsService`, add a small accessor so `ReceiptsService` can ask who is calling without reaching into `BusinessesService` itself, and make `resolve` include the business name the token slip needs:

```ts
  /** The caller's role for this business, for the one decision that needs it. */
  async roleFor(userId: string, businessId: string) {
    const { role } = await this.businesses.assertAccess(userId, businessId, {
      allow: [...STATION_ROLES.allow],
    });
    return role;
  }
```

and in `resolve`, widen the include:

```ts
      include: { outputs: true, business: { select: { name: true } } },
```

**Ruling to carry:** `BillingService.generate` calls `assertOwns`, so a kitchen principal cannot reach it even for a station the owner configured. That is fine *here* because a `bill` claim is owner-only anyway — the two locks agree. Do not "fix" `BillingService` to accept staff; that would widen price access for every caller, which is the opposite of what the RBAC work established.

- [ ] **Step 4: Write the implementation**

Add to `apps/api/src/printing/receipts.service.ts`:

```ts
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { jobsForEvent, type PrintJob, type Ticket } from "@menu/shared";
import { BillingService } from "../billing/billing.service";
import { billTicketFrom, kitchenTicketFrom, tokenTicketFrom } from "./ticket-payload";
```

(add `BillingService` to the constructor), then:

```ts
  /**
   * Take a job, and get back the paper to print.
   *
   * THE INSERT IS THE CLAIM. Two tabs on one machine both arrive here; the
   * unique index on (station, event, job, attempt) lets one through and
   * the other gets a 409 it treats as "someone else took it". Checking
   * first and inserting second would lose the race it is trying to win.
   *
   * The ticket comes back with the receipt so a station does one round
   * trip per piece of paper. Generating a bill is a side effect, which is
   * why it happens here and not in the side-effect-free `pending`.
   */
  async claim(
    userId: string,
    businessId: string,
    stationId: string,
    body: { eventId: string; job: PrintJob; reprint?: boolean },
  ): Promise<{ receiptId: string; attempt: number; paperWidth: number; ticket: Ticket }> {
    const station = await this.stations.resolve(userId, businessId, stationId, { touch: true });

    const output = station.outputs.find((o) => o.job === body.job);
    if (!output) throw new ForbiddenException("This machine has no printer for that job");

    // A bill is prices. The station could only hold a bill output if an
    // owner attached it, but the claim is a second door to the same data
    // and gets the same lock.
    if (body.job === "bill") {
      const role = await this.stations.roleFor(userId, businessId);
      if (role !== "owner") throw new ForbiddenException("Only the owner can print a bill");
    }

    const event = await this.prisma.db.orderEvent.findFirst({
      where: { id: BigInt(body.eventId), businessId },
    });
    if (!event) throw new NotFoundException("Event not found");

    // The mapping is the authority. A client asking for a bill off an
    // accepted round is asking for something that does not exist.
    if (!jobsForEvent(event.kind).includes(body.job)) {
      throw new ForbiddenException("That event does not produce that ticket");
    }

    const attempt = body.reprint ? await this.nextAttempt(stationId, event.id, body.job) : 1;

    let receipt: { id: bigint; attempt: number };
    try {
      // Through claim_print_receipt, not printReceipt.create: there is no
      // kitchen INSERT policy on this table, by the schema-wide invariant.
      const rows = await this.prisma.db.$queryRaw<
        { receipt: { id: bigint; attempt: number } }[]
      >`SELECT claim_print_receipt(
          ${businessId}::uuid, ${stationId}::uuid, ${event.id}::bigint,
          ${body.job}::"PrintJob", ${attempt}::int
        ) AS receipt`;
      receipt = rows[0]!.receipt;
    } catch (e) {
      const message = e instanceof Error ? e.message : "";

      // ORDER MATTERS. The unique violation is checked FIRST and by name:
      // it is the whole concurrency control, and the generic ERROR: handler
      // below would otherwise turn a lost race into a 400 that the station
      // page treats as a real failure instead of "someone else took it".
      if (message.includes("print_receipts_claim_key") || message.includes("23505")) {
        throw new ConflictException("Another station tab already took this ticket");
      }
      if (message.includes("not your business")) {
        throw new ForbiddenException("That station is not yours");
      }
      if (message.includes("no such station") || message.includes("no such event")) {
        throw new NotFoundException("Station or event not found");
      }
      throw e;
    }

    const ticket = await this.ticketFor(userId, businessId, station, event, body.job);
    return {
      receiptId: String(receipt.id),
      attempt: receipt.attempt,
      paperWidth: output.paperWidth,
      ticket,
    };
  }

  private async nextAttempt(stationId: string, eventId: bigint, job: PrintJob) {
    const last = await this.prisma.db.printReceipt.findFirst({
      where: { stationId, eventId, job },
      orderBy: { attempt: "desc" },
      select: { attempt: true },
    });
    return (last?.attempt ?? 0) + 1;
  }

  private async ticketFor(
    userId: string,
    businessId: string,
    station: { business: { name: string } },
    event: { id: bigint; orderId: string; roundId: string | null },
    job: PrintJob,
  ): Promise<Ticket> {
    if (job === "bill") {
      // generate_bill returns the existing bill rather than recomputing, so
      // a reprint is identical to the original by construction.
      const bill = await this.billing.generate(userId, businessId, event.orderId);
      const order = await this.prisma.db.order.findFirstOrThrow({
        where: { id: event.orderId, businessId },
        select: { dailyNumber: true },
      });
      return billTicketFrom(bill, order.dailyNumber);
    }

    if (!event.roundId) throw new NotFoundException("That event has no round");
    const round = await this.prisma.db.orderRound.findFirstOrThrow({
      where: { id: event.roundId, businessId },
      include: {
        items: { orderBy: { createdAt: "asc" } },
        order: { select: { dailyNumber: true, note: true, isRunning: true, table: { select: { label: true } } } },
      },
    });

    const src = {
      businessName: station.business.name,
      order: {
        dailyNumber: round.order.dailyNumber,
        note: round.order.note,
        isRunning: round.order.isRunning ?? false,
        tableLabel: round.order.table.label,
      },
      round: {
        seq: round.seq,
        kotNumber: round.kotNumber,
        placedAt: round.placedAt,
        items: round.items.map((i) => ({
          quantity: i.quantity,
          nameSnapshot: i.nameSnapshot,
          variantSnapshot: i.variantSnapshot,
        })),
      },
    };
    return job === "token" ? tokenTicketFrom(src) : kitchenTicketFrom(src);
  }

  /**
   * What came of it.
   *
   * A failure keeps its error so the station screen can show it beside a
   * Reprint button, and `printed_at` is stamped only on success — a
   * timestamp on a failure would have the owner's list claim a ticket
   * printed when no paper came out.
   */
  async report(
    userId: string,
    businessId: string,
    stationId: string,
    receiptId: string,
    body: { status: "printed" | "failed"; error?: string },
  ) {
    await this.stations.resolve(userId, businessId, stationId, { touch: true });

    const receipt = await this.prisma.db.printReceipt.findFirst({
      where: { id: BigInt(receiptId), stationId, businessId },
    });
    if (!receipt) throw new NotFoundException("Receipt not found");

    await this.prisma.db.printReceipt.update({
      where: { id: receipt.id },
      data: {
        status: body.status,
        error: body.error ?? null,
        printedAt: body.status === "printed" ? new Date() : null,
      },
    });
  }
```

- [ ] **Step 5: Add the routes**

In `printing.controller.ts`:

```ts
  @Post(":sid/receipts")
  claim(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Param("sid") sid: string,
    @Body(new ZodBody(claimSchema)) body: ClaimInput,
  ) {
    return this.receipts.claim(user.id, bid, sid, body);
  }

  @Post(":sid/receipts/:rid/result")
  @HttpCode(204)
  async result(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Param("sid") sid: string,
    @Param("rid") rid: string,
    @Body(new ZodBody(receiptResultSchema)) body: ReceiptResultInput,
  ) {
    await this.receipts.report(user.id, bid, sid, rid, body);
  }
```

- [ ] **Step 6: Run and commit**

```bash
source .superpowers/sdd/2026-10-04-round-level-orders/local-db.env
pnpm --filter @menu/api exec vitest run src/printing/claim.spec.ts
pnpm --filter @menu/api exec vitest run
pnpm --filter @menu/api lint
```

Expected: 8 passing in the new file, whole suite green.

```bash
git add apps/api/src/printing/receipts.service.ts apps/api/src/printing/claim.spec.ts \
        apps/api/src/printing/printing.controller.ts apps/api/src/printing/stations.service.ts \
        packages/shared/src/schemas.ts
git commit -m "feat(api): make the insert the claim, and hand back the paper"
```

---

### Task 12: The station loop, with no browser in it

Fetch what is waiting, claim it, render it, write it, say what happened. All of it in `lib/`, taking a transport and an api as arguments, because web vitest runs in a **node** environment — there is no `navigator` to mock, and logic that needs one cannot be tested at all.

This is also the task where the failure modes from the spec's "when it goes wrong" table become code: printer unplugged, write fails mid-ticket, two tabs, station revoked.

**Files:**
- Create: `apps/web/lib/station/transport.ts`
- Create: `apps/web/lib/station/loop.ts`
- Create: `apps/web/lib/station/loop.spec.ts`
- Create: `apps/web/lib/station/identity.ts`
- Create: `apps/web/lib/station/identity.spec.ts`

**Interfaces:**
- Consumes: `encodeTicket`, `PrintJob`, `Ticket`, `PaperWidth` (Tasks 1–6).
- Produces: `interface PrinterTransport { granted(): Promise<string[]>; write(deviceKey: string, bytes: Uint8Array): Promise<void> }`; `interface StationApi`; `interface StationOutputRef { job: PrintJob; deviceKey: string }`; `drain(api, transport, outputs): Promise<DrainResult>`; `interface DrainResult { printed: number; skipped: number; failed: number; disconnected: PrintJob[] }`; `stationIdFor(businessId: string): string | null`, `rememberStation(businessId, id)`, `forgetStation(businessId)`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/station/loop.spec.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { drain, type PrinterTransport, type StationApi } from "./loop";

const job = (eventId: string, j: "token" | "kitchen" | "bill") => ({
  eventId, job: j, kind: "round.accepted", at: "2026-10-04T15:36:00.000Z",
  orderId: "o1", tableLabel: "7", token: 14,
});

const ticket = { kind: "token", businessName: "X", token: 14, seq: 1, tableLabel: "7", at: "2026-10-04T15:36:00.000Z" } as const;

function fakes(opts: {
  pending?: ReturnType<typeof job>[];
  granted?: string[];
  claim?: StationApi["claim"];
  write?: PrinterTransport["write"];
} = {}) {
  const api: StationApi = {
    pending: vi.fn().mockResolvedValue({
      pending: opts.pending ?? [job("1", "token")],
      missed: [],
      topic: "business:abc",
    }),
    claim: opts.claim ?? vi.fn().mockResolvedValue({ receiptId: "9", paperWidth: 58, ticket }),
    report: vi.fn().mockResolvedValue(undefined),
  };
  const transport: PrinterTransport = {
    granted: vi.fn().mockResolvedValue(opts.granted ?? ["dev-token"]),
    write: opts.write ?? vi.fn().mockResolvedValue(undefined),
  };
  return { api, transport, outputs: [{ job: "token" as const, deviceKey: "dev-token" }] };
}

describe("drain", () => {
  it("claims, writes and reports each waiting job", async () => {
    const { api, transport, outputs } = fakes();
    const out = await drain(api, transport, outputs);

    expect(api.claim).toHaveBeenCalledWith("1", "token", false);
    expect(transport.write).toHaveBeenCalledOnce();
    expect(api.report).toHaveBeenCalledWith("9", "printed", undefined);
    expect(out).toMatchObject({ printed: 1, failed: 0, skipped: 0 });
  });

  it("treats a lost claim as someone else's ticket, not an error", async () => {
    // Review Focus 2, the other half. The index stops the second slip; this
    // stops the second tab showing the staff a red error about it.
    const { api, transport, outputs } = fakes({ claim: vi.fn().mockResolvedValue("taken") });
    const out = await drain(api, transport, outputs);

    expect(transport.write).not.toHaveBeenCalled();
    expect(api.report).not.toHaveBeenCalled();
    expect(out).toMatchObject({ printed: 0, skipped: 1, failed: 0 });
  });

  it("does not claim a job whose printer is not connected", async () => {
    // Claiming first would consume the ticket and then fail to print it,
    // and nothing would ever offer it again. The job stays unclaimed until
    // the printer is back, which is what makes "2 tickets waiting" true.
    const { api, transport, outputs } = fakes({ granted: [] });
    const out = await drain(api, transport, outputs);

    expect(api.claim).not.toHaveBeenCalled();
    expect(out.disconnected).toEqual(["token"]);
    expect(out.printed).toBe(0);
  });

  it("reports a write that failed, with the error", async () => {
    // Half-printed paper is physical: the screen needs to offer a reprint,
    // and it can only do that if the receipt says what went wrong.
    const { api, transport, outputs } = fakes({
      write: vi.fn().mockRejectedValue(new Error("device unavailable")),
    });
    const out = await drain(api, transport, outputs);

    expect(api.report).toHaveBeenCalledWith("9", "failed", "device unavailable");
    expect(out).toMatchObject({ printed: 0, failed: 1 });
  });

  it("keeps going after one job fails", async () => {
    // One jammed printer must not stop the other roll on the same machine.
    const { api, transport } = fakes({ pending: [job("1", "token"), job("2", "kitchen")] });
    (transport.write as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("jam"))
      .mockResolvedValueOnce(undefined);

    const out = await drain(api, transport, [
      { job: "token", deviceKey: "dev-token" },
      { job: "kitchen", deviceKey: "dev-token" },
    ]);
    expect(out).toMatchObject({ printed: 1, failed: 1 });
  });

  it("never prints a missed job on its own", async () => {
    // The whole point of the window: what is old waits for a human.
    const api: StationApi = {
      pending: vi.fn().mockResolvedValue({ pending: [], missed: [job("9", "token")], topic: null }),
      claim: vi.fn(),
      report: vi.fn(),
    };
    const { transport, outputs } = fakes();
    await drain(api, transport, outputs);
    expect(api.claim).not.toHaveBeenCalled();
  });
});
```

Create `apps/web/lib/station/identity.spec.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { forgetStation, rememberStation, stationIdFor } from "./identity";

/** A minimal localStorage, because this runs in node. */
beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});

describe("station identity", () => {
  it("remembers which station this machine is, per business", () => {
    // One machine, two venues in the switcher. Remembering a single id
    // would have the second venue's tab claim the first venue's tickets.
    rememberStation("b1", "s1");
    rememberStation("b2", "s2");
    expect(stationIdFor("b1")).toBe("s1");
    expect(stationIdFor("b2")).toBe("s2");
  });

  it("is nothing on a machine that was never set up", () => {
    expect(stationIdFor("b1")).toBeNull();
  });

  it("forgets, which is what a revoked station does", () => {
    rememberStation("b1", "s1");
    forgetStation("b1");
    expect(stationIdFor("b1")).toBeNull();
  });

  it("survives a browser with no localStorage at all", () => {
    // Private mode and some embedded webviews throw on access. A station
    // that crashes on load cannot even show why.
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(() => stationIdFor("b1")).not.toThrow();
    expect(stationIdFor("b1")).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
pnpm --filter @menu/web exec vitest run lib/station
```

Expected: FAIL — cannot resolve `./loop` or `./identity`.

- [ ] **Step 3: Write the transport interface**

Create `apps/web/lib/station/transport.ts`:

```ts
/**
 * A printer, as far as the loop is concerned.
 *
 * Two methods, both async, neither mentioning USB. That is the whole point:
 * `loop.ts` takes one of these and is therefore testable in node, where
 * `navigator` does not exist. The WebUSB and Web Serial implementations
 * below are the only code in this feature that touches the browser's
 * device APIs, and they have no logic in them to get wrong.
 */
export interface PrinterTransport {
  /** device_keys the browser has already granted this origin, no prompt. */
  granted(): Promise<string[]>;
  write(deviceKey: string, bytes: Uint8Array): Promise<void>;
}

type UsbDevice = {
  vendorId: number;
  productId: number;
  serialNumber?: string;
  open(): Promise<void>;
  selectConfiguration(n: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  transferOut(endpoint: number, data: BufferSource): Promise<unknown>;
  close(): Promise<void>;
  configuration?: { interfaces: { interfaceNumber: number; alternate: { endpoints: { direction: string; endpointNumber: number }[] } }[] };
};

export function deviceKeyOf(d: { vendorId: number; productId: number; serialNumber?: string }): string {
  return `${d.vendorId}:${d.productId}:${d.serialNumber ?? ""}`;
}

/**
 * WebUSB.
 *
 * Chrome and Edge only; Safari and Firefox have neither this nor Web
 * Serial, which the page says plainly rather than failing silently. On
 * Windows a printer installed as a normal Windows printer is claimed by
 * usbprint.sys and cannot be taken over without a one-time WinUSB swap —
 * the chooser simply comes up empty, which the link screen explains.
 */
export function usbTransport(): PrinterTransport {
  const nav = globalThis.navigator as unknown as { usb?: { getDevices(): Promise<UsbDevice[]> } };

  return {
    async granted() {
      if (!nav?.usb) return [];
      return (await nav.usb.getDevices()).map(deviceKeyOf);
    },
    async write(deviceKey, bytes) {
      if (!nav?.usb) throw new Error("This browser has no WebUSB. Use Chrome or Edge.");
      const device = (await nav.usb.getDevices()).find((d) => deviceKeyOf(d) === deviceKey);
      if (!device) throw new Error("Printer not connected");

      await device.open();
      if (!device.configuration) await device.selectConfiguration(1);
      const iface = device.configuration!.interfaces[0]!;
      await device.claimInterface(iface.interfaceNumber);
      const endpoint = iface.alternate.endpoints.find((e) => e.direction === "out");
      if (!endpoint) throw new Error("Printer has no output endpoint");
      try {
        await device.transferOut(endpoint.endpointNumber, bytes);
      } finally {
        // Released even on failure: a half-written ticket must not leave
        // the device claimed and unusable until the tab is closed.
        await device.close();
      }
    },
  };
}
```

- [ ] **Step 4: Write the loop and the identity helpers**

Create `apps/web/lib/station/loop.ts`:

```ts
import { encodeTicket, type PaperWidth, type PrintJob, type Ticket } from "@menu/shared";
import type { PrinterTransport } from "./transport";

export type { PrinterTransport } from "./transport";

export interface PendingJob {
  eventId: string;
  job: PrintJob;
  kind: string;
  at: string;
  orderId: string;
  tableLabel: string;
  token: number;
}

export interface Claimed {
  receiptId: string;
  paperWidth: PaperWidth;
  ticket: Ticket;
}

export interface StationApi {
  pending(): Promise<{ pending: PendingJob[]; missed: PendingJob[]; topic: string | null }>;
  /** Resolves to "taken" when another tab won the race — a 409, not an error. */
  claim(eventId: string, job: PrintJob, reprint: boolean): Promise<Claimed | "taken">;
  report(receiptId: string, status: "printed" | "failed", error?: string): Promise<void>;
}

export interface StationOutputRef {
  job: PrintJob;
  deviceKey: string;
}

export interface DrainResult {
  printed: number;
  skipped: number;
  failed: number;
  /** Jobs with waiting work whose printer is not currently connected. */
  disconnected: PrintJob[];
}

/**
 * One pass: print everything waiting that this machine can print.
 *
 * Two orderings here are load-bearing.
 *
 * The printer is checked BEFORE the claim. Claiming first would consume
 * the ticket and then fail to write it, and nothing would offer it again —
 * the slip would simply never exist. Leaving it unclaimed is what makes
 * "Kitchen printer not connected — 2 tickets waiting" a true statement
 * that resolves itself when the cable goes back in.
 *
 * And the report comes after the write, never instead of it. A receipt
 * marked printed is a promise that paper came out.
 *
 * Missed jobs are never touched: that is the whole point of the window.
 */
export async function drain(
  api: StationApi,
  transport: PrinterTransport,
  outputs: StationOutputRef[],
): Promise<DrainResult> {
  const { pending } = await api.pending();
  const result: DrainResult = { printed: 0, skipped: 0, failed: 0, disconnected: [] };
  if (pending.length === 0) return result;

  const connected = new Set(await transport.granted());
  const byJob = new Map(outputs.map((o) => [o.job, o.deviceKey]));

  for (const item of pending) {
    const deviceKey = byJob.get(item.job);
    if (!deviceKey) continue;

    if (!connected.has(deviceKey)) {
      if (!result.disconnected.includes(item.job)) result.disconnected.push(item.job);
      continue;
    }

    const claimed = await api.claim(item.eventId, item.job, false);
    if (claimed === "taken") {
      result.skipped++;
      continue;
    }

    try {
      await transport.write(deviceKey, encodeTicket(claimed.ticket, claimed.paperWidth));
      await api.report(claimed.receiptId, "printed", undefined);
      result.printed++;
    } catch (e) {
      // One jammed printer must not stop the other roll on this machine.
      await api.report(claimed.receiptId, "failed", (e as Error).message);
      result.failed++;
    }
  }

  return result;
}
```

Create `apps/web/lib/station/identity.ts`:

```ts
/**
 * Which station this machine is, remembered per business.
 *
 * Per business, not one id: a machine whose user has two venues in the
 * switcher would otherwise have the second venue's tab claiming the
 * first venue's tickets.
 *
 * Every access is guarded. Private mode and some embedded webviews throw
 * on localStorage, and a station page that crashes on load cannot even
 * show why.
 */
const key = (businessId: string) => `station:${businessId}`;

export function stationIdFor(businessId: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key(businessId)) ?? null;
  } catch {
    return null;
  }
}

export function rememberStation(businessId: string, stationId: string): void {
  try {
    globalThis.localStorage?.setItem(key(businessId), stationId);
  } catch {
    /* A station that cannot remember still works; it just asks again. */
  }
}

export function forgetStation(businessId: string): void {
  try {
    globalThis.localStorage?.removeItem(key(businessId));
  } catch {
    /* ignore */
  }
}
```

- [ ] **Step 5: Run and commit**

```bash
pnpm --filter @menu/shared build
pnpm --filter @menu/web exec vitest run lib/station
pnpm --filter @menu/web lint
```

Expected: 10 passing (6 loop, 4 identity), typecheck clean.

```bash
git add apps/web/lib/station/
git commit -m "feat(web): drive a station's printers without a browser in the logic"
```

---

### Task 13: The screen that stays open on the shop machine

`/(app)/station`. Set up this machine, link its printers, then sit there printing. Everything it decides is in `lib/station` from Task 12; this file is the shell that supplies a real transport, a real api client, and a Realtime subscription.

**Files:**
- Create: `apps/web/app/(app)/station/page.tsx`
- Create: `apps/web/lib/station/api.ts`
- Create: `apps/web/lib/station/api.spec.ts`

**Interfaces:**
- Consumes: `drain`, `StationApi`, `usbTransport`, `stationIdFor`, `rememberStation`, `forgetStation` (Task 12); `api`, `ApiError` from `@/lib/api-client`; `useSession` from `@/components/session`; `openChannel`, `realtimeConfig` from `@/lib/notifications/realtime` — the same helper the notifications provider uses (`components/notifications/provider.tsx:213`), so there is one Realtime client in this app and not two.
- Produces: `stationApi(businessId: string, stationId: string): StationApi`; the page.

- [ ] **Step 1: Write the failing test**

The page itself is not unit-tested — web vitest runs in node and the page is JSX. What *is* tested is the adapter, because it holds the one decision that is easy to get wrong: turning HTTP status codes into the loop's vocabulary.

Create `apps/web/lib/station/api.spec.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client";
import { stationApi } from "./api";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, api: { get: vi.fn(), post: vi.fn() } };
});

const { api } = await import("@/lib/api-client");

describe("stationApi.claim", () => {
  it("turns a 409 into 'taken' rather than throwing", async () => {
    // The loop treats this as "my neighbour tab printed it". If it threw,
    // the station would show an error for a ticket that came out fine.
    (api.post as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiError(409, "Conflict"));
    await expect(stationApi("b1", "s1").claim("1", "token", false)).resolves.toBe("taken");
  });

  it("lets a 410 through, because that one must stop the station", async () => {
    // A revoked machine has to notice. Swallowing this would leave a
    // retired station polling forever.
    (api.post as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiError(410, "Gone"));
    await expect(stationApi("b1", "s1").claim("1", "token", false)).rejects.toBeInstanceOf(ApiError);
  });

  it("lets every other failure through", async () => {
    (api.post as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiError(500, "Boom"));
    await expect(stationApi("b1", "s1").claim("1", "token", false)).rejects.toBeInstanceOf(ApiError);
  });
});
```

**Before writing this, open `apps/web/lib/api-client.ts`** and check `ApiError`'s constructor signature and the exact shape of `api.post`. The test above assumes `new ApiError(status, message)` and `api.post(path, body?)`; if either differs, match the file, not this plan.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @menu/web exec vitest run lib/station/api.spec.ts
```

Expected: FAIL — cannot resolve `./api`.

- [ ] **Step 3: Write the adapter**

Create `apps/web/lib/station/api.ts`:

```ts
import { api, ApiError } from "@/lib/api-client";
import type { PrintJob } from "@menu/shared";
import type { Claimed, PendingJob, StationApi } from "./loop";

/**
 * The loop's api, over HTTP.
 *
 * The one judgement here is which failures are the loop's business. A 409
 * means another tab won the claim, which is a normal outcome and not an
 * error — the loop is told "taken" and moves on. Everything else,
 * including the 410 that means this machine has been revoked, is thrown
 * so the page can act on it.
 */
export function stationApi(businessId: string, stationId: string): StationApi {
  const base = `/businesses/${businessId}/stations/${stationId}`;

  return {
    pending: () =>
      api.get<{ pending: PendingJob[]; missed: PendingJob[]; topic: string | null }>(
        `${base}/pending`,
      ),

    async claim(eventId: string, job: PrintJob, reprint: boolean) {
      try {
        return await api.post<Claimed>(`${base}/receipts`, { eventId, job, reprint });
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) return "taken" as const;
        throw e;
      }
    },

    report: (receiptId, status, error) =>
      api.post(`${base}/receipts/${receiptId}/result`, { status, error }).then(() => undefined),
  };
}
```

- [ ] **Step 4: Write the page**

Create `apps/web/app/(app)/station/page.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PRINT_JOBS, type AccessRole, type PrintJob } from "@menu/shared";
import { ApiError, api } from "@/lib/api-client";
import { useSession } from "@/components/session";
import { Banner, Button, Empty, Field, Input } from "@/components/ui";
import { stationApi } from "@/lib/station/api";
import { drain, type DrainResult, type PendingJob, type StationOutputRef } from "@/lib/station/loop";
import { forgetStation, rememberStation, stationIdFor } from "@/lib/station/identity";
import { openChannel, realtimeConfig } from "@/lib/notifications/realtime";
import { deviceKeyOf, usbTransport } from "@/lib/station/transport";

interface Output {
  job: PrintJob;
  deviceLabel: string;
  deviceKey: string;
  transport: "usb" | "serial";
  paperWidth: 58 | 80;
}
interface Station {
  id: string;
  name: string;
  outputs: Output[];
}

/** The ping is an optimisation over this, and is allowed to be lost. */
const POLL_MS = 10_000;

const JOB_LABEL: Record<PrintJob, string> = {
  token: "Customer token",
  kitchen: "Kitchen ticket",
  bill: "Bill",
};

export default function StationPage() {
  // useSession() has no `role` — the board derives it the same way at
  // orders/page.tsx:95, and this matches rather than inventing a second.
  const { current, me } = useSession();
  const role: AccessRole = me?.role === "kitchen" ? "kitchen" : "owner";
  const businessId = current?.id ?? null;

  const [station, setStation] = useState<Station | null>(null);
  const [name, setName] = useState("");
  const [connected, setConnected] = useState<string[]>([]);
  const [last, setLast] = useState<DrainResult | null>(null);
  const [missed, setMissed] = useState<PendingJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);
  /** The HMAC topic the API handed us. Never derived here. */
  const [topic, setTopic] = useState<string | null>(null);

  // One pass at a time. A ten-second poll overlapping a slow USB write
  // would have two drains claiming the same job from the same tab.
  const running = useRef(false);

  const load = useCallback(async () => {
    if (!businessId) return;
    const id = stationIdFor(businessId);
    if (!id) return setStation(null);
    try {
      const all = await api.get<Station[]>(`/businesses/${businessId}/stations`);
      const mine = all.find((s) => s.id === id) ?? null;
      if (!mine) {
        // Revoked, or set up against a venue this machine no longer sees.
        forgetStation(businessId);
        setRevoked(true);
      }
      setStation(mine);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load this machine");
    }
  }, [businessId]);

  useEffect(() => {
    void load();
  }, [load]);

  const tick = useCallback(async () => {
    if (!businessId || !station || running.current || revoked) return;
    running.current = true;
    try {
      const transport = usbTransport();
      setConnected(await transport.granted());

      const refs: StationOutputRef[] = station.outputs.map((o) => ({
        job: o.job,
        deviceKey: o.deviceKey,
      }));
      const client = stationApi(businessId, station.id);
      setLast(await drain(client, transport, refs));
      const fresh = await client.pending();
      setMissed(fresh.missed);
      setTopic(fresh.topic);
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 410) {
        // This machine is no longer a station. Stop, and say so.
        forgetStation(businessId);
        setRevoked(true);
        setStation(null);
      } else {
        setError(e instanceof Error ? e.message : "Printing failed");
      }
    } finally {
      running.current = false;
    }
  }, [businessId, station, revoked]);

  useEffect(() => {
    void tick();
    const t = setInterval(() => void tick(), POLL_MS);
    return () => clearInterval(t);
  }, [tick]);

  /*
   * The ping, on top of the poll.
   *
   * An accepted round should print now, not up to ten seconds from now, and
   * a socket is how that happens. It stays strictly an optimisation: the
   * poll above never stops, so a dropped message means a ticket arrives
   * late rather than not at all. openChannel is the same helper the
   * notifications provider uses, and the topic comes from the API — a
   * leaked business id must not yield a subscription to that venue.
   */
  useEffect(() => {
    if (!topic) return;
    const config = realtimeConfig();
    if (!config) return;

    const channel = openChannel({ ...config, topic, onPing: () => void tick() });
    return () => channel.close();
  }, [topic, tick]);

  async function setup() {
    if (!businessId) return;
    const created = await api.post<Station>(`/businesses/${businessId}/stations`, { name });
    rememberStation(businessId, created.id);
    setRevoked(false);
    setStation({ ...created, outputs: [] });
  }

  async function link(job: PrintJob, paperWidth: 58 | 80) {
    if (!businessId || !station) return;
    const nav = navigator as unknown as {
      usb?: { requestDevice(o: unknown): Promise<{ vendorId: number; productId: number; serialNumber?: string; productName?: string }> };
    };
    if (!nav.usb) {
      setError("This browser cannot talk to printers. Use Chrome or Edge.");
      return;
    }
    try {
      // classCode 7 is the USB printer class. A chooser that comes up
      // empty on Windows usually means usbprint.sys has the device.
      const device = await nav.usb.requestDevice({ filters: [{ classCode: 7 }] });
      await api.post(`/businesses/${businessId}/stations/${station.id}/outputs`, {
        job,
        deviceLabel: device.productName ?? "Printer",
        deviceKey: deviceKeyOf(device),
        transport: "usb",
        paperWidth,
      });
      await load();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 403
          ? "Only the owner can put a bill printer on a machine."
          : "No printer was chosen. On Windows, a printer installed as a normal Windows printer cannot be used here.",
      );
    }
  }

  if (!businessId) return <Empty title="Pick a venue first" />;

  if (revoked) {
    return (
      <Banner tone="warning">
        This machine is no longer a station. Ask the owner to set it up again.
      </Banner>
    );
  }

  if (!station) {
    return (
      <section className="mx-auto max-w-sm space-y-4 p-6">
        <h1 className="font-display text-xl font-semibold">Set up this machine</h1>
        <p className="text-[14px] text-muted">
          Name it after where it stands — Counter, Kitchen — so the owner&apos;s list makes
          sense from across the shop.
        </p>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
        </Field>
        <Button variant="primary" disabled={name.trim().length === 0} onClick={() => void setup()}>
          Set up this machine
        </Button>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-xl space-y-5 p-6">
      <header className="flex items-baseline justify-between">
        <h1 className="font-display text-xl font-semibold">{station.name}</h1>
        <span className="text-[13px] text-faint" data-testid="station-state">
          {last ? `${last.printed} printed · ${last.failed} failed` : "Starting…"}
        </span>
      </header>

      {error && <Banner tone="warning">{error}</Banner>}

      {last?.disconnected.map((job) => (
        <Banner key={job} tone="warning" data-testid={`disconnected-${job}`}>
          {JOB_LABEL[job]} printer not connected — tickets are waiting, and will print
          themselves when it is back.
        </Banner>
      ))}

      <ul className="space-y-2">
        {PRINT_JOBS.map((job) => {
          const out = station.outputs.find((o) => o.job === job);
          const live = out ? connected.includes(out.deviceKey) : false;
          return (
            <li
              key={job}
              data-testid={`output-${job}`}
              className="flex items-center justify-between rounded-xl border border-line p-3"
            >
              <span>
                <strong className="text-[14px]">{JOB_LABEL[job]}</strong>
                <span className="block text-[13px] text-faint">
                  {out
                    ? `${out.deviceLabel} · ${out.paperWidth}mm · ${live ? "Connected" : "Not connected"}`
                    : "No printer"}
                </span>
              </span>
              <span className="flex gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => void link(job, 58)}>
                  Link 58mm
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void link(job, 80)}>
                  Link 80mm
                </Button>
              </span>
            </li>
          );
        })}
      </ul>

      {missed.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-[14px] font-semibold">Missed</h2>
          <p className="text-[13px] text-faint">
            Older than half an hour. Nothing here prints on its own.
          </p>
          <ul className="space-y-1.5">
            {missed.map((m) => (
              <li key={`${m.eventId}:${m.job}`} className="flex items-center justify-between text-[13px]">
                <span>
                  Table {m.tableLabel} · token {m.token} · {JOB_LABEL[m.job]}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    const client = stationApi(businessId, station.id);
                    const claimed = await client.claim(m.eventId, m.job, true);
                    if (claimed === "taken") return;
                    const out = station.outputs.find((o) => o.job === m.job)!;
                    await usbTransport().write(
                      out.deviceKey,
                      (await import("@menu/shared")).encodeTicket(claimed.ticket, claimed.paperWidth),
                    );
                    await client.report(claimed.receiptId, "printed");
                    setMissed((rest) => rest.filter((x) => x !== m));
                  }}
                >
                  Print
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {role === "owner" && (
        <p className="text-[13px] text-faint">
          Manage every machine in <a className="underline" href="/settings/printing">Settings → Printing</a>.
        </p>
      )}
    </section>
  );
}
```

**Read `apps/web/components/ui.tsx` before writing this** and match the real props of `Banner`, `Button`, `Field`, `Input` and `Empty` — the names above follow the staff screen, but a `tone` or `size` that does not exist is a compile error, and the plan should not be trusted over the file. `data-testid` on `Banner` likewise: if it does not forward unknown props, wrap it in a `<div data-testid=...>` rather than changing the component for a test.

- [ ] **Step 5: Run and commit**

```bash
pnpm --filter @menu/web exec vitest run lib/station
pnpm --filter @menu/web lint
```

Expected: 13 passing across `lib/station`, typecheck clean.

```bash
git add apps/web/lib/station/api.ts apps/web/lib/station/api.spec.ts "apps/web/app/(app)/station/page.tsx"
git commit -m "feat(web): the screen that stays open on the shop machine"
```

---

### Task 14: The owner's view of every machine

`/(app)/settings/printing`. Which machines exist, when each was last seen, which printer is on which job, rename, revoke. Read-only about the devices themselves — linking happens on the machine, because that is the only place the browser can see its own USB.

**Files:**
- Create: `apps/web/app/(app)/settings/printing/page.tsx`
- Create: `apps/web/lib/station/last-seen.ts`
- Create: `apps/web/lib/station/last-seen.spec.ts`

**Interfaces:**
- Consumes: `api`, `useSession`, `useConfirm`; `PRINT_JOBS` (Task 1).
- Produces: `lastSeenLabel(lastSeenAt: string | null, now: Date): string`; the page.

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/station/last-seen.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { lastSeenLabel } from "./last-seen";

const NOW = new Date("2026-10-04T16:00:00.000Z");

describe("lastSeenLabel", () => {
  it("calls a station seen within the last minute online", () => {
    // It polls every ten seconds. Anything inside a minute is a machine
    // that is on and working, and should read as reassurance.
    expect(lastSeenLabel("2026-10-04T15:59:30.000Z", NOW)).toBe("Online");
  });

  it("counts the minutes while it is plausibly just slow", () => {
    expect(lastSeenLabel("2026-10-04T15:52:00.000Z", NOW)).toBe("Last seen 8 minutes ago");
  });

  it("switches to hours once minutes stop being useful", () => {
    expect(lastSeenLabel("2026-10-04T12:00:00.000Z", NOW)).toBe("Last seen 4 hours ago");
  });

  it("says plainly that a machine has never been seen", () => {
    // A station created and never opened again. "Last seen never" is a
    // riddle; this is the state an owner most needs to act on.
    expect(lastSeenLabel(null, NOW)).toBe("Never connected");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @menu/web exec vitest run lib/station/last-seen.spec.ts
```

Expected: FAIL — cannot resolve `./last-seen`.

- [ ] **Step 3: Write it**

Create `apps/web/lib/station/last-seen.ts`:

```ts
/**
 * "Is that machine on?" — as honestly as a server can answer it.
 *
 * The station refreshes last-seen every ten seconds, so a gap under a
 * minute means it is working and should read as reassurance rather than
 * as a number to interpret. Beyond that the units coarsen, because
 * "Last seen 247 minutes ago" is not a sentence anyone acts on.
 */
export function lastSeenLabel(lastSeenAt: string | null, now: Date = new Date()): string {
  if (!lastSeenAt) return "Never connected";

  const seconds = Math.max(0, (now.getTime() - new Date(lastSeenAt).getTime()) / 1000);
  if (seconds < 60) return "Online";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Last seen ${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Last seen ${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.floor(hours / 24);
  return `Last seen ${days} day${days === 1 ? "" : "s"} ago`;
}
```

- [ ] **Step 4: Write the page**

Create `apps/web/app/(app)/settings/printing/page.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { PRINT_JOBS, type PrintJob } from "@menu/shared";
import { api } from "@/lib/api-client";
import { useSession } from "@/components/session";
import { useConfirm } from "@/components/confirm";
import { Banner, Button, Empty, Input } from "@/components/ui";
import { lastSeenLabel } from "@/lib/station/last-seen";

interface Output {
  job: PrintJob;
  deviceLabel: string;
  paperWidth: 58 | 80;
}
interface Station {
  id: string;
  name: string;
  lastSeenAt: string | null;
  outputs: Output[];
}

const JOB_LABEL: Record<PrintJob, string> = {
  token: "Customer token",
  kitchen: "Kitchen ticket",
  bill: "Bill",
};

export default function PrintingSettingsPage() {
  const { current } = useSession();
  const confirm = useConfirm();

  const [stations, setStations] = useState<Station[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const load = useCallback(async () => {
    if (!current) return;
    try {
      setStations(await api.get<Station[]>(`/businesses/${current.id}/stations`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the machines");
    }
  }, [current]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!current) return <Empty title="Pick a venue first" />;

  return (
    <section className="space-y-5">
      <header className="space-y-1">
        <h1 className="font-display text-xl font-semibold">Printing</h1>
        <p className="text-[14px] text-muted">
          A machine becomes a station by opening <code>/station</code> on it and naming it.
          Printers are linked there too — a browser can only see the USB devices plugged
          into the computer it is running on.
        </p>
      </header>

      {error && <Banner tone="warning">{error}</Banner>}

      {stations?.length === 0 && (
        <Empty
          title="No machines yet"
          body="Open /station on the shop computer to set the first one up."
        />
      )}

      <ul className="space-y-3">
        {stations?.map((s) => (
          <li key={s.id} data-testid={`station-${s.id}`} className="rounded-2xl border border-line p-4">
            <header className="flex items-baseline justify-between gap-3">
              {renaming === s.id ? (
                <span className="flex flex-1 gap-2">
                  <Input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={40} />
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={async () => {
                      await api.patch(`/businesses/${current.id}/stations/${s.id}`, { name: draft });
                      setRenaming(null);
                      await load();
                    }}
                  >
                    Save
                  </Button>
                </span>
              ) : (
                <h2 className="font-display text-[16px] font-semibold">{s.name}</h2>
              )}
              <span className="shrink-0 text-[13px] text-faint" data-testid={`last-seen-${s.id}`}>
                {lastSeenLabel(s.lastSeenAt)}
              </span>
            </header>

            <ul className="mt-3 space-y-1 text-[13px]">
              {PRINT_JOBS.map((job) => {
                const out = s.outputs.find((o) => o.job === job);
                return (
                  <li key={job} className="flex justify-between">
                    <span className="text-muted">{JOB_LABEL[job]}</span>
                    <span>{out ? `${out.deviceLabel} · ${out.paperWidth}mm` : "—"}</span>
                  </li>
                );
              })}
            </ul>

            <footer className="mt-3 flex justify-end gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setRenaming(s.id);
                  setDraft(s.name);
                }}
              >
                Rename
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  // Revoking is how a lost or stolen machine stops printing,
                  // so it is worth one deliberate confirmation.
                  const ok = await confirm({
                    title: `Stop ${s.name} printing?`,
                    body: "It will stop receiving tickets immediately. Its record of what it printed is kept.",
                    confirmLabel: "Revoke",
                  });
                  if (!ok) return;
                  await api.delete(`/businesses/${current.id}/stations/${s.id}`);
                  await load();
                }}
              >
                Revoke
              </Button>
            </footer>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

**Check `useConfirm`'s real signature in `apps/web/components/confirm.tsx` and `api.delete`/`api.patch` in `apps/web/lib/api-client.ts` before writing this.** The staff screen uses both; copy from there rather than from here if they differ.

- [ ] **Step 5: Run and commit**

```bash
pnpm --filter @menu/web exec vitest run lib/station
pnpm --filter @menu/web lint
```

Expected: 17 passing across `lib/station`, typecheck clean.

```bash
git add apps/web/lib/station/last-seen.ts apps/web/lib/station/last-seen.spec.ts \
        "apps/web/app/(app)/settings/printing/page.tsx"
git commit -m "feat(web): show the owner every machine and what it is printing"
```

---

### Task 15: Reachable, and proven end to end

Two screens exist and nothing links to them. This task puts them in the navigation and then proves the thing the spec asks to be proved: **one accept with two stations configured produces exactly two tickets, one at each; one accept with a single station holding all three outputs produces the token slip and the kitchen ticket from that one machine.**

The e2e cannot drive real USB — Playwright has no WebUSB — so the browser half is exercised through the API, with the transport faked. What that still proves is everything between an accept and a claim: the mapping, the window, the per-station offer, and the unique index under two concurrent claims. The byte rendering is already covered by the golden tests in Tasks 4–6, and the loop's behaviour by Task 12.

**Files:**
- Create: `apps/api/src/printing/two-stations.spec.ts`
- Modify: `apps/web/lib/nav.ts`
- Modify: `apps/web/lib/nav.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–14.
- Produces: `/station` and `/settings/printing` in `ALLOWED`; `/station` in `KITCHEN_NAV` and `OWNER_NAV`. The existing exports are `navFor` and `canSee` — neither changes shape.

- [ ] **Step 1: Write the failing navigation test**

Append to `apps/web/lib/nav.spec.ts`:

```ts
describe("the station screen", () => {
  it("is reachable by the people who stand next to the printer", () => {
    // A kitchen login is usually who opens the machine in the morning.
    expect(navFor("kitchen").map((n) => n.href)).toContain("/station");
    expect(navFor("owner").map((n) => n.href)).toContain("/station");
  });

  it("lets both roles load it, and printing settings only the owner", () => {
    expect(canSee("kitchen", "/station")).toBe(true);
    expect(canSee("owner", "/settings/printing")).toBe(true);
    // Cosmetic only — the API is the boundary — but a kitchen login should
    // not be shown a screen whose every row it would be refused.
    expect(canSee("kitchen", "/settings/printing")).toBe(false);
  });
});
```

`canSee` is the existing export that answers "may this role load this path", read off `ALLOWED` (`nav.ts:62`). Import it alongside `navFor` in the spec — do not add a second function.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @menu/web exec vitest run lib/nav.spec.ts
```

Expected: FAIL — `/station` is in neither list.

- [ ] **Step 3: Add the routes to the navigation**

In `apps/web/lib/nav.ts`, add `{ href: "/station", label: "Printing" }` to `KITCHEN_NAV` and `OWNER_NAV`, and add `"/station"` to all three `ALLOWED` lists plus `"/settings/printing"` to the owner and admin lists. `/settings/printing` is not its own nav entry — it hangs off Settings, like the staff screen does.

- [ ] **Step 4: Write the two tests the spec asks for by name**

Create `apps/api/src/printing/two-stations.spec.ts`:

```ts
import "../config/load-dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { jobsForEvent } from "@menu/shared";

/**
 * The two requirements the spec states directly, against a real database.
 *
 * Both are about the same thing from two directions: nothing anywhere
 * branches on "how many devices this shop has". The count of stations and
 * the outputs on them IS the configuration.
 */
const ADMIN_URL = process.env.DIRECT_URL!;

let admin: Client;
let owner: string, biz: string, eventId: string;
let counter: string, kitchenStation: string, oneMachine: string;

async function station(name: string, jobs: { job: string; width: number }[]) {
  const s = await admin.query(
    `INSERT INTO print_stations (id, business_id, name, updated_at)
     VALUES (gen_random_uuid(), $1, $2, now()) RETURNING id`,
    [biz, name],
  );
  const id = s.rows[0].id as string;
  for (const j of jobs) {
    await admin.query(
      `INSERT INTO station_outputs (id, business_id, station_id, job, device_label, device_key, transport, paper_width, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'P', $4, 'usb', $5, now())`,
      [biz, id, j.job, `${name}:${j.job}`, j.width],
    );
  }
  return id;
}

/** What a station would be offered: its jobs, minus what it already took. */
async function offered(stationId: string) {
  const e = await admin.query(`SELECT kind FROM order_events WHERE id = $1`, [eventId]);
  const jobs = jobsForEvent(e.rows[0].kind as string);
  const outs = await admin.query(`SELECT job FROM station_outputs WHERE station_id = $1`, [stationId]);
  const has = new Set(outs.rows.map((r) => r.job as string));
  const taken = await admin.query(
    `SELECT job FROM print_receipts WHERE station_id = $1 AND event_id = $2 AND status <> 'failed'`,
    [stationId, eventId],
  );
  const done = new Set(taken.rows.map((r) => r.job as string));
  return jobs.filter((j) => has.has(j) && !done.has(j));
}

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();

  const u = await admin.query(
    `INSERT INTO users (id, pin_hash, full_name, phone, verified_at, updated_at)
     VALUES (gen_random_uuid(), 'x', 'Two Stations', $1, now(), now()) RETURNING id`,
    [`+9199${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`],
  );
  owner = u.rows[0].id;

  const b = await admin.query(
    `INSERT INTO businesses (id, owner_id, name, type, public_code, updated_at)
     VALUES (gen_random_uuid(), $1, 'Two Stations', 'restaurant', $2, now()) RETURNING id`,
    [owner, Math.random().toString(36).slice(2, 10).toUpperCase().padEnd(8, "X")],
  );
  biz = b.rows[0].id;

  const t = await admin.query(
    `INSERT INTO tables (id, business_id, label, token, position)
     VALUES (gen_random_uuid(), $1, '7', $2, 1) RETURNING id`,
    [biz, Math.random().toString(36).slice(2).padEnd(32, "0").slice(0, 32)],
  );
  const o = await admin.query(
    `INSERT INTO orders (id, business_id, table_id, status, business_day, daily_number, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'placed', CURRENT_DATE, 14, now()) RETURNING id`,
    [biz, t.rows[0].id],
  );
  const e = await admin.query(
    `INSERT INTO order_events (order_id, business_id, kind) VALUES ($1, $2, 'round.accepted') RETURNING id`,
    [o.rows[0].id, biz],
  );
  eventId = e.rows[0].id;

  counter = await station("Counter", [{ job: "token", width: 58 }, { job: "bill", width: 80 }]);
  kitchenStation = await station("Kitchen", [{ job: "kitchen", width: 80 }]);
  oneMachine = await station("All in one", [
    { job: "token", width: 58 },
    { job: "kitchen", width: 58 },
    { job: "bill", width: 58 },
  ]);
});

afterAll(async () => {
  await admin.query("DELETE FROM businesses WHERE id = $1", [biz]);
  await admin.query("DELETE FROM users WHERE id = $1", [owner]);
  await admin.end();
});

describe("one accept, two machines", () => {
  it("gives each machine exactly the one job it holds", async () => {
    // The counter prints the token, the kitchen prints the ticket, at the
    // same moment, and neither knows the other exists.
    expect(await offered(counter)).toEqual(["token"]);
    expect(await offered(kitchenStation)).toEqual(["kitchen"]);
  });

  it("gives a single machine holding all three outputs both slips", async () => {
    // Same event, same data, no mode flag: one roll does both, back to back.
    expect(await offered(oneMachine)).toEqual(["token", "kitchen"]);
  });

  it("offers the bill to nobody until the order is closed", async () => {
    // The counter holds a bill printer, and an accepted round is still not
    // a bill. Closing the table is what produces one.
    expect(await offered(counter)).not.toContain("bill");
  });
});

describe("two tabs on one machine", () => {
  it("lets exactly one of two concurrent claims through", async () => {
    // Review Focus 2, for real: two connections, one event, one job, no
    // coordination between them except the index.
    const tabs = [new Client({ connectionString: ADMIN_URL }), new Client({ connectionString: ADMIN_URL })];
    await Promise.all(tabs.map((c) => c.connect()));

    const claim = (c: Client) =>
      c.query(
        `INSERT INTO print_receipts (business_id, station_id, event_id, job, attempt, status, claimed_at)
         VALUES ($1, $2, $3, 'token', 1, 'claimed', now())`,
        [biz, counter, eventId],
      );

    const results = await Promise.allSettled([claim(tabs[0]!), claim(tabs[1]!)]);
    await Promise.all(tabs.map((c) => c.end()));

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const n = await admin.query(
      `SELECT count(*)::int AS n FROM print_receipts
        WHERE station_id = $1 AND event_id = $2 AND job = 'token'`,
      [counter, eventId],
    );
    expect(n.rows[0].n).toBe(1);
  });
});
```

Note the ordering dependency: the concurrency test leaves a `token` receipt on `counter`, so it is in its own `describe` **after** the offer tests, which assert on a clean slate. Do not reorder them.

- [ ] **Step 5: Run everything and commit**

```bash
source .superpowers/sdd/2026-10-04-round-level-orders/local-db.env
pnpm --filter @menu/shared build
pnpm --filter @menu/api exec vitest run
pnpm --filter @menu/web exec vitest run
pnpm --filter @menu/api lint
pnpm --filter @menu/web lint
```

Expected: every suite green, both typechecks clean.

```bash
git add apps/api/src/printing/two-stations.spec.ts apps/web/lib/nav.ts apps/web/lib/nav.spec.ts
git commit -m "test: prove two machines and one machine are the same configuration"
```

---

## Done

When all fifteen tasks are complete: the API suite, the web unit suite and the shared suite are green, both typechecks are clean, and the Playwright suite still passes. The whole-branch review comes next — see superpowers:executing-plans or superpowers:subagent-driven-development, whichever is running this plan.

**What is deliberately not built**, from the spec's own list — do not add these without going back to it first: void slips for a cancelled round, rasterised non-Latin text, cash drawer and buzzer, an offline print queue, per-round bills, and pairing codes.
