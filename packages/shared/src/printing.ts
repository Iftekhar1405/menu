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
