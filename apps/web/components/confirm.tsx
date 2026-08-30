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
        <div className="fixed inset-0 z-50 flex items-center justify-center px-6">
          {/* Presentational, same reasoning as the sheet: the dialog's own
              Cancel button and Escape are the accessible paths. */}
          <div
            aria-hidden="true"
            onClick={() => close(false)}
            className="absolute inset-0 bg-[rgba(17,17,19,0.32)]"
          />
          <div
            ref={dialogRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            aria-describedby={options.body ? "confirm-body" : undefined}
            className="relative w-full max-w-[400px] rounded-2xl bg-surface p-5 shadow-lift"
          >
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

            <div className="mt-5 flex justify-end gap-2">
              <Button ref={cancelRef} onClick={() => close(false)}>
                {options.cancelLabel ?? "Cancel"}
              </Button>
              <Button
                variant={options.tone === "normal" ? "primary" : "danger"}
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
