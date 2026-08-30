/**
 * One source for the mark and the wordmark.
 *
 * Deliberately importing nothing: this renders inside server components (the
 * signup layout, the public menu footer) as well as client ones, and pulling
 * in a helper from a "use client" module would make it unusable from the
 * server half.
 *
 * They appeared in four places with the SVG pasted into each, which is exactly
 * how a logo ends up subtly different depending on which screen you are
 * looking at. Everything brand-shaped now comes from here.
 */

/**
 * The tile takes `currentColor` so the mark inherits whatever text colour it
 * sits in — ink in the sidebar, muted in a footer — while the pattern inside
 * stays white and keeps its contrast either way.
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
 * Mark plus name. `full` decides whether the domain is spelled out — the
 * sidebar has 232px to work with and says "menu.irad", the signup screen has
 * room and says the whole address, which is what someone types to come back.
 *
 * "menu" carries the contrast and the rest steps back, so the name reads at a
 * glance while the address stays available to anyone looking for it.
 */
export function Wordmark({
  full = false,
  size = 20,
  className,
}: {
  full?: boolean;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={["inline-flex items-center gap-2 text-ink", className]
        .filter(Boolean)
        .join(" ")}
    >
      <Mark size={size} />
      <span
        className="font-display font-semibold tracking-tight"
        style={{ fontSize: size * 0.72 }}
      >
        menu
        <span className="text-faint">{full ? ".irad.solutions" : ".irad"}</span>
      </span>
    </span>
  );
}
