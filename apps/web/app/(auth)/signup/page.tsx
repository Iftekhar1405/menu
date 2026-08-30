"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { BUSINESS_TYPES, BUSINESS_TYPE_LABEL } from "@menu/shared";
import { ApiError, api, setAccessToken } from "@/lib/api-client";
import { guessCountryClient } from "@/lib/country";
import { IdentifierField } from "@/components/identifier-field";
import { PinInput } from "@/components/pin-input";
import { Banner, Button, Field, Input, cx } from "@/components/ui";

export default function SignupPage() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [country, setCountry] = useState("IN");
  const [pin, setPin] = useState("");
  const [fullName, setFullName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [businessType, setBusinessType] = useState<(typeof BUSINESS_TYPES)[number]>("restaurant");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => setCountry(guessCountryClient()), []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const res = await api.post<{ accessToken: string }>("/auth/signup", {
        identifier,
        pin,
        fullName,
        businessName,
        businessType,
        country,
      });
      setAccessToken(res.accessToken);
      router.push("/menu");
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.fieldErrors ?? {});
      } else {
        setError("Could not create the account. Try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1 className="text-[28px] font-semibold leading-tight tracking-tight">
        Put your menu online
      </h1>
      <p className="mt-1.5 text-[14.5px] text-muted">
        Takes about five minutes. You'll get a QR code to print at the end.
      </p>

      <form className="mt-8 space-y-5" onSubmit={submit}>
        {error && <Banner>{error}</Banner>}

        <Field label="Your name" error={fieldErrors.fullName}>
          <Input
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            autoComplete="name"
            placeholder="Asha Rao"
            required
          />
        </Field>

        <IdentifierField
          value={identifier}
          onChange={setIdentifier}
          country={country}
          onCountryChange={setCountry}
          error={fieldErrors.identifier}
        />

        <div>
          <PinInput
            label="Choose a 6-digit PIN"
            value={pin}
            onChange={setPin}
            disabled={busy}
          />
          <p className="mt-1.5 text-[12.5px] text-faint">
            This is how you'll sign in. Avoid a birth year or 123456.
          </p>
        </div>

        <Field label="Business name" error={fieldErrors.businessName}>
          <Input
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            placeholder="Kumar Coffee House"
            required
          />
        </Field>

        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium text-ink">
            What kind of place is it?
          </legend>
          <div className="grid grid-cols-3 gap-2">
            {BUSINESS_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setBusinessType(t)}
                aria-pressed={businessType === t}
                className={cx(
                  "spring h-11 rounded-xl border text-[13.5px] font-medium",
                  businessType === t
                    ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-strong)]"
                    : "border-line bg-surface text-muted hover:border-[#d6d9de]",
                )}
              >
                {BUSINESS_TYPE_LABEL[t]}
              </button>
            ))}
          </div>
        </fieldset>

        <Button type="submit" variant="primary" loading={busy} className="w-full">
          Create account
        </Button>
      </form>

      <p className="mt-6 text-[13.5px] text-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-[var(--accent)] hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
