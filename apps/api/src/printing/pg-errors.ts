import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { cleanPgMessage } from "../common/pg-message";

/**
 * Turns a SECURITY DEFINER function's RAISE EXCEPTION into an HTTP status,
 * the same precedent as `place_table_round`'s own catch
 * (orders.service.ts:88-103). `create_print_station`, `attach_station_output`
 * and `claim_print_receipt` all re-check the caller themselves — RLS is not
 * going to — and raise exactly these messages by hand:
 *
 *  - "not your business": the caller has no access to this business at all.
 *  - "no such station": an existence check inside the function. Reachable,
 *    not theoretical — an owner can revoke a station in the window between a
 *    service's own lookup and the call reaching Postgres.
 *  - "no such event": `claim_print_receipt`'s own existence check, same
 *    reasoning — an order can be deleted in that same window.
 *
 * Anything else that looks like a RAISE EXCEPTION becomes a 400 with the
 * message cleaned up for a person, same as every other SQL-raised error in
 * this API. Without this, a function's own guard arrives as raw Postgres
 * text and Nest answers 500.
 *
 * `claim()` in receipts.service.ts has one error this function must never
 * see first: the `print_receipts_claim_key` unique violation, which means
 * "someone else took it" and has to become a 409, not a 400. That check
 * runs ahead of this one and is never folded in here — see the comment at
 * its call site for why the ordering is load-bearing.
 */
export function translatePgError(err: unknown): never {
  const message = err instanceof Error ? err.message : "";
  if (/not your business/.test(message)) {
    throw new ForbiddenException("Not your business");
  }
  if (/no such station/.test(message)) {
    throw new NotFoundException("Station not found");
  }
  if (/no such event/.test(message)) {
    throw new NotFoundException("Event not found");
  }
  const match = /ERROR: (.+)/.exec(message);
  if (match) throw new BadRequestException(cleanPgMessage(match[1]!));
  throw err instanceof Error ? err : new Error(message);
}

/** Runs a SECURITY DEFINER call, translating whatever it raises. */
export async function fromFunction<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    translatePgError(err);
  }
}
