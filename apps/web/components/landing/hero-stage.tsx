"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { gsap } from "gsap";
import { MenuView } from "@/components/templates";
import { PhoneFrame } from "@/components/phone-frame";
import { sampleMenu } from "@/lib/sample-menu";
import { KitchenTicket, type Ticket } from "./kitchen-ticket";
import { TableStand } from "./product-pieces";

/*
 * Orders from the sample menu on the phone, so the ticket is visibly the
 * order that phone just placed. The third is table 4 coming back for more:
 * round two, new items only — the detail owners ask about first.
 */
const TICKETS: Ticket[] = [
  {
    token: "42",
    table: "Table 4",
    round: "Round 1",
    time: "19:42",
    items: [
      { qty: 2, name: "Masala dosa", note: "less spicy" },
      { qty: 1, name: "Filter coffee", note: "Double" },
    ],
  },
  {
    token: "43",
    table: "Table 9",
    round: "Round 1",
    time: "19:44",
    items: [
      { qty: 1, name: "Chicken cutlet" },
      { qty: 2, name: "Cold brew", note: "no ice" },
    ],
  },
  {
    token: "42",
    table: "Table 4",
    round: "Round 2, new items",
    time: "19:51",
    items: [{ qty: 1, name: "Filter coffee", note: "Single" }],
  },
];

/** The scene is drawn at this size and scaled to fit its column. */
const W = 600;
const H = 640;

/**
 * The hero: a table at night. The card with the QR on it, the diner's phone,
 * and the kitchen printer printing what they ordered, all under one lamp.
 *
 * Two motions. The printer loops — print, hold, tear, next — with a stepped
 * ease so the paper advances in jerks like a thermal head. And the layers
 * drift a little against the cursor, nearest most, so the table reads as a
 * place rather than a flat picture. With reduced motion, neither runs and
 * the first ticket sits fully printed.
 */
export function HeroStage({ toast, label }: { toast: string; label: string }) {
  const [index, setIndex] = useState(0);
  const [scale, setScale] = useState(1);
  const outerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const paperRef = useRef<HTMLDivElement>(null);
  const toastRef = useRef<HTMLDivElement>(null);
  const ticket = TICKETS[index]!;

  // Fit the fixed-size scene to whatever width the column has.
  useLayoutEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1, el.clientWidth / W));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The printer.
  useEffect(() => {
    const paper = paperRef.current;
    const pill = toastRef.current;
    if (!paper || !pill) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    // Measure this ticket at its natural height, then roll it back into the
    // printer before the browser paints either state.
    gsap.set(paper, { height: "auto" });
    const full = paper.offsetHeight;
    gsap.set(paper, { height: 0, y: 0, opacity: 1, rotate: 0 });

    const tl = gsap.timeline({
      delay: index === 0 ? 1.2 : 0.5,
      onComplete: () => setIndex((i) => (i + 1) % TICKETS.length),
    });
    tl.fromTo(pill, { opacity: 0, y: -10, scale: 0.94 }, { opacity: 1, y: 0, scale: 1, duration: 0.4, ease: "back.out(2)" })
      .to(paper, { height: full, duration: 1.5, ease: `steps(${Math.max(8, Math.round(full / 18))})` }, "+=0.25")
      .to(pill, { opacity: 0, y: -6, duration: 0.3 }, "+=0.7")
      .to(paper, { y: 54, rotate: 3, opacity: 0, duration: 0.55, ease: "power2.in" }, "+=2.1");

    return () => {
      tl.kill();
    };
  }, [index]);

  // Depth: layers drift against the cursor.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce), (pointer: coarse)").matches) return;

    const layers = Array.from(scene.querySelectorAll<HTMLElement>("[data-depth]")).map((el) => {
      const depth = Number(el.dataset.depth);
      return {
        depth,
        x: gsap.quickTo(el, "x", { duration: 0.9, ease: "power3.out" }),
        y: gsap.quickTo(el, "y", { duration: 0.9, ease: "power3.out" }),
      };
    });

    const onMove = (e: PointerEvent) => {
      const nx = e.clientX / window.innerWidth - 0.5;
      const ny = e.clientY / window.innerHeight - 0.5;
      for (const l of layers) {
        l.x(nx * l.depth * -26);
        l.y(ny * l.depth * -16);
      }
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  return (
    <div ref={outerRef} role="img" aria-label={label} className="relative w-full select-none" style={{ height: H * scale }}>
      <div
        ref={sceneRef}
        className="absolute left-1/2 top-0"
        style={{ width: W, height: H, transform: `translateX(-50%) scale(${scale})`, transformOrigin: "top center" }}
        aria-hidden="true"
      >
        {/* The lamp over the table, and the table. */}
        <div className="lp-lamp left-[40px] top-[-40px] h-[520px] w-[520px]" />
        <div className="lp-tabletop" />

        {/* Back left: the card on the table */}
        <div data-depth="0.25" className="absolute left-[-6px] top-[250px]">
          <div className="lp-shadow bottom-[-6px] left-[20px] h-[30px] w-[150px]" />
          <div className="origin-top-left -rotate-[5deg] scale-[0.56]">
            <TableStand />
          </div>
        </div>

        {/* Middle: the diner's phone, held at an angle */}
        <div data-depth="0.6" className="absolute left-[150px] top-[22px]">
          <div className="lp-shadow bottom-[-24px] left-[30px] h-[40px] w-[200px]" />
          <div className="pointer-events-none -rotate-[4deg]" inert>
            <PhoneFrame scale={0.8}>
              <MenuView menu={sampleMenu()} compactChrome />
            </PhoneFrame>
          </div>
        </div>

        {/* "New order" — the hero's one amber signal */}
        <div data-depth="0.9" className="absolute right-[6px] top-[96px] z-20">
          <div
            ref={toastRef}
            className="flex items-center gap-2.5 rounded-full border border-[var(--lp-line)] bg-[var(--lp-raised)]/95 py-2 pl-3 pr-4 text-[13px] opacity-0 shadow-[0_16px_40px_-14px_rgba(0,0,0,0.9)] backdrop-blur"
          >
            <span className="lp-led" />
            <span className="font-semibold text-[var(--lp-text)]">{toast}</span>
            <span className="text-[var(--lp-muted)]">{ticket.table}</span>
          </div>
        </div>

        {/* Front right: the kitchen printer */}
        <div data-depth="1" className="absolute right-[-4px] top-[168px] z-10 w-[236px]">
          <div className="lp-shadow bottom-[-30px] left-[10px] h-[40px] w-[216px]" />
          <div className="rotate-[3deg]">
            <div className="lp-printer relative z-10 rounded-[18px] px-4 pb-4 pt-3.5">
              <div className="flex items-center justify-between text-[11px] text-[var(--lp-muted)]">
                <span>KOT, kitchen</span>
                <span className="lp-led" />
              </div>
              <div className="lp-slot mt-3 h-[6px] rounded-full" />
            </div>
            <div ref={paperRef} className="relative z-0 mx-auto -mt-[9px] w-[86%] overflow-hidden">
              <KitchenTicket ticket={ticket} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
