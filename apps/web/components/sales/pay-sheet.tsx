"use client";

import { PAYMENT_MODES, PAYMENT_MODE_LABEL, formatMoney, type PaymentMode } from "@menu/shared";
import { Button, Sheet, SheetGrabber } from "@/components/ui";

/**
 * How was it paid? Four large targets and the amount, nothing else. Nothing
 * is written until a mode is tapped — closing the sheet leaves the order as
 * it was.
 */
export function PaySheet({
  title,
  total,
  currency,
  busy,
  current,
  onPick,
  onClose,
}: {
  title: string;
  total: string | null;
  currency: string;
  busy: boolean;
  /** The mode already recorded, when correcting. */
  current?: PaymentMode | null;
  onPick: (mode: PaymentMode) => void;
  onClose: () => void;
}) {
  return (
    <Sheet label={title} onClose={onClose}>
      <SheetGrabber />
      <div className="px-5 pb-6 pt-4 sm:px-6">
        <h2 className="text-[17px] font-semibold">{title}</h2>
        {total !== null && (
          <p className="tnum mt-1 text-[28px] font-semibold tracking-tight">{formatMoney(total, currency)}</p>
        )}
        <div className="mt-5 grid grid-cols-2 gap-3">
          {PAYMENT_MODES.map((mode) => (
            <Button
              key={mode}
              variant={current === mode ? "primary" : "secondary"}
              className="h-16 text-[16px]"
              disabled={busy}
              onClick={() => onPick(mode)}
            >
              {PAYMENT_MODE_LABEL[mode]}
            </Button>
          ))}
        </div>
        <Button variant="ghost" className="mt-4 w-full" onClick={onClose} disabled={busy}>
          Not now
        </Button>
      </div>
    </Sheet>
  );
}
