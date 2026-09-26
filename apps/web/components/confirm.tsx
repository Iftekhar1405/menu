"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "./ui";

export interface ConfirmOptions {
  title: string;
  /** What actually happens, in plain terms. Say the consequence, not "are you sure". */
  body?: string;
  /** The verb on the button. Repeats the action so the button is readable alone. */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive styling, and the default. */
  tone?: "danger" | "normal";
}

type Resolver = (ok: boolean) => void;

const ConfirmContext = createContext<((o: ConfirmOptions) => Promise<boolean>) | null>(
  null,
);

/**
 * `const ok = await confirm({ ... })` — a promise, so a call site reads as a
 * single step rather than being split across a callback.
 */
export function useConfirm() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm must be used inside ConfirmProvider");
  return confirm;
}

/**
 * One dialog for every destructive action in the dashboard.
 *
 * Deliberately not applied to forward progress — a member of staff tapping
 * "Ready" forty times during a service must never be asked to confirm it.
 * Confirmation is for things that destroy data or end a session, where the
 * cost of a mis-tap is real and the cost of one extra tap is not.
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<Resolver | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const confirm = useCallback((opts: ConfirmOptions) => {
    returnFocus.current = document.activeElement as HTMLElement | null;
    setOptions(opts);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const close = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOptions(null);
    // Put focus back where it came from, so a keyboard user is not dropped at
    // the top of the page after dismissing.
    returnFocus.current?.focus();
  }, []);

  useEffect(() => {
    if (!options) return;

    // Cancel is focused rather than the destructive action: a stray Enter
    // should dismiss, never delete.
    cancelRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        // Stops here. Anything underneath — the item sheet, say — also
        // listens for Escape on window, and one keypress closing both the
        // dialog and the thing that opened it is not what anyone meant.
        e.stopPropagation();
        close(false);
        return;
      }
      // A minimal focus trap. Two buttons, so cycling between them is enough.
      if (e.key === "Tab" && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>("button");
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    // Capture phase, so this runs before any listener the surface underneath
    // registered — registration order would otherwise decide who wins.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [options, close]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}

      {options && (
        /*
         * An action sheet on a phone, a centred alert on a desktop. Same
         * markup either way: on a phone the two buttons are stacked and
         * full-width against the bottom edge, because that is where the
         * thumb already is and because a 400px card floating in the middle
         * of a 390px screen is a desktop dialog that has been shrunk rather
         * than a phone control.
         *
         * The destructive action is on top of the stack and Cancel beneath
         * it — the same order iOS uses, and the one that puts the button you
         * usually want nearest the thumb.
         */
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:px-6">
          {/* Presentational, same reasoning as the sheet: the dialog's own
              Cancel button and Escape are the accessible paths. */}
          <div
            aria-hidden="true"
            onClick={() => close(false)}
            className="animate-fade-in absolute inset-0 bg-[rgba(17,17,19,0.32)]"
          />
          <div
            ref={dialogRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            aria-describedby={options.body ? "confirm-body" : undefined}
            className="animate-sheet-up relative w-full rounded-t-[20px] bg-surface p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom,0px))] shadow-lift sm:max-w-[400px] sm:rounded-2xl sm:pb-5"
          >
            <div aria-hidden="true" className="mb-3 flex justify-center sm:hidden">
              <div className="h-1 w-9 rounded-full bg-[rgba(17,17,19,0.16)]" />
            </div>

            <h2
              id="confirm-title"
              className="font-display text-[17px] font-semibold text-ink"
            >
              {options.title}
            </h2>
            {options.body && (
              <p
                id="confirm-body"
                className="mt-1.5 text-[14px] leading-relaxed text-muted"
              >
                {options.body}
              </p>
            )}

            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                ref={cancelRef}
                className="w-full sm:w-auto"
                onClick={() => close(false)}
              >
                {options.cancelLabel ?? "Cancel"}
              </Button>
              <Button
                variant={options.tone === "normal" ? "primary" : "danger"}
                className="w-full sm:w-auto"
                onClick={() => close(true)}
              >
                {options.confirmLabel ?? "Delete"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
