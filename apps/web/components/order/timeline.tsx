import { formatClock, formatGap, type TimelineStep } from "@/lib/order-timeline";
import { cx } from "../ui";

/**
 * One order's history as a vertical rail.
 *
 * One component for both screens rather than two that look alike. The diner's
 * tree is themed per business through --menu-* variables and the owner's uses
 * the product's own achromatic tokens, so the difference is a palette, not a
 * layout — and two near-identical steppers drifting apart is the predictable
 * way this ends up inconsistent.
 */
const TONES = {
  diner: {
    ink: "text-[color:var(--menu-ink)]",
    muted: "text-[color:var(--menu-muted)]",
    rail: "bg-[color:var(--menu-line)]",
    dot: "bg-[color:var(--accent-strong)]",
    hollow: "border-[color:var(--menu-line)]",
  },
  staff: {
    ink: "text-ink",
    muted: "text-faint",
    rail: "bg-line",
    dot: "bg-[color:var(--accent)]",
    hollow: "border-line",
  },
} as const;

export function OrderTimeline({
  steps,
  tone,
  showGaps = false,
}: {
  steps: TimelineStep[];
  tone: keyof typeof TONES;
  /** How long the previous stage took. Useful to an owner, noise to a diner. */
  showGaps?: boolean;
}) {
  if (steps.length === 0) return null;
  const t = TONES[tone];

  return (
    <ol className="relative">
      {steps.map((step, i) => {
        const last = i === steps.length - 1;
        const upcoming = step.state === "upcoming";

        return (
          <li key={step.key} className="relative flex gap-3 pb-3.5 last:pb-0">
            {/* The rail is drawn per row rather than as one absolute line so
                it stops at the last dot instead of running past it. */}
            {!last && (
              <span
                aria-hidden
                className={cx("absolute left-[3.5px] top-3 h-full w-px", t.rail)}
              />
            )}

            <span
              aria-hidden
              className={cx(
                "relative mt-[5px] h-2 w-2 shrink-0 rounded-full",
                upcoming ? cx("border bg-transparent", t.hollow) : t.dot,
                // The current stage gets a halo rather than a bigger dot, so
                // the rail's spacing stays even down the column.
                step.state === "current" &&
                  "ring-4 ring-[color:currentColor] ring-opacity-10",
              )}
            />

            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span
                  className={cx(
                    "text-[13.5px]",
                    upcoming ? t.muted : t.ink,
                    step.state === "current" && "font-semibold",
                  )}
                >
                  {step.label}
                </span>

                {step.at && (
                  <time
                    dateTime={step.at}
                    className={cx("tnum text-[12.5px]", t.muted)}
                  >
                    {formatClock(step.at)}
                  </time>
                )}

                {showGaps && step.sincePreviousMs !== null && (
                  <span className={cx("tnum text-[12.5px]", t.muted)}>
                    {formatGap(step.sincePreviousMs)}
                  </span>
                )}
              </span>

              {step.detail && (
                <span className={cx("block text-[12.5px]", t.muted)}>
                  {step.detail}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
