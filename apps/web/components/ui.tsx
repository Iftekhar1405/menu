"use client";

import { forwardRef, useEffect, useSyncExternalStore } from "react";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/* ── Button ────────────────────────────────────────────────────────────────
 * Three intents only. Everything that is not the single primary action on a
 * screen is quiet, so the primary one does not have to shout to be found.
 * Every variant clears 44px of height at default size.
 */
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "md" | "sm";
  loading?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, className, children, disabled, ...rest },
  ref,
) {
  const base =
    "spring inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl font-medium select-none disabled:opacity-45 disabled:pointer-events-none";
  const sizes = {
    md: "h-11 px-4 text-[15px]",
    sm: "h-9 px-3 text-[13px]",
  };
  const variants = {
    primary:
      "bg-[var(--accent)] text-white hover:bg-[var(--accent-strong)] active:scale-[0.985]",
    secondary:
      "bg-surface text-ink border border-line hover:bg-raised active:scale-[0.985]",
    ghost: "text-muted hover:text-ink hover:bg-[rgba(17,17,19,0.04)]",
    danger:
      "bg-surface text-[#B3261E] border border-[#F0D5D3] hover:bg-[#FDF3F2] active:scale-[0.985]",
  };

  return (
    <button
      ref={ref}
      className={cx(base, sizes[size], variants[variant], className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
});

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M8 1.5A6.5 6.5 0 0 1 14.5 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/* ── Field + Input ───────────────────────────────────────────────────────
 * Every field is 16px on a phone and 15px from `sm:` up. That is not a
 * typographic preference: iOS Safari zooms the whole viewport when a field
 * smaller than 16px takes focus, and the page never zooms back out. The
 * denser 15px returns at a width where no browser does that.
 */

export function Field({
  label,
  hint,
  error,
  optional,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[13px] font-medium text-ink">{label}</span>
        {optional && <span className="text-[12px] text-faint">Optional</span>}
      </span>
      {children}
      {error ? (
        <span className="mt-1.5 block text-[12.5px] text-[#B3261E]">{error}</span>
      ) : hint ? (
        <span className="mt-1.5 block text-[12.5px] text-faint">{hint}</span>
      ) : null}
    </label>
  );
}

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={cx(
          "spring h-11 w-full rounded-xl border border-line bg-surface px-3 text-[16px] text-ink sm:text-[15px]",
          "placeholder:text-faint hover:border-[#d6d9de] focus:border-[var(--accent)]",
          className,
        )}
        {...rest}
      />
    );
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      className={cx(
        "spring w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-[16px] text-ink sm:text-[15px]",
        "placeholder:text-faint hover:border-[#d6d9de] focus:border-[var(--accent)]",
        className,
      )}
      {...rest}
    />
  );
});

export const Select = forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, children, ...rest }, ref) {
  return (
    <select
      ref={ref}
      className={cx(
        "spring h-11 w-full appearance-none rounded-xl border border-line bg-surface px-3 text-[16px] text-ink sm:text-[15px]",
        "hover:border-[#d6d9de] focus:border-[var(--accent)]",
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
});

/**
 * A setting that is on or off.
 *
 * The switch is 24px tall; the row around it carries the 44px, because on a
 * phone the thing people aim at is the label, not the pill.
 */
export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="-my-2 flex min-h-[44px] w-full items-center gap-3 py-2 text-left"
      >
        <span
          className={cx(
            "spring flex h-6 w-10 shrink-0 items-center rounded-full px-0.5",
            checked ? "bg-[var(--accent)]" : "bg-line",
          )}
        >
          <span
            className={cx(
              "spring h-5 w-5 rounded-full bg-white shadow-card",
              checked && "translate-x-4",
            )}
          />
        </span>
        <span className="text-[14.5px] font-medium text-ink">{label}</span>
      </button>
      {hint && <p className="ml-[52px] mt-1 text-[12.5px] leading-relaxed text-faint">{hint}</p>}
    </div>
  );
}

/* ── Feedback ──────────────────────────────────────────────────────────── */

export function Banner({
  tone = "error",
  children,
}: {
  tone?: "error" | "info";
  children: React.ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cx(
        "rounded-xl px-3.5 py-3 text-[13.5px] leading-relaxed",
        tone === "error"
          ? "bg-[#FDF3F2] text-[#8C1D18] border border-[#F0D5D3]"
          : "bg-[var(--accent-soft)] text-[var(--accent-strong)]",
      )}
    >
      {children}
    </div>
  );
}

/**
 * Empty states are an invitation to act, not an apology. Every one of these
 * names the next step rather than reporting that a list is empty.
 */
export function Empty({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-line bg-surface px-6 py-12 text-center">
      <h3 className="font-display text-[17px] font-semibold text-ink">{title}</h3>
      <p className="mx-auto mt-1.5 max-w-sm text-[14px] leading-relaxed text-muted">{body}</p>
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}

/* ── Segmented ─────────────────────────────────────────────────────────────
 * One choice out of three or four, shown as a single control rather than a
 * row of buttons. It exists because a phone cannot show the order board's
 * three columns side by side, and stacking them buries Ready under all of
 * Preparing — the thing staff are most often reaching for.
 *
 * A real tablist: arrow keys move between tabs and only the selected tab is
 * in the tab order, which is what a screen reader user expects from
 * something that looks like this.
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string; badge?: React.ReactNode }[];
  value: T;
  onChange: (value: T) => void;
}) {
  function onKeyDown(e: React.KeyboardEvent) {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const i = options.findIndex((o) => o.value === value);
    const next = options[(i + delta + options.length) % options.length]!;
    onChange(next.value);
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="flex gap-1 rounded-xl bg-[rgba(17,17,19,0.05)] p-1"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            role="tab"
            type="button"
            id={`seg-${option.value}`}
            aria-selected={active}
            aria-controls={`segpanel-${option.value}`}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={cx(
              "spring flex h-9 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 text-[13.5px] font-medium",
              active
                ? "bg-surface text-ink shadow-card"
                : "text-muted hover:text-ink",
            )}
          >
            <span className="truncate">{option.label}</span>
            {option.badge != null && (
              <span className={cx("tnum text-[12.5px]", active ? "text-muted" : "text-faint")}>
                {option.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ── Sheet ─────────────────────────────────────────────────────────────────
 * A panel over the page. It arrives from the bottom edge and fills the phone;
 * from `sm:` up it becomes whatever the surrounding layout already wanted —
 * a side panel for the dish editor, a centred card for a confirmation.
 *
 * Bottom, rather than the side, because a phone held one-handed has its
 * dismiss gesture and its thumb at the bottom of the screen.
 */
export function Sheet({
  label,
  onClose,
  side = "bottom",
  children,
  className,
}: {
  label: string;
  onClose: () => void;
  /** `side` slides in from the right on a tablet and up; `bottom` stays full-screen. */
  side?: "bottom" | "side";
  children: React.ReactNode;
  className?: string;
}) {
  useEscape(onClose);
  useScrollLock();

  return (
    <div
      className={cx(
        "fixed inset-0 z-40 flex",
        side === "side"
          ? "items-start sm:items-stretch sm:justify-end"
          : "items-end sm:items-center sm:justify-center",
      )}
    >
      {/* Presentational: closing is already offered by the sheet's own Done
          button and by Escape, and a second announced "Close" here would only
          be noise. */}
      <div
        aria-hidden="true"
        onClick={onClose}
        className="animate-fade-in absolute inset-0 bg-[rgba(17,17,19,0.32)]"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={cx(
          "animate-sheet-up overscroll-contain-y relative flex w-full flex-col bg-surface shadow-lift",
          side === "side"
            ? "h-[92dvh] rounded-b-[20px] sm:h-full sm:max-h-full sm:max-w-[460px] sm:rounded-none"
            : "max-h-[92dvh] rounded-t-[20px] sm:max-h-[86dvh] sm:max-w-[520px] sm:rounded-2xl",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The grab handle at the top of a bottom sheet. Decorative — it is the visual
 * cue that the sheet is dismissable, and it is hidden once the sheet stops
 * being a sheet.
 */
export function SheetGrabber() {
  return (
    <div aria-hidden="true" className="flex justify-center pt-2 sm:hidden">
      <div className="h-1 w-9 rounded-full bg-[rgba(17,17,19,0.16)]" />
    </div>
  );
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}

/**
 * While a sheet is up the page behind it must not scroll. Without this, a
 * flick that starts on the sheet's own scroll edge drags the dashboard
 * underneath instead, and the sheet appears to come unstuck.
 */
function useScrollLock() {
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);
}

/**
 * Whether the viewport is narrower than Tailwind's `sm` breakpoint.
 *
 * For ARIA, not for layout. Layout stays in CSS, where a media query costs
 * nothing and cannot flash: a component that decides its own shape in
 * JavaScript renders the wrong one until hydration catches up, which on a
 * phone is a visible jump.
 *
 * Some semantics cannot be expressed that way, though. The order board's
 * three columns are one-at-a-time behind a segmented control on a phone and
 * side by side above it — so below `sm` a column genuinely is a tab panel,
 * and above it, where the control is hidden and all three are on screen, it
 * genuinely is not. Marking one of three visible columns as a panel of a
 * tablist nobody can see is worse than marking none.
 *
 * `useSyncExternalStore` rather than an effect, so the server snapshot is
 * explicit. Flipping an attribute after hydration moves nothing on screen.
 */
export function useIsNarrow(): boolean {
  return useSyncExternalStore(subscribeToNarrow, isNarrowNow, () => false);
}

const NARROW = "(max-width: 639.98px)";

function subscribeToNarrow(onChange: () => void): () => void {
  const query = window.matchMedia(NARROW);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function isNarrowNow(): boolean {
  return window.matchMedia(NARROW).matches;
}
