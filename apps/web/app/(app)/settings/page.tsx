"use client";

import { useEffect, useRef, useState } from "react";
import { BUSINESS_TYPES, BUSINESS_TYPE_LABEL } from "@menu/shared";
import { ApiError, api } from "@/lib/api-client";
import { isImage, prepareImage } from "@/lib/image";
import { mediaUrl } from "@/lib/preview";
import { uploadToTicket } from "@/lib/upload";
import type { UploadTicket } from "@/lib/types";
import { useSession } from "@/components/session";
import { Banner, Button, Field, Input, Select, cx } from "@/components/ui";

export default function SettingsPage() {
  const { current, me, refreshBusinesses } = useSession();
  const logoInput = useRef<HTMLInputElement>(null);

  const [form, setForm] = useState({
    name: "",
    type: "restaurant" as (typeof BUSINESS_TYPES)[number],
    addressLine1: "",
    addressLine2: "",
    city: "",
    state: "",
    postalCode: "",
    vanitySlug: "",
  });
  const [logoPath, setLogoPath] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!current) return;
    setForm({
      name: current.name,
      type: current.type,
      addressLine1: current.addressLine1 ?? "",
      addressLine2: current.addressLine2 ?? "",
      city: current.city ?? "",
      state: current.state ?? "",
      postalCode: current.postalCode ?? "",
      vanitySlug: current.vanitySlug ?? "",
    });
    setLogoPath(current.logoPath);
  }, [current]);

  if (!current) return null;

  async function uploadLogo(file: File) {
    if (!current || !isImage(file)) return;
    const blob = await prepareImage(file);
    const ticket = await api.post<UploadTicket>(
      `/businesses/${current.id}/logo/upload-url`,
    );
    await uploadToTicket(ticket, blob);
    setLogoPath(ticket.path);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!current) return;
    setSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      await api.patch(`/businesses/${current.id}`, {
        name: form.name,
        type: form.type,
        addressLine1: form.addressLine1 || null,
        addressLine2: form.addressLine2 || null,
        city: form.city || null,
        state: form.state || null,
        postalCode: form.postalCode || null,
        vanitySlug: form.vanitySlug || null,
        logoPath,
      });
      await refreshBusinesses();
      setSaved(true);
      setTimeout(() => setSaved(false), 2200);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.fieldErrors ?? {});
      } else {
        setError("Could not save. Try again.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-10 lg:px-10 lg:py-12">
      <header className="mb-8">
        <h1 className="text-[30px] font-semibold leading-tight tracking-tight">Settings</h1>
        <p className="mt-1 text-[14.5px] text-muted">
          Signed in as {me?.email ?? me?.phone}.
        </p>
      </header>

      <form onSubmit={save} className="space-y-6">
        {error && <Banner>{error}</Banner>}

        <div className="flex items-center gap-4">
          <div className="h-16 w-16 shrink-0 overflow-hidden rounded-full border border-line bg-raised">
            {logoPath ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={mediaUrl(logoPath)} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-[20px] font-semibold text-faint">
                {form.name.slice(0, 1).toUpperCase() || "?"}
              </div>
            )}
          </div>
          <div>
            <Button type="button" size="sm" onClick={() => logoInput.current?.click()}>
              {logoPath ? "Replace logo" : "Add a logo"}
            </Button>
            {logoPath && (
              <button
                type="button"
                onClick={() => setLogoPath(null)}
                className="ml-2 text-[13px] text-faint hover:text-ink"
              >
                Remove
              </button>
            )}
            <p className="mt-1.5 text-[12.5px] text-faint">
              Appears on your menu and on the printed QR card.
            </p>
          </div>
          <input
            ref={logoInput}
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void uploadLogo(file);
            }}
          />
        </div>

        <Field label="Business name" error={fieldErrors.name}>
          <Input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
        </Field>

        <Field label="Type">
          <Select
            value={form.type}
            onChange={(e) =>
              setForm({ ...form, type: e.target.value as (typeof BUSINESS_TYPES)[number] })
            }
          >
            {BUSINESS_TYPES.map((t) => (
              <option key={t} value={t}>
                {BUSINESS_TYPE_LABEL[t]}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Custom menu address"
          optional
          error={fieldErrors.vanitySlug}
          hint={`menu.irad.solutions/${form.vanitySlug || current.publicCode.toLowerCase()} — your printed code keeps working either way.`}
        >
          <Input
            value={form.vanitySlug}
            onChange={(e) =>
              setForm({ ...form, vanitySlug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })
            }
            placeholder="kumar-coffee"
          />
        </Field>

        <fieldset className="space-y-3 border-t border-line pt-6">
          <legend className="text-[13px] font-semibold uppercase tracking-[0.12em] text-faint">
            Address
          </legend>
          <p className="text-[13px] text-muted">
            Optional. Shown at the top of your menu.
          </p>
          <Field label="Street" optional>
            <Input
              value={form.addressLine1}
              onChange={(e) => setForm({ ...form, addressLine1: e.target.value })}
              placeholder="12 Residency Road"
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="City" optional>
              <Input
                value={form.city}
                onChange={(e) => setForm({ ...form, city: e.target.value })}
              />
            </Field>
            <Field label="State" optional>
              <Input
                value={form.state}
                onChange={(e) => setForm({ ...form, state: e.target.value })}
              />
            </Field>
            <Field label="PIN code" optional>
              <Input
                value={form.postalCode}
                onChange={(e) => setForm({ ...form, postalCode: e.target.value })}
                className="tnum"
              />
            </Field>
          </div>
        </fieldset>

        <div className={cx("flex items-center gap-3 border-t border-line pt-6")}>
          <Button type="submit" variant="primary" loading={saving}>
            Save changes
          </Button>
          {saved && <span className="text-[13.5px] text-muted">Saved.</span>}
        </div>
      </form>
    </div>
  );
}
