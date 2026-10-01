/**
 * One source for the mark and the wordmark.
 *
 * Deliberately importing nothing: this renders inside server components (the
 * signup layout, the public menu footer) as well as client ones, and pulling
 * in a helper from a "use client" module would make it unusable from the
 * server half.
 */

/**
 * The tile uses `currentColor` so it can be styled from the outside.
 * Pass className="text-[var(--accent)]" for the branded accent colour,
 * or let it inherit from context.
 */
export function Mark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      className={["shrink-0", className].filter(Boolean).join(" ")}
    >
      <rect width="32" height="32" rx="8" fill="currentColor" />
      <rect
        x="6.25"
        y="6.25"
        width="12.5"
        height="12.5"
        rx="3.75"
        fill="none"
        stroke="#fff"
        strokeWidth="2.5"
      />
      <rect x="10.5" y="10.5" width="4" height="4" rx="1.25" fill="#fff" />
      <rect x="20.5" y="20.5" width="6" height="6" rx="2" fill="#fff" />
      <rect x="21" y="12" width="3.25" height="3.25" rx="1" fill="#fff" opacity="0.5" />
      <rect x="12" y="21" width="3.25" height="3.25" rx="1" fill="#fff" opacity="0.5" />
    </svg>
  );
}

/**
 * Mark plus name. `full` decides whether the domain is spelled out.
 * The mark is always rendered in the accent colour so it is visible in
 * both light and dark mode (avoids going all-white on dark backgrounds).
 */
export function Wordmark({
  full = false,
  size = 20,
  className,
  markClassName,
}: {
  full?: boolean;
  size?: number;
  className?: string;
  /** Use a fixed colour where the product mark must ignore UI theme changes. */
  markClassName?: string;
}) {
  return (
    <span
      className={["inline-flex items-center gap-2", className]
        .filter(Boolean)
        .join(" ")}
    >
      <Mark size={size} className={markClassName ?? "text-[var(--accent)]"} />
      <span
        className="font-display font-semibold tracking-tight text-ink"
        style={{ fontSize: size * 0.72 }}
      >
        menu
        <span className="text-faint">{full ? ".irad.solutions" : ".irad"}</span>
      </span>
    </span>
  );
}
