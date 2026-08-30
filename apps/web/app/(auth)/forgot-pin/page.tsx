"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api-client";
import { guessCountryClient, looksLikePhone } from "@/lib/country";
import { IdentifierField } from "@/components/identifier-field";
import { PinInput } from "@/components/pin-input";
import { Banner, Button } from "@/components/ui";

type Step = "identify" | "code";

export default function ForgotPinPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("identify");
  const [identifier, setIdentifier] = useState("");
  const [country, setCountry] = useState("IN");
  const [code, setCode] = useState("");
  const [newPin, setNewPin] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setCountry(guessCountryClient()), []);

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ sentTo: string | null }>("/auth/otp/request", {
        identifier,
        purpose: "recover",
        country,
      });
      setSentTo(res.sentTo);
      setStep("code");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send a code.");
    } finally {
      setBusy(false);
    }
  }

  async function resetPin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/pin/reset", { identifier, code, newPin, country });
      router.push("/login?reset=1");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reset your PIN.");
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  if (step === "identify") {
    return (
      <div>
        <h1 className="text-[28px] font-semibold leading-tight tracking-tight">
          Reset your PIN
        </h1>
        <p className="mt-1.5 text-[14.5px] text-muted">
          We'll send a code to every contact on your account.
        </p>

        <form className="mt-8 space-y-5" onSubmit={requestCode}>
          {error && <Banner>{error}</Banner>}
          <IdentifierField
            value={identifier}
            onChange={setIdentifier}
            country={country}
            onCountryChange={setCountry}
            autoFocus
          />
          <Button type="submit" variant="primary" loading={busy} className="w-full">
            Send code
          </Button>
        </form>

        <p className="mt-6 text-[13.5px]">
          <Link href="/login" className="text-muted hover:text-ink">
            Back to sign in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-[28px] font-semibold leading-tight tracking-tight">
        Enter your code
      </h1>
      <p className="mt-1.5 text-[14.5px] text-muted">
        {sentTo ? (
          <>
            Sent to <span className="text-ink">{sentTo}</span>
            {looksLikePhone(identifier) ? " on WhatsApp." : "."} It expires in 10 minutes.
          </>
        ) : (
          "It expires in 10 minutes."
        )}
      </p>

      <form className="mt-8 space-y-5" onSubmit={resetPin}>
        {error && <Banner>{error}</Banner>}

        <PinInput label="6-digit code" value={code} onChange={setCode} autoFocus disabled={busy} />
        <PinInput label="New 6-digit PIN" value={newPin} onChange={setNewPin} disabled={busy} />

        <Button
          type="submit"
          variant="primary"
          loading={busy}
          className="w-full"
          disabled={code.length !== 6 || newPin.length !== 6}
        >
          Set new PIN
        </Button>
      </form>

      <button
        onClick={() => {
          setStep("identify");
          setCode("");
          setError(null);
        }}
        className="mt-6 text-[13.5px] text-muted hover:text-ink"
      >
        Didn't get it? Try again
      </button>
    </div>
  );
}
