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
