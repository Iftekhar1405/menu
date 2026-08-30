"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api-client";
import { useSession } from "@/components/session";
import { Banner, Button, Field, Input, Textarea, cx } from "@/components/ui";

interface TaxConfig {
  taxEnabled: boolean;
  taxLabel: string;
  defaultTaxRate: number;
  pricesIncludeTax: boolean;
  gstin: string | null;
  serviceChargeEnabled: boolean;
  serviceChargeRate: number;
  receiptFooter: string | null;
}

export default function BillingPage() {
  const { current } = useSession();
  const [config, setConfig] = useState<TaxConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!current) return;
    setConfig(await api.get<TaxConfig>(`/businesses/${current.id}/tax`));
  }, [current]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!current || !config) return null;

  const set = <K extends keyof TaxConfig>(key: K, value: TaxConfig[K]) =>
    setConfig({ ...config, [key]: value });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!current || !config) return;
    setSaving(true);
    setError(null);
    try {
      setConfig(await api.patch<TaxConfig>(`/businesses/${current.id}/tax`, config));
      setSaved(true);
      setTimeout(() => setSaved(false), 2200);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-10 lg:px-10 lg:py-12">
      <header className="mb-8">
        <h1 className="text-[30px] font-semibold leading-tight tracking-tight">Billing</h1>
        <p className="mt-1 text-[14.5px] leading-relaxed text-muted">
          How bills are calculated and what appears on them.
        </p>
      </header>

      {/* Said once, plainly, where the person configuring tax will read it. */}
      <div className="mb-8 rounded-2xl border border-line bg-surface p-4">
        <h2 className="text-[14px] font-medium">This is a receipt, not a tax invoice</h2>
        <p className="mt-1 text-[13.5px] leading-relaxed text-muted">
          Bills show your tax but do not carry a financial-year invoice number, HSN
          codes, or a CGST/SGST split. If you are GST registered, this is not a
          substitute for the tax invoice you are required to issue.
        </p>
      </div>

      <form onSubmit={save} className="space-y-8">
        {error && <Banner>{error}</Banner>}

        <section>
          <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.12em] text-faint">
            Tax
          </h2>

          <Toggle
            checked={config.taxEnabled}
            onChange={(v) => set("taxEnabled", v)}
            label="Show tax on bills"
            hint="Turn off if you are not registered or are on the composition scheme."
          />

          {config.taxEnabled && (
            <div className="mt-4 space-y-4 border-l-2 border-line pl-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Label">
                  <Input
                    value={config.taxLabel}
                    onChange={(e) => set("taxLabel", e.target.value)}
                    placeholder="GST"
                  />
                </Field>
                <Field label="Default rate (%)">
                  <Input
                    value={String(config.defaultTaxRate)}
                    onChange={(e) =>
                      set("defaultTaxRate", Number(e.target.value.replace(/[^\d.]/g, "")) || 0)
                    }
                    inputMode="decimal"
                    className="tnum"
                  />
                </Field>
              </div>

              <Toggle
                checked={config.pricesIncludeTax}
                onChange={(v) => set("pricesIncludeTax", v)}
                label="Menu prices already include tax"
                hint={
                  config.pricesIncludeTax
                    ? "A ₹105 dish at 5% bills as ₹100 plus ₹5 tax. This is how most menus are priced."
                    : "A ₹105 dish at 5% bills as ₹105 plus ₹5.25 tax on top. Diners pay more than the menu shows."
                }
              />

              <Field
                label="GSTIN"
                optional
                hint="Printed on the bill if you add it."
              >
                <Input
                  value={config.gstin ?? ""}
                  onChange={(e) => set("gstin", e.target.value || null)}
                  placeholder="29ABCDE1234F1Z5"
                  className="tnum"
                />
              </Field>

              <p className="text-[12.5px] leading-relaxed text-faint">
                Individual dishes can override this rate — useful for packaged items
                like bottled water, which are not taxed at the food rate. Set it in the
                dish&apos;s advanced details.
              </p>
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.12em] text-faint">
            Service charge
          </h2>

          <div className="mb-3 rounded-2xl border border-[#F0D5D3] bg-[#FDF3F2] px-3.5 py-3">
            <p className="text-[13px] leading-relaxed text-[#8C1D18]">
              Under the 2022 CCPA guidelines a service charge cannot be added
              automatically or made mandatory, and restaurants have been ordered to
              refund it. If you switch this on, diners see a control to remove it from
              their own bill, and the printed receipt says it is optional.
            </p>
          </div>

          <Toggle
            checked={config.serviceChargeEnabled}
            onChange={(v) => set("serviceChargeEnabled", v)}
            label="Add a service charge"
          />

          {config.serviceChargeEnabled && (
            <div className="mt-4 w-40 border-l-2 border-line pl-4">
              <Field label="Rate (%)">
                <Input
                  value={String(config.serviceChargeRate)}
                  onChange={(e) =>
                    set("serviceChargeRate", Number(e.target.value.replace(/[^\d.]/g, "")) || 0)
                  }
                  inputMode="decimal"
                  className="tnum"
                />
              </Field>
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.12em] text-faint">
            Receipt
          </h2>
          <Field label="Footer note" optional hint="Printed at the bottom of every bill.">
            <Textarea
              rows={2}
              value={config.receiptFooter ?? ""}
              onChange={(e) => set("receiptFooter", e.target.value || null)}
              placeholder="Thank you. Please come again."
            />
          </Field>
        </section>

        <div className="flex items-center gap-3 border-t border-line pt-6">
          <Button type="submit" variant="primary" loading={saving}>
            Save
          </Button>
          {saved && <span className="text-[13.5px] text-muted">Saved.</span>}
        </div>
      </form>
    </div>
  );
}

function Toggle({
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
        className="flex items-center gap-3 text-left"
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
