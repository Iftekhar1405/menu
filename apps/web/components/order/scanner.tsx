"use client";

import { useEffect, useRef, useState } from "react";
import { tableClaimPath } from "@/lib/table-claim";
import { Button, Input, cx } from "../ui";

/**
 * What a diner sees when they reach /order with no table session.
 *
 * The brief asked for the scanner to open automatically when the state does
 * not exist, and that is what this is — not an error, not a "session expired"
 * page. Someone in this state is sitting at a table with a card in front of
 * them; the fastest route back is the camera.
 *
 * BarcodeDetector is used where the browser has it and skipped where it does
 * not, rather than shipping a QR-decoding library to every phone. The typed
 * fallback is always available, because cameras get denied, lenses get
 * covered, and older iOS Safari has no detector at all.
 */
export function Scanner({ hadBadCard }: { hadBadCard?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<"idle" | "scanning" | "denied" | "unsupported">(
    "idle",
  );
  const [manual, setManual] = useState("");

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;

    async function start() {
      const Detector = (window as unknown as { BarcodeDetector?: new (o: object) => {
        detect: (s: CanvasImageSource) => Promise<{ rawValue: string }[]>;
      } }).BarcodeDetector;

      if (!Detector) {
        setState("unsupported");
        return;
      }

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
      } catch {
        setState("denied");
        return;
      }

      if (stopped || !videoRef.current) return;
      videoRef.current.srcObject = stream;
      await videoRef.current.play().catch(() => undefined);
      setState("scanning");

      const detector = new Detector({ formats: ["qr_code"] });

      const tick = async () => {
        if (stopped || !videoRef.current) return;
        try {
          const codes = await detector.detect(videoRef.current);
          const path = codes
            .map((c) => tableClaimPath(c.rawValue))
            .find((p): p is string => p !== null);
          if (path) {
            stopped = true;
            window.location.href = path;
            return;
          }
        } catch {
          // A dropped frame is not worth stopping the loop over.
        }
        raf = requestAnimationFrame(() => void tick());
      };
      void tick();
    }

    void start();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  function go() {
    const code = manual.trim().split("/").pop();
    if (code) window.location.href = `/t/${encodeURIComponent(code)}`;
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-[460px] flex-col justify-center px-6 py-10">
      <h1 className="text-[24px] font-semibold leading-tight tracking-tight">
        Scan the code on your table
      </h1>
      <p className="mt-1.5 text-[14.5px] leading-relaxed text-muted">
        {hadBadCard
          ? "That code didn't work. Try scanning it again."
          : "It tells us which table to bring your order to."}
      </p>

      <div
        className={cx(
          "relative mt-6 aspect-square w-full overflow-hidden rounded-2xl border border-line bg-[#101014]",
          state !== "scanning" && "grid place-items-center",
        )}
      >
        <video
          ref={videoRef}
          playsInline
          muted
          className={cx("h-full w-full object-cover", state !== "scanning" && "hidden")}
        />
        {state === "scanning" && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-8 rounded-xl border-2 border-white/70"
          />
        )}
        {state === "idle" && <p className="text-[13.5px] text-white/60">Starting camera…</p>}
        {state === "denied" && (
          <p className="px-8 text-center text-[13.5px] leading-relaxed text-white/70">
            Camera access is off. Allow it in your browser settings, or type the code
            below.
          </p>
        )}
        {state === "unsupported" && (
          <p className="px-8 text-center text-[13.5px] leading-relaxed text-white/70">
            This browser can&apos;t scan. Open your camera app and scan the card, or type
            the code below.
          </p>
        )}
      </div>

      <div className="mt-6">
        <label className="mb-1.5 block text-[13px] font-medium text-ink">
          Or type the code printed on the card
        </label>
        <div className="flex gap-2">
          <Input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="a1b2c3d4…"
            onKeyDown={(e) => e.key === "Enter" && go()}
          />
          <Button variant="primary" onClick={go} disabled={manual.trim().length === 0}>
            Go
          </Button>
        </div>
      </div>
    </main>
  );
}
