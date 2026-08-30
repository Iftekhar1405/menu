/**
 * The credit line on every diner-facing surface.
 *
 * Two jobs, and they pull in opposite directions: a diner should be able to
 * find out who built the thing they just used, and should not be distracted
 * from the restaurant's menu by our name. So it sits quietly at the foot, in
 * muted type, below everything else — but it is a real link rather than
 * decorative text, because a credit nobody can follow is not a credit.
 */
export function SiteFooter({ tone = "menu" }: { tone?: "menu" | "app" }) {
  const muted =
    tone === "menu" ? "text-[color:var(--menu-muted)]" : "text-faint";

  return (
    <footer className="px-5 pb-10 pt-8 text-center">
      <a
        href="https://irad.solutions"
        target="_blank"
        rel="noopener noreferrer"
        className={`spring inline-flex items-center gap-1.5 text-[11.5px] ${muted} opacity-70 hover:opacity-100`}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 32 32"
          aria-hidden="true"
          className="shrink-0"
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
        </svg>
        <span>
          Menu by <span className="font-medium">menu.irad.solutions</span>
        </span>
      </a>
      <p className={`mt-1.5 text-[10.5px] ${muted} opacity-55`}>
        A product of{" "}
        <a
          href="https://irad.solutions"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:opacity-100"
        >
          irad.solutions
        </a>
      </p>
    </footer>
  );
}
