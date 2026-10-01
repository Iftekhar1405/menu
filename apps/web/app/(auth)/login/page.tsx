"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiError, api, setAccessToken } from "@/lib/api-client";
import { guessCountryClient } from "@/lib/country";
import { IdentifierField } from "@/components/identifier-field";
import { PinInput } from "@/components/pin-input";
import { Banner, Button } from "@/components/ui";
import { ThemeToggle } from "@/components/theme-toggle";
import { useEffect } from "react";

export default function LoginPage() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [country, setCountry] = useState("IN");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setCountry(guessCountryClient()), []);

  async function submit(pinValue = pin) {
    if (identifier.trim().length === 0) {
      setError("Enter the email or phone number you signed up with.");
      return;
    }
    if (pinValue.length !== 6) return;

    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ accessToken: string }>("/auth/login", {
        identifier,
        pin: pinValue,
        country,
      });
      setAccessToken(res.accessToken);
      router.push("/dashboard");
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not sign in. Try again.",
      );
      setPin("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1 className="text-[28px] font-semibold leading-tight tracking-tight">Sign in</h1>
      <p className="mt-1.5 text-[14.5px] text-muted">
        Use the email or phone number on your account.
      </p>

      <form
        className="mt-8 space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {error && <Banner>{error}</Banner>}

        <IdentifierField
          value={identifier}
          onChange={setIdentifier}
          country={country}
          onCountryChange={setCountry}
          autoFocus
        />

        <PinInput
          label="6-digit PIN"
          value={pin}
          onChange={setPin}
          onComplete={(v) => void submit(v)}
          disabled={busy}
        />

        <Button type="submit" variant="primary" loading={busy} className="w-full">
          Sign in
        </Button>
      </form>

      <div className="mt-6 flex items-center justify-between text-[13.5px]">
        <Link href="/forgot-pin" className="text-muted hover:text-ink">
          Forgot your PIN?
        </Link>
        <Link href="/signup" className="font-medium text-[var(--accent)] hover:underline">
          Create an account
        </Link>
      </div>

      <div className="mt-8 border-t border-line pt-5">
        <ThemeToggle />
      </div>
    </div>
  );
}
