"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, api, logout } from "@/lib/api-client";
import { PinInput } from "@/components/pin-input";
import { Banner, Button } from "@/components/ui";

/**
 * Shown once, to an account whose PIN was chosen by somebody else.
 *
 * Changing a PIN revokes every session, this one included, so the only
 * honest ending is to send them back to sign in with the PIN they just
 * picked.
 */
export default function ChangePinPage() {
  const router = useRouter();
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setError(null);
    if (newPin !== confirmPin) {
      setError("Those two PINs don't match.");
      return;
    }
    setSaving(true);
    try {
      await api.post("/auth/pin/change", { currentPin, newPin });
      await logout();
      router.replace("/login");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work. Try again.");
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm px-edge py-10">
      <h1 className="text-[20px] font-semibold text-ink">Choose your own PIN</h1>
      <p className="mt-1 text-[13.5px] text-muted">
        Someone else set the PIN you signed in with. Pick one only you know.
      </p>
      <form onSubmit={submit} className="mt-6 space-y-5">
        <PinInput
          label="PIN you were given"
          value={currentPin}
          onChange={setCurrentPin}
          disabled={saving}
        />
        <PinInput label="New PIN" value={newPin} onChange={setNewPin} disabled={saving} />
        <PinInput
          label="New PIN again"
          value={confirmPin}
          onChange={setConfirmPin}
          disabled={saving}
        />
        {error && <Banner>{error}</Banner>}
        <Button type="submit" variant="primary" loading={saving} className="w-full">
          Save PIN
        </Button>
      </form>
    </div>
  );
}
