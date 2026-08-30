/**
 * Turns a Postgres RAISE EXCEPTION message into something a diner can read.
 *
 * Our SQL functions raise messages written for humans ("Choose a size for
 * Latte"), but Prisma appends the failing statement wrapped in backticks and
 * a stack of driver context. Only the first line, minus that trailing noise,
 * is meant for the person holding the phone.
 */
export function cleanPgMessage(raw: string): string {
  return raw
    .split("\n")[0]!
    .replace(/[`\s]+$/, "")
    .trim();
}
