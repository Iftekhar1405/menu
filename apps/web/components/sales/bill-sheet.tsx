"use client";

import { useEffect, useState } from "react";
import { PAYMENT_MODE_LABEL, formatMoney, type PaymentMode } from "@menu/shared";
import { api, downloadFile } from "@/lib/api-client";
import { Button, Sheet, SheetGrabber } from "@/components/ui";
import { PaySheet } from "./pay-sheet";
import type { BillRow } from "@/lib/sales/types";

interface FullBill {
  billNumber: number;
  tableLabel: string;
  issuedAt: string;
  subtotal: string;
  taxTotal: string;
  serviceCharge: string;
  roundOff: string;
  total: string;
  taxLabel: string;
  lines: { id: string; name: string; variant: string | null; quantity: number; lineTotal: string }[];
}

export function BillSheet({
  businessId,
  currency,
  row,
  onClose,
  onChanged,
}: {
  businessId: string;
  currency: string;
  row: BillRow;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [bill, setBill] = useState<FullBill | null>(null);
  const [paying, setPaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.get<FullBill>(`/businesses/${businessId}/orders/${row.orderId}/bill`).then(setBill);
  }, [businessId, row.orderId]);

  async function pick(mode: PaymentMode) {
    setBusy(true);
    setError(null);
    try {
      if (row.paymentMode) {
        await api.patch(`/businesses/${businessId}/bills/${row.id}/payment-mode`, { mode });
      } else {
        await api.post(`/businesses/${businessId}/orders/${row.orderId}/paid`, { mode });
      }
      setPaying(false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  const when = new Date(row.issuedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

  return (
    <Sheet label={`Bill ${row.billNumber}`} onClose={onClose} side="side">
      <SheetGrabber />
      <div className="flex-1 overflow-y-auto px-5 py-5">
        <h2 className="text-[18px] font-semibold">Bill #{row.billNumber}</h2>
        <p className="mt-0.5 text-[13.5px] text-muted">Table {row.tableLabel} · {when}</p>
        <p className="mt-3 text-[13.5px]">
          {row.paymentMode
            ? <>Paid · <strong>{PAYMENT_MODE_LABEL[row.paymentMode]}</strong></>
            : <strong className="text-[var(--accent-strong)]">Unpaid</strong>}
        </p>

        {!bill ? (
          <div className="skeleton mt-5 h-40 rounded-xl" />
        ) : (
          <table className="mt-5 w-full text-[14px]">
            <tbody>
              {bill.lines.map((l) => (
                <tr key={l.id} className="border-b border-line">
                  <td className="py-2">{l.quantity} × {l.name}{l.variant ? ` (${l.variant})` : ""}</td>
                  <td className="tnum py-2 text-right">{formatMoney(l.lineTotal, currency)}</td>
                </tr>
              ))}
              <tr><td className="pt-3 text-muted">Subtotal</td><td className="tnum pt-3 text-right">{formatMoney(bill.subtotal, currency)}</td></tr>
              <tr><td className="text-muted">{bill.taxLabel}</td><td className="tnum text-right">{formatMoney(bill.taxTotal, currency)}</td></tr>
              {Number(bill.serviceCharge) > 0 && (
                <tr><td className="text-muted">Service charge</td><td className="tnum text-right">{formatMoney(bill.serviceCharge, currency)}</td></tr>
              )}
              {Number(bill.roundOff) !== 0 && (
                <tr><td className="text-muted">Round off</td><td className="tnum text-right">{formatMoney(bill.roundOff, currency)}</td></tr>
              )}
              <tr className="font-semibold"><td className="pt-2">Total</td><td className="tnum pt-2 text-right">{formatMoney(bill.total, currency)}</td></tr>
            </tbody>
          </table>
        )}
        {error && <p role="alert" className="mt-3 text-[13px] text-[var(--danger,#b42318)]">{error}</p>}
      </div>
      <div className="flex flex-wrap gap-2 border-t border-line px-5 py-4">
        <Button variant="secondary" onClick={() => void downloadFile(`/businesses/${businessId}/orders/${row.orderId}/bill/pdf?format=bill`, `bill-${row.billNumber}.pdf`)}>
          Bill PDF
        </Button>
        <Button variant="secondary" onClick={() => void downloadFile(`/businesses/${businessId}/orders/${row.orderId}/bill/pdf?format=receipt`, `receipt-${row.billNumber}.pdf`)}>
          Receipt
        </Button>
        <Button variant="primary" className="ml-auto" onClick={() => setPaying(true)}>
          {row.paymentMode ? "Change mode" : "Mark paid"}
        </Button>
      </div>
      {paying && (
        <PaySheet
          title={row.paymentMode ? "Change payment mode" : `Mark bill #${row.billNumber} paid`}
          total={row.total}
          currency={currency}
          busy={busy}
          current={row.paymentMode}
          onPick={(m) => void pick(m)}
          onClose={() => setPaying(false)}
        />
      )}
    </Sheet>
  );
}
