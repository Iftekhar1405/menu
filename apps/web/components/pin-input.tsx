"use client";

import { useRef, useState, useEffect } from "react";
import { cx } from "./ui";

/**
 * Six separate boxes rather than one masked field.
 *
 * The PIN is the whole credential here, and it gets typed on a phone at a
 * counter, often in a hurry. Separate boxes make progress visible, make a
 * mistyped digit obvious, and let the numeric keypad open by default. Paste
 * is handled because people do paste codes out of WhatsApp.
 */
export function PinInput({
  value,
  onChange,
  onComplete,
  label,
  autoFocus,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onComplete?: (v: string) => void;
  label: string;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const [focused, setFocused] = useState<number | null>(null);

  useEffect(() => {
    if (autoFocus) refs.current[0]?.focus();
  }, [autoFocus]);

  const setDigit = (index: number, digit: string) => {
    const next = value.split("");
    next[index] = digit;
    const joined = next.join("").slice(0, 6);
    onChange(joined);
    if (digit && index < 5) refs.current[index + 1]?.focus();
    if (joined.length === 6 && !joined.includes("") && onComplete) onComplete(joined);
  };

  const onKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !value[index] && index > 0) {
      refs.current[index - 1]?.focus();
    }
    if (e.key === "ArrowLeft" && index > 0) refs.current[index - 1]?.focus();
    if (e.key === "ArrowRight" && index < 5) refs.current[index + 1]?.focus();
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const digits = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (!digits) return;
    e.preventDefault();
    onChange(digits);
    if (digits.length === 6 && onComplete) onComplete(digits);
    refs.current[Math.min(digits.length, 5)]?.focus();
  };

  return (
    <div>
      <span className="mb-1.5 block text-[13px] font-medium text-ink">{label}</span>
      <div className="flex gap-2" onPaste={onPaste}>
        {Array.from({ length: 6 }).map((_, i) => (
          <input
            key={i}
            ref={(el) => {
              refs.current[i] = el;
            }}
            inputMode="numeric"
            autoComplete={i === 0 ? "one-time-code" : "off"}
            pattern="\d*"
            maxLength={1}
            disabled={disabled}
            aria-label={`${label}, digit ${i + 1} of 6`}
            value={value[i] ?? ""}
            onFocus={() => setFocused(i)}
            onBlur={() => setFocused(null)}
            onChange={(e) => setDigit(i, e.target.value.replace(/\D/g, "").slice(-1))}
            onKeyDown={(e) => onKeyDown(i, e)}
            className={cx(
              "tnum spring h-[52px] w-full min-w-0 rounded-xl border bg-surface text-center",
              "text-[20px] font-semibold text-ink caret-transparent",
              focused === i
                ? "border-[var(--accent)] ring-2 ring-[var(--accent-soft)]"
                : value[i]
                  ? "border-[#c9ced6]"
                  : "border-line",
            )}
          />
        ))}
      </div>
    </div>
  );
}
