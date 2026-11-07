"use client";

import { useEffect, useRef, useState } from "react";
import { gsap } from "gsap";
import { MenuView } from "@/components/templates";
import { PhoneFrame } from "@/components/phone-frame";
import { sampleMenu } from "@/lib/sample-menu";
import { KitchenTicket, type Ticket } from "./kitchen-ticket";

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

/**
 * The hero's one moving part: a diner's phone, and the kitchen printer
 * printing what they ordered.
 *
 * The loop is print, hold, tear, next. Printing uses a stepped ease so the
 * paper advances in jerks like a real thermal head rather than gliding. With
 * reduced motion it shows the first ticket fully printed and stops.
 */
export function HeroStage({ toast, label }: { toast: string; label: string }) {
  const [index, setIndex] = useState(0);
  const paperRef = useRef<HTMLDivElement>(null);
  const toastRef = useRef<HTMLDivElement>(null);
  const ticket = TICKETS[index]!;

  useEffect(() => {
    const paper = paperRef.current;
    const pill = toastRef.current;
    if (!paper || !pill) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    // Measure this ticket at its natural height, then roll it back into
    // the printer before the browser paints either state.
    gsap.set(paper, { height: "auto" });
    const full = paper.offsetHeight;
    gsap.set(paper, { height: 0, y: 0, opacity: 1, rotate: 0 });

    const tl = gsap.timeline({
      // The first ticket waits for the hero intro to settle.
      delay: index === 0 ? 1.1 : 0.5,
      onComplete: () => setIndex((i) => (i + 1) % TICKETS.length),
    });

    tl.fromTo(pill, { opacity: 0, y: -8, scale: 0.96 }, { opacity: 1, y: 0, scale: 1, duration: 0.35, ease: "back.out(2)" })
      .to(paper, { height: full, duration: 1.5, ease: `steps(${Math.max(8, Math.round(full / 18))})` }, "+=0.25")
      .to(pill, { opacity: 0, y: -6, duration: 0.3 }, "+=0.6")
      .to(paper, { y: 46, rotate: 2.5, opacity: 0, duration: 0.55, ease: "power2.in" }, "+=2.1");

    return () => {
      tl.kill();
    };
  }, [index]);

  return (
    <div role="img" aria-label={label} className="relative mx-auto h-[470px] w-full max-w-[520px] select-none sm:h-[600px]">
      {/* The phone */}
      <div className="absolute left-0 top-10 origin-top-left scale-[0.74] sm:left-2 sm:top-0 sm:scale-100">
        <div className="pointer-events-none" aria-hidden="true" inert>
          <PhoneFrame scale={0.8}>
            <MenuView menu={sampleMenu()} compactChrome />
          </PhoneFrame>
        </div>
      </div>

      {/* "New order" — the one amber signal in the hero. */}
      <div
        ref={toastRef}
        aria-hidden="true"
        className="absolute right-2 top-2 flex items-center gap-2.5 rounded-full border border-[var(--lp-line)] bg-[var(--lp-raised)] py-2 pl-3 pr-4 text-[13px] opacity-0 shadow-[0_12px_30px_-12px_rgba(0,0,0,0.7)] sm:right-0 sm:top-6"
      >
        <span className="lp-led" />
        <span className="font-semibold text-[var(--lp-text)]">{toast}</span>
        <span className="text-[var(--lp-muted)]">{ticket.table}</span>
      </div>

      {/* The printer, with the paper hanging out of its slot */}
      <div aria-hidden="true" className="absolute right-0 top-[150px] w-[188px] sm:top-[120px] sm:w-[244px]">
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
  );
}
