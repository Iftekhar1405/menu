"use client";

import { useMemo } from "react";
import { COUNTRIES, findCountry, looksLikePhone } from "@/lib/country";
import { Field, Input, cx } from "./ui";

/**
 * One field for both an email and a phone number.
 *
 * Making the owner choose a tab first is a decision they should not have to
 * make — they know what they want to type. The country selector appears only
 * once the value starts looking like a phone number, so an email signup never
 * sees it, and it is preselected from where the visitor actually is.
 */
export function IdentifierField({
  value,
  onChange,
  country,
  onCountryChange,
  error,
  label = "Email or phone number",
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  country: string;
  onCountryChange: (c: string) => void;
  error?: string;
  label?: string;
  autoFocus?: boolean;
}) {
  const isPhone = useMemo(() => looksLikePhone(value), [value]);
  const selected = findCountry(country);

  return (
    <Field
      label={label}
      error={error}
      hint={
        !error && isPhone
          ? "We'll send your code on WhatsApp."
          : !error
            ? "Either works. You'll sign in with whichever you use here."
            : undefined
      }
    >
      <div
        className={cx(
          "spring flex h-11 items-stretch overflow-hidden rounded-xl border bg-surface",
          error ? "border-[#E5A9A4]" : "border-line focus-within:border-[var(--accent)]",
        )}
      >
        {isPhone && (
          <div className="relative flex items-center border-r border-line pl-3 pr-1">
            <span className="pointer-events-none mr-1 text-[15px]" aria-hidden="true">
              {selected.flag}
            </span>
            <span className="tnum pointer-events-none text-[14px] text-muted">
              {selected.dial}
            </span>
            <select
              aria-label="Country code"
              value={country}
              onChange={(e) => onCountryChange(e.target.value)}
              className="absolute inset-0 cursor-pointer opacity-0"
            >
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.flag} {c.name} {c.dial}
                </option>
              ))}
            </select>
            <svg className="ml-1 h-3 w-3 text-faint" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
        )}
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoFocus={autoFocus}
          autoComplete="username"
          inputMode={isPhone ? "tel" : "email"}
          placeholder={isPhone ? "98765 43210" : "you@restaurant.com"}
          className="h-full flex-1 border-0 focus:border-0"
        />
      </div>
    </Field>
  );
}
