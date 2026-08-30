"use client";

import { forwardRef } from "react";

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
    "spring inline-flex items-center justify-center gap-2 rounded-xl font-medium select-none disabled:opacity-45 disabled:pointer-events-none";
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

/* ── Field + Input ─────────────────────────────────────────────────────── */

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
          "spring h-11 w-full rounded-xl border border-line bg-surface px-3 text-[15px] text-ink",
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
        "spring w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-[15px] text-ink",
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
        "spring h-11 w-full appearance-none rounded-xl border border-line bg-surface px-3 text-[15px] text-ink",
        "hover:border-[#d6d9de] focus:border-[var(--accent)]",
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
});

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
