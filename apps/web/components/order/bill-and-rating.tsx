"use client";

import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "@menu/shared";
import { Button, cx } from "../ui";

export interface Bill {
  id: string;
  billNumber: number;
  tableLabel: string;
  issuedAt: string;
  currency: string;
  taxLabel: string;
  pricesIncludeTax: boolean;
  business: { name: string; gstin: string | null };
  receiptFooter: string | null;
  subtotal: string;
  taxTotal: string;
  serviceCharge: string;
  serviceChargeRate: string;
  roundOff: string;
  total: string;
  lines: {
    id: string;
    name: string;
    variant: string | null;
    quantity: number;
    unitPrice: string;
    lineTotal: string;
    taxRate: string;
    taxAmount: string;
  }[];
}

interface Ratable {
  orderId: string;
  googlePlaceId: string | null;
  businessName: string;
}

/**
 * What a diner sees once their order is done: the bill, and an invitation to
 * say how it went.
 *
 * Both are time-boxed by the server — 30 minutes for the bill, 10 for the
 * rating — so this component simply stops showing what the API stops
 * returning rather than running its own clocks.
 */
export function BillAndRating({
  currency,
  onHasContent,
}: {
  currency: string;
  /** Lets the parent hide its "nothing ordered yet" state once a bill exists. */
  onHasContent?: (has: boolean) => void;
}) {
  const [bill, setBill] = useState<Bill | null>(null);
  const [ratable, setRatable] = useState<Ratable | null>(null);
  const [removing, setRemoving] = useState(false);
  /**
   * Held separately from `ratable` on purpose. Submitting a rating makes the
   * order un-ratable, so the polled value goes null immediately — and dropping
   * the card at that moment would yank away the thank-you and the Google link
   * the diner was just offered.
   */
  const [rated, setRated] = useState(false);

  const load = useCallback(async () => {
    const [billRes, rateRes] = await Promise.all([
      fetch("/api/table/bill", { cache: "no-store" }).catch(() => null),
      fetch("/api/table/rating", { cache: "no-store" }).catch(() => null),
    ]);
    if (billRes?.ok) setBill((await billRes.json()) as Bill | null);
    if (rateRes?.ok) {
      const next = (await rateRes.json()) as Ratable | null;
      // Once rated, keep showing the card we already have.
      setRatable((prev) => next ?? prev);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 5000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    onHasContent?.(Boolean(bill || ratable));
  }, [bill, ratable, onHasContent]);

  if (!bill && !ratable) return null;

  async function removeServiceCharge() {
    setRemoving(true);
    const res = await fetch("/api/table/bill/service-charge/remove", {
      method: "POST",
    }).catch(() => null);
    if (res?.ok) setBill((await res.json()) as Bill);
    setRemoving(false);
  }

  return (
    <div className="px-5 py-6">
      {bill && (
        <section className="rounded-2xl border border-[color:var(--menu-line)] p-4">
          <header className="flex items-baseline justify-between gap-3">
            <h2 className="font-display text-[16px] font-semibold text-[color:var(--menu-ink)]">
              Your bill
            </h2>
            <span className="tnum text-[12.5px] text-[color:var(--menu-muted)]">
              #{bill.billNumber} · Table {bill.tableLabel}
            </span>
          </header>

          <ul className="mt-3 space-y-1.5">
            {bill.lines.map((line) => (
              <li key={line.id} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 flex-1 text-[14px] text-[color:var(--menu-ink)]">
                  <span className="tnum mr-1.5 text-[color:var(--menu-muted)]">
                    {line.quantity}×
                  </span>
                  {line.name}
                  {line.variant && (
                    <span className="text-[color:var(--menu-muted)]"> · {line.variant}</span>
                  )}
                </span>
                <span className="tnum shrink-0 text-[14px]">
                  {formatMoney(line.lineTotal, currency)}
                </span>
              </li>
            ))}
          </ul>

          <dl className="mt-3.5 space-y-1 border-t border-[color:var(--menu-line)] pt-3 text-[13.5px]">
            <Row
              label={bill.pricesIncludeTax ? "Subtotal (before tax)" : "Subtotal"}
              value={formatMoney(bill.subtotal, currency)}
            />
            {Number(bill.taxTotal) > 0 && (
              <Row label={bill.taxLabel} value={formatMoney(bill.taxTotal, currency)} />
            )}
            {Number(bill.serviceCharge) > 0 && (
              <div>
                <Row
                  label={`Service charge (${Number(bill.serviceChargeRate)}%)`}
                  value={formatMoney(bill.serviceCharge, currency)}
                />
                {/* A service charge cannot be made mandatory, so the control to
                    decline it sits right next to the amount rather than being
                    something a diner has to ask staff about. */}
                <button
                  onClick={() => void removeServiceCharge()}
                  disabled={removing}
                  className="mt-1 text-[12.5px] font-medium text-[color:var(--accent)] underline-offset-2 hover:underline disabled:opacity-50"
                >
                  {removing ? "Removing…" : "Service charge is optional — remove it"}
                </button>
              </div>
            )}
            {Number(bill.roundOff) !== 0 && (
              <Row label="Rounding" value={formatMoney(bill.roundOff, currency)} />
            )}
          </dl>

          <div className="mt-3 flex items-baseline justify-between border-t border-[color:var(--menu-line)] pt-3">
            <span className="text-[15px] font-semibold text-[color:var(--menu-ink)]">
              Total
            </span>
            <span className="tnum text-[20px] font-semibold text-[color:var(--menu-ink)]">
              {formatMoney(bill.total, currency)}
            </span>
          </div>

          {/* Both documents, because they are for different things: the bill
              is an A5 page to email or file, the receipt is the till slip. */}
          <div className="mt-4 grid grid-cols-2 gap-2">
            <a href="/api/table/bill/pdf?format=bill" download>
              <Button className="w-full">Download bill</Button>
            </a>
            <a href="/api/table/bill/pdf?format=receipt" download>
              <Button className="w-full">Receipt</Button>
            </a>
          </div>

          <p className="mt-2.5 text-[11.5px] leading-relaxed text-[color:var(--menu-muted)]">
            Available to download for 30 minutes. This is a receipt, not a GST tax
            invoice.
            {bill.business.gstin ? ` GSTIN ${bill.business.gstin}.` : ""}
          </p>
        </section>
      )}

      {ratable && (
        <RatingCard ratable={ratable} rated={rated} onRated={() => setRated(true)} />
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[color:var(--menu-muted)]">{label}</dt>
      <dd className="tnum text-[color:var(--menu-ink)]">{value}</dd>
    </div>
  );
}

/**
 * The rating flow.
 *
 * The Google link is offered at every rating, not only good ones. Showing it
 * only to happy diners is review gating — against Google's policies, and it
 * has cost businesses their review counts. Private feedback is offered
 * alongside it at every rating too, so someone who wants to tell the owner
 * rather than the internet can.
 */
function RatingCard({
  ratable,
  rated,
  onRated,
}: {
  ratable: Ratable;
  rated: boolean;
  onRated: () => void;
}) {
  const [stars, setStars] = useState<number | null>(null);
  const [prompts, setPrompts] = useState<{ id: string; text: string }[]>([]);
  const [chosen, setChosen] = useState<{ id: string; text: string } | null>(null);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (stars === null) return;
    void fetch(`/api/table/rating/prompts?stars=${stars}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : []))
      .then((p: { id: string; text: string }[]) => {
        setPrompts(p);
        setChosen(p[0] ?? null);
      })
      .catch(() => setPrompts([]));
  }, [stars]);

  async function submit() {
    if (stars === null) return;
    setBusy(true);
    const res = await fetch("/api/table/rating", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stars,
        promptId: chosen?.id ?? null,
        privateFeedback: feedback.trim() || null,
      }),
    }).catch(() => null);
    setBusy(false);
    if (res?.ok) onRated();
  }

  const googleUrl = ratable.googlePlaceId
    ? `https://search.google.com/local/writereview?placeid=${ratable.googlePlaceId}`
    : null;

  return (
    <section className="mt-5 rounded-2xl bg-[color:var(--accent-soft)] p-4">
      <h2 className="font-display text-[16px] font-semibold text-[color:var(--accent-strong)]">
        {rated ? "Thanks for that" : "How was it?"}
      </h2>

      {!rated && (
        <p className="mt-0.5 text-[13.5px] text-[color:var(--accent-strong)] opacity-80">
          Takes a second, and it genuinely helps {ratable.businessName}.
        </p>
      )}

      <div className="mt-3 flex gap-1.5" role="group" aria-label="Rate your meal">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            onClick={() => !rated && setStars(n)}
            disabled={rated}
            aria-label={`${n} star${n === 1 ? "" : "s"}`}
            aria-pressed={stars === n}
            className={cx(
              "spring flex h-11 w-11 items-center justify-center rounded-full text-[20px]",
              stars !== null && n <= stars
                ? "bg-[color:var(--accent)] text-white"
                : "bg-white/70 text-[color:var(--menu-muted)]",
            )}
          >
            ★
          </button>
        ))}
      </div>

      {stars !== null && !rated && (
        <div className="mt-4 space-y-3">
          {prompts.length > 0 && (
            <div>
              <p className="mb-1.5 text-[12.5px] font-medium text-[color:var(--accent-strong)]">
                Pick something to say, or write your own
              </p>
              <div className="space-y-1.5">
                {prompts.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setChosen(p)}
                    aria-pressed={chosen?.id === p.id}
                    className={cx(
                      "spring block w-full rounded-xl px-3 py-2 text-left text-[13.5px] leading-snug",
                      chosen?.id === p.id
                        ? "bg-white text-[color:var(--menu-ink)] ring-2 ring-[color:var(--accent)]"
                        : "bg-white/60 text-[color:var(--menu-muted)]",
                    )}
                  >
                    {p.text}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <label className="mb-1 block text-[12.5px] font-medium text-[color:var(--accent-strong)]">
              Anything just for {ratable.businessName}? (not published)
            </label>
            <textarea
              rows={2}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="Goes straight to the owner."
              className="w-full rounded-xl border-0 bg-white/80 px-3 py-2 text-[13.5px] outline-none"
            />
          </div>

          <Button variant="primary" className="w-full" loading={busy} onClick={() => void submit()}>
            Send rating
          </Button>
        </div>
      )}

      {rated && (
        <div className="mt-3 space-y-2">
          {googleUrl ? (
            <>
              <p className="text-[13.5px] leading-relaxed text-[color:var(--accent-strong)]">
                If you have another moment, posting it on Google helps them a lot more
                than it helps us.
              </p>
              <Button
                className="w-full"
                onClick={async () => {
                  if (chosen) {
                    await navigator.clipboard.writeText(chosen.text).catch(() => undefined);
                    setCopied(true);
                  }
                  window.open(googleUrl, "_blank", "noopener");
                }}
              >
                {chosen ? (copied ? "Copied — opening Google" : "Copy and open Google") : "Open Google"}
              </Button>
            </>
          ) : (
            <p className="text-[13.5px] leading-relaxed text-[color:var(--accent-strong)]">
              Passed straight to the owner.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
