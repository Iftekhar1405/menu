"use client";

import { useEffect, useRef, useState } from "react";
import { MenuView } from "@/components/templates";
import { PhoneFrame } from "@/components/phone-frame";
import { sampleMenu } from "@/lib/sample-menu";

/*
 * Real combinations of the three layouts, the accent colours and the type
 * pairings an owner picks from in Menu design. Each phone renders the actual
 * menu component with those tokens.
 */
const DESIGNS = [
  { layout: "editorial", accent: "#1D6F5C", colour: "Pine", fontPairing: "inter-fraunces", type: "Fraunces with Inter" },
  { layout: "compact", accent: "#B4532A", colour: "Terracotta", fontPairing: "outfit-outfit", type: "Outfit" },
  { layout: "grid", accent: "#274472", colour: "Ink", fontPairing: "playfair-lato", type: "Playfair with Lato" },
  { layout: "editorial", accent: "#8C2F39", colour: "Burgundy", fontPairing: "dmserif-inter", type: "DM Serif with Inter" },
  { layout: "compact", accent: "#6B3A73", colour: "Plum", fontPairing: "spacegrotesk-inter", type: "Space Grotesk with Inter" },
  { layout: "grid", accent: "#9A6700", colour: "Amber", fontPairing: "inter-fraunces", type: "Fraunces with Inter" },
  { layout: "editorial", accent: "#274472", colour: "Ink", fontPairing: "playfair-lato", type: "Playfair with Lato" },
] as const;

const LAYOUT_INDEX = { editorial: 0, compact: 1, grid: 2 } as const;
const N = DESIGNS.length;

/** Shortest signed distance from the active slide, wrapping round. */
function offset(i: number, active: number) {
  let d = (i - active) % N;
  if (d > N / 2) d -= N;
  if (d < -N / 2) d += N;
  return d;
}

/**
 * Menu designs as a coverflow: the chosen one faces you under the lamp, the
 * others turn away on either side. It advances by itself while on screen,
 * stops while you hover or drag, and stays put with reduced motion.
 */
export function DesignCarousel({
  layouts,
  previousLabel,
  nextLabel,
}: {
  layouts: string[];
  previousLabel: string;
  nextLabel: string;
}) {
  const [active, setActive] = useState(1);
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragFrom = useRef<number | null>(null);

  const go = (step: number) => setActive((a) => (a + step + N) % N);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(Boolean(e?.isIntersecting)), { threshold: 0.3 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (paused || !visible) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => go(1), 3200);
    return () => clearInterval(t);
  }, [paused, visible]);

  const current = DESIGNS[active]!;

  return (
    <div
      ref={rootRef}
      className="relative"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
    >
      <div className="lp-lamp left-1/2 top-[-80px] h-[520px] w-[620px] -translate-x-1/2" aria-hidden="true" />

      <div
        aria-hidden="true"
        className="relative mx-auto h-[400px] touch-pan-y select-none [perspective:1400px] sm:h-[420px]"
        onPointerDown={(e) => (dragFrom.current = e.clientX)}
        onPointerUp={(e) => {
          if (dragFrom.current === null) return;
          const dx = e.clientX - dragFrom.current;
          dragFrom.current = null;
          if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
        }}
      >
        {DESIGNS.map((d, i) => {
          const o = offset(i, active);
          const a = Math.abs(o);
          return (
            <div
              key={i}
              className="absolute left-1/2 top-0 cursor-grab transition-[transform,opacity,filter] duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] active:cursor-grabbing"
              style={{
                transform: `translateX(calc(-50% + ${o * 150}px)) translateZ(${-a * 140}px) rotateY(${-o * 32}deg)`,
                opacity: a > 2 ? 0 : 1 - a * 0.22,
                filter: a === 0 ? "none" : `brightness(${1 - a * 0.25})`,
                zIndex: 10 - a,
              }}
              onClick={() => o !== 0 && go(o)}
            >
              <div className="pointer-events-none" inert>
                <PhoneFrame scale={0.56}>
                  <MenuView menu={sampleMenu({ layout: d.layout, accent: d.accent, fontPairing: d.fontPairing })} compactChrome />
                </PhoneFrame>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-2 flex items-center justify-center gap-5">
        <button type="button" onClick={() => go(-1)} aria-label={previousLabel} className="grid h-11 w-11 place-items-center rounded-full border border-[var(--lp-line)] text-[var(--lp-text)] transition-colors hover:bg-[var(--lp-surface)]">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
        </button>
        <p className="min-w-[13em] text-center" aria-live="polite">
          <span className="block text-[16px] font-semibold text-[var(--lp-text)]">{layouts[LAYOUT_INDEX[current.layout]]}</span>
          <span className="mt-0.5 flex items-center justify-center gap-2 text-[13px] text-[var(--lp-muted)]">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: current.accent }} aria-hidden="true" />
            {current.colour}, {current.type}
          </span>
        </p>
        <button type="button" onClick={() => go(1)} aria-label={nextLabel} className="grid h-11 w-11 place-items-center rounded-full border border-[var(--lp-line)] text-[var(--lp-text)] transition-colors hover:bg-[var(--lp-surface)]">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6" /></svg>
        </button>
      </div>
    </div>
  );
}
