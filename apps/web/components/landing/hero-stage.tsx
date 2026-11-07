"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { gsap } from "gsap";
import { MenuView } from "@/components/templates";
import { PhoneFrame } from "@/components/phone-frame";
import { sampleMenu } from "@/lib/sample-menu";
import { TableStand } from "./product-pieces";

/*
 * Orders from the sample menu on the phone, arriving in turn on the board.
 * Table 4 comes back for a second round, which shows as running.
 */
const ORDERS = [
  { table: "Table 4", token: "42", items: "2× Masala dosa, 1× Filter coffee", total: "₹375" },
  { table: "Table 9", token: "43", items: "1× Chicken cutlet, 2× Cold brew", total: "₹570" },
  { table: "Table 4", token: "42", items: "Round 2: 1× Filter coffee", total: "₹60", running: true },
  { table: "Table 11", token: "44", items: "2× Masala dosa, 2× Cold brew", total: "₹640" },
];

/** Newest first: what the board shows for a card at each depth. */
const STATUS = [
  { label: "New", tone: "text-[var(--lp-amber)]", action: "Accept" },
  { label: "Being made", tone: "text-[var(--lp-muted)]", action: "Ready" },
  { label: "Ready", tone: "text-emerald-400", action: "Bill" },
];

const W = 600;
const H = 640;
const N = ORDERS.length;

/**
 * The hero: a table at night. The card with the QR on it, the diner's phone,
 * and the owner's live board where the order lands, all under one lamp.
 *
 * Two motions. Orders keep arriving: a "new order" signal, then the card
 * drops in at the top while earlier ones move on to Being made and Ready.
 * And the layers drift a little against the cursor, nearest most, so the
 * table reads as a place rather than a flat picture. With reduced motion,
 * neither runs and the board sits mid-service.
 */
export function HeroStage({ toast, label }: { toast: string; label: string }) {
  const [tick, setTick] = useState(N * 10);
  const [scale, setScale] = useState(1);
  const outerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const newestRef = useRef<HTMLLIElement>(null);
  const toastRef = useRef<HTMLDivElement>(null);
  const first = useRef(true);

  const cards = [0, 1, 2].map((depth) => ({ id: tick - depth, order: ORDERS[(tick - depth) % N]!, status: STATUS[depth]! }));

  useLayoutEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1, el.clientWidth / W));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Orders keep coming in.
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let interval: ReturnType<typeof setInterval> | undefined;
    const start = setTimeout(() => {
      setTick((t) => t + 1);
      interval = setInterval(() => setTick((t) => t + 1), 3600);
    }, 1600);
    return () => {
      clearTimeout(start);
      if (interval) clearInterval(interval);
    };
  }, []);

  // Each arrival: the signal, then the card.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const card = newestRef.current;
    const pill = toastRef.current;
    if (!card || !pill) return;
    const tl = gsap.timeline();
    tl.fromTo(pill, { opacity: 0, y: -10, scale: 0.94 }, { opacity: 1, y: 0, scale: 1, duration: 0.35, ease: "back.out(2)" })
      .from(card, { height: 0, opacity: 0, y: -18, duration: 0.6, ease: "power3.out", clearProps: "height,opacity,transform" }, "-=0.1")
      .fromTo(
        card,
        { boxShadow: "0 0 0 1px rgba(245,158,11,0.9), 0 0 40px rgba(245,158,11,0.35)" },
        { boxShadow: "0 0 0 1px rgba(245,158,11,0), 0 0 0px rgba(245,158,11,0)", duration: 1.6, clearProps: "boxShadow" },
        "-=0.2",
      )
      .to(pill, { opacity: 0, y: -6, duration: 0.3 }, "+=0.9");
    return () => {
      tl.kill();
    };
  }, [tick]);

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
        <div className="lp-lamp left-[40px] top-[-40px] h-[520px] w-[520px]" />
        <div className="lp-tabletop" />

        {/* Back left: the card on the table */}
        <div data-depth="0.25" className="absolute left-[-10px] top-[250px]">
          <div className="lp-shadow bottom-[-6px] left-[20px] h-[30px] w-[150px]" />
          <div className="origin-top-left -rotate-[5deg] scale-[0.56]">
            <TableStand />
          </div>
        </div>

        {/* Middle: the diner's phone */}
        <div data-depth="0.6" className="absolute left-[120px] top-[22px]">
          <div className="lp-shadow bottom-[-24px] left-[30px] h-[40px] w-[200px]" />
          <div className="pointer-events-none -rotate-[4deg]" inert>
            <PhoneFrame scale={0.8}>
              <MenuView menu={sampleMenu()} compactChrome />
            </PhoneFrame>
          </div>
        </div>

        {/* Front right: the owner's live board, where the order lands */}
        <div data-depth="1" className="absolute right-[-8px] top-[132px] z-10 w-[262px]">
          <div className="lp-shadow bottom-[-26px] left-[16px] h-[40px] w-[230px]" />
          <div
            ref={toastRef}
            className="absolute -top-12 left-4 z-20 flex items-center gap-2.5 rounded-full border border-[var(--lp-line)] bg-[var(--lp-raised)] py-2 pl-3 pr-4 text-[13px] opacity-0 shadow-[0_16px_40px_-14px_rgba(0,0,0,0.9)]"
          >
            <span className="lp-led" />
            <span className="font-semibold text-[var(--lp-text)]">{toast}</span>
            <span className="text-[var(--lp-muted)]">{cards[0]!.order.table}</span>
          </div>
          <div className="rotate-[2.5deg] rounded-[20px] border border-[var(--lp-line)] bg-[#101117]/95 p-3.5 shadow-[0_40px_80px_-30px_rgba(0,0,0,0.95)] backdrop-blur">
            <div className="mb-3 flex items-baseline justify-between px-1">
              <span className="font-display text-[17px] font-semibold tracking-tight">Orders</span>
              <span className="flex items-center gap-1.5 text-[11px] text-[var(--lp-faint)]">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                Live
              </span>
            </div>
            <ul className="space-y-2.5 overflow-hidden">
              {cards.map((c, i) => (
                <li
                  key={c.id}
                  ref={i === 0 ? newestRef : undefined}
                  className={[
                    "overflow-hidden rounded-[13px] border bg-[var(--lp-surface)] p-3",
                    i === 0 ? "border-[rgba(245,158,11,0.35)]" : "border-[var(--lp-line)]",
                  ].join(" ")}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[13.5px] font-semibold">{c.order.table}</span>
                    <span className={["text-[11px] font-medium", c.status.tone].join(" ")}>
                      {c.order.running && i === 0 ? "Running" : c.status.label}
                    </span>
                  </div>
                  <div className="mt-1.5 text-[12px] leading-snug text-[var(--lp-muted)]">{c.order.items}</div>
                  <div className="mt-2.5 flex items-center justify-between">
                    <span className="text-[12.5px] font-semibold">{c.order.total}</span>
                    <span
                      className={[
                        "rounded-full px-2.5 py-1 text-[11px] font-semibold",
                        i === 0 ? "bg-[var(--lp-amber)] text-[var(--lp-on-amber)]" : "bg-[var(--lp-raised)] text-[var(--lp-text)]",
                      ].join(" ")}
                    >
                      {c.status.action}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
