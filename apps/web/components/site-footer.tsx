import { Mark } from "./brand";

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
        <Mark size={12} />
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
