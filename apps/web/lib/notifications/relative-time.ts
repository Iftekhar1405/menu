/**
 * How old a notification is, in the terms a kitchen thinks in.
 *
 * "4 min" answers the only question anyone asks of an order card — is this
 * late? A wall-clock time makes the reader do the subtraction themselves,
 * while holding a pan.
 */
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";

  // Clamped at zero: a tablet's clock a few seconds ahead of the server is
  // routine, and "-1 min" reads as a bug in the order rather than the clock.
  const elapsed = Math.max(0, now - then);

  if (elapsed < 30 * SECOND) return "Just now";
  // Always rounded down, so nothing is ever shown as older than it is.
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} hr`;
  return `${Math.floor(elapsed / DAY)} d`;
}
