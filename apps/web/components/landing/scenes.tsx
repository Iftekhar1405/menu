import { MenuView } from "@/components/templates";
import { PhoneFrame } from "@/components/phone-frame";
import { sampleMenu } from "@/lib/sample-menu";
import { KitchenTicket } from "./kitchen-ticket";
import { TableStand } from "./product-pieces";

/*
 * The landing page's illustrations, all drawn from the product's own world:
 * thermal paper, a waiter's notepad, the menu editor, the bill on a phone, a
 * lamp over a table. Purely visual — every one is aria-hidden, because the
 * text beside it already says what it shows.
 */

/* ── Receipt ribbon ────────────────────────────────────────────────────────── */

const RIBBON = [
  "TABLE 4 SCANNED THE QR",
  "ORDER PLACED  2 MASALA DOSA  1 FILTER COFFEE",
  "ACCEPTED",
  "TABLE 9 ADDED ROUND 2",
  "READY  TABLE 4",
  "BILL SENT TO PHONE  ₹435",
  "RATED ★★★★★",
];

/** A strip of paper across the page: one evening, order by order. */
export function ReceiptRibbon() {
  const row = (
    <span className="flex shrink-0 items-center">
      {RIBBON.map((t, i) => (
        <span key={i} className="lp-ribbon-text flex items-center">
          <span className="px-6">{t}</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="opacity-50">
            <circle cx="6" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12" />
          </svg>
        </span>
      ))}
    </span>
  );
  return (
    <div aria-hidden="true" className="lp-ribbon overflow-hidden py-5">
      <div className="lp-marquee" data-marquee="-1" data-speed="60">
        {row}
        {row}
      </div>
    </div>
  );
}

/* ── Dish names ────────────────────────────────────────────────────────────── */

const DISHES_A = ["Masala dosa", "Filter coffee", "Chicken cutlet", "Cold brew", "Paneer tikka"];
const DISHES_B = ["Sweet lassi", "Idli sambar", "Butter roti", "Mango kulfi", "Veg biryani"];

export function DishMarquee() {
  const line = (dishes: string[]) => (
    <span className="flex shrink-0">
      {dishes.map((d) => (
        <span key={d} className="flex items-center">
          {d}
          <span className="lp-dish-dot" />
        </span>
      ))}
    </span>
  );
  return (
    <div aria-hidden="true" className="space-y-2 overflow-hidden py-6">
      <div className="lp-dishes lp-dishes-outline lp-marquee" data-marquee="-1" data-speed="90">
        {line(DISHES_A)}
        {line(DISHES_A)}
      </div>
      <div className="lp-dishes lp-dishes-solid lp-marquee" data-marquee="1" data-speed="110">
        {line(DISHES_B)}
        {line(DISHES_B)}
      </div>
    </div>
  );
}

/* ── The waiter's notepad ──────────────────────────────────────────────────── */

/*
 * Each slip has a messy pose (where it lands in a rush) and a tidy pose
 * (where it ends up once there is a system). Scroll moves one to the other.
 * The tidy pose is the layout; the messy one is applied as an offset.
 */
const SLIPS: { lines: React.ReactNode[]; tidy: [number, number]; messy: [number, number, number] }[] = [
  { lines: ["T3", "2 dosa", "1 coffee??"], tidy: [0, 0], messy: [40, 60, -14] },
  { lines: [<s key="a">T8 dosa</s>, "no, T3!!"], tidy: [210, 0], messy: [-30, 150, 11] },
  { lines: ["T6", "BILL", "asked twice"], tidy: [420, 0], messy: [-260, 40, -8] },
  { lines: ["T4 + filter cof", "single? double?"], tidy: [0, 170], messy: [200, -60, 17] },
  { lines: ["cutlet x1", "T9", "less spicy"], tidy: [210, 170], messy: [150, 30, -21] },
  { lines: ["T2 waiting", "20 min", <s key="b">ready</s>], tidy: [420, 170], messy: [-180, -110, 9] },
];

export function WaiterSlips() {
  return (
    <div aria-hidden="true" className="absolute left-1/2 top-0 h-[330px] w-[610px] origin-top -translate-x-1/2 scale-[0.56] sm:scale-[0.8] lg:scale-100">
      {SLIPS.map((s, i) => (
        <div
          key={i}
          className="lp-slip"
          data-slip
          data-mx={s.messy[0]}
          data-my={s.messy[1]}
          data-mr={s.messy[2]}
          style={{
            left: s.tidy[0],
            top: s.tidy[1],
            // Without script the slips stay where they fell: the problem.
            transform: `translate(${s.messy[0]}px, ${s.messy[1]}px) rotate(${s.messy[2]}deg)`,
            zIndex: i,
          }}
        >
          {s.lines.map((l, j) => (
            <div key={j}>{l}</div>
          ))}
        </div>
      ))}
    </div>
  );
}

/* ── How it works: one scene per step ──────────────────────────────────────── */

function BuilderScene() {
  const rows = [
    { section: "Coffee", items: [["Filter coffee", "from ₹60"], ["Cold brew", "₹180"]] },
    { section: "All day", items: [["Masala dosa", "₹140"], ["Chicken cutlet", "₹210"]] },
  ];
  return (
    <div className="w-[min(440px,100%)] rounded-[22px] border border-[var(--lp-line)] bg-[#101117] p-6 shadow-[0_50px_100px_-40px_rgba(0,0,0,0.9)]">
      <div className="flex items-center justify-between">
        <span className="font-display text-[22px] font-semibold tracking-tight">Menu</span>
        <span className="flex items-center gap-2 rounded-full border border-[var(--lp-line)] px-3 py-1 text-[12px] text-[var(--lp-muted)]">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          Saved, live
        </span>
      </div>
      {rows.map((r) => (
        <div key={r.section} className="mt-5">
          <div className="mb-2 text-[13px] font-semibold text-[var(--lp-text)]">{r.section}</div>
          {r.items.map(([n, p]) => (
            <div key={n} className="mb-2 flex items-center gap-3 rounded-[12px] border border-[var(--lp-line)] bg-[var(--lp-surface)] px-3.5 py-3 text-[14px]">
              <svg width="10" height="14" viewBox="0 0 10 14" fill="#5f6585"><circle cx="2" cy="2" r="1.4" /><circle cx="8" cy="2" r="1.4" /><circle cx="2" cy="7" r="1.4" /><circle cx="8" cy="7" r="1.4" /><circle cx="2" cy="12" r="1.4" /><circle cx="8" cy="12" r="1.4" /></svg>
              <span className="flex-1">{n}</span>
              <span className="text-[var(--lp-muted)]">{p}</span>
            </div>
          ))}
        </div>
      ))}
      <div className="mt-3 rounded-[12px] border border-dashed border-[var(--lp-line)] px-3.5 py-3 text-[13.5px] text-[var(--lp-faint)]">
        + Add a dish to All day
      </div>
    </div>
  );
}

function OrderScene() {
  return (
    <div className="relative" inert>
      <PhoneFrame scale={0.82}>
        <MenuView menu={sampleMenu({ accent: "#1D6F5C" })} compactChrome />
      </PhoneFrame>
      {/* The basket bar the ordering page shows once something is added */}
      <div className="absolute inset-x-[16px] bottom-[26px] flex items-center justify-between rounded-[16px] bg-[#1D6F5C] px-4 py-3 text-white shadow-[0_16px_30px_-12px_rgba(0,0,0,0.6)]">
        <span className="text-[12.5px] leading-tight">
          <span className="block font-semibold">3 items</span>
          <span className="opacity-80">Table 4</span>
        </span>
        <span className="rounded-full bg-white px-4 py-1.5 text-[13px] font-semibold text-[#1D6F5C]">Place order, ₹375</span>
      </div>
    </div>
  );
}

function KitchenScene() {
  const cards = [
    { table: "Table 4", items: "2× Masala dosa, 1× Filter coffee", status: "New", action: "Accept", hot: true },
    { table: "Table 9", items: "1× Chicken cutlet, 2× Cold brew", status: "Being made", action: "Ready" },
    { table: "Table 2", items: "3× Filter coffee, Double", status: "Ready", action: "Bill" },
  ];
  return (
    <div className="relative w-[340px]">
      <div className="relative z-10 rounded-[22px] border border-[var(--lp-line)] bg-[#101117] p-4 shadow-[0_50px_100px_-40px_rgba(0,0,0,0.95)]">
        <div className="mb-3 flex items-baseline justify-between px-1">
          <span className="font-display text-[19px] font-semibold tracking-tight">Orders</span>
          <span className="flex items-center gap-1.5 text-[11.5px] text-[var(--lp-faint)]">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Live
          </span>
        </div>
        <div className="space-y-2.5">
          {cards.map((c) => (
            <div
              key={c.table}
              className={[
                "rounded-[14px] border bg-[var(--lp-surface)] p-3.5",
                c.hot ? "border-[rgba(245,158,11,0.5)] shadow-[0_0_30px_-6px_rgba(245,158,11,0.35)]" : "border-[var(--lp-line)]",
              ].join(" ")}
            >
              <div className="flex items-baseline justify-between">
                <span className="text-[14px] font-semibold">{c.table}</span>
                <span className={["text-[11.5px] font-medium", c.hot ? "text-[var(--lp-amber)]" : "text-[var(--lp-muted)]"].join(" ")}>
                  {c.status}
                </span>
              </div>
              <div className="mt-1.5 text-[12.5px] text-[var(--lp-muted)]">{c.items}</div>
              <div className="mt-2.5 flex justify-end">
                <span
                  className={[
                    "rounded-full px-3 py-1 text-[11.5px] font-semibold",
                    c.hot ? "bg-[var(--lp-amber)] text-[var(--lp-on-amber)]" : "bg-[var(--lp-raised)] text-[var(--lp-text)]",
                  ].join(" ")}
                >
                  {c.action}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
      {/* The optional extra: a ticket, if a printer is connected */}
      <div className="absolute -right-16 top-10 z-0 w-[150px] rotate-[8deg] opacity-80">
        <div className="mb-1.5 text-right text-[10.5px] text-[var(--lp-faint)]">if a printer is connected</div>
        <KitchenTicket
          className="!px-3 !text-[10.5px]"
          ticket={{ token: "42", table: "Table 4", round: "Round 1", time: "19:42", items: [{ qty: 2, name: "Masala dosa" }, { qty: 1, name: "Filter coffee" }] }}
        />
      </div>
    </div>
  );
}

function BillScene() {
  return (
    <div className="relative" inert>
      <PhoneFrame scale={0.82}>
        <div className="min-h-full bg-white px-5 pb-8 pt-5 text-[#17171a]">
          <div className="text-center font-[Fraunces,serif] text-[22px] font-semibold">Kumar Coffee House</div>
          <div className="mt-0.5 text-center text-[12px] text-[#6b6b73]">Table 4, token 42</div>
          <div className="mt-5 space-y-2 text-[13.5px]">
            {[
              ["2× Masala dosa", "₹280"],
              ["1× Filter coffee, Double", "₹95"],
              ["1× Filter coffee, Single", "₹60"],
            ].map(([n, p]) => (
              <div key={n} className="flex justify-between gap-3">
                <span>{n}</span>
                <span>{p}</span>
              </div>
            ))}
          </div>
          <div className="my-4 border-t border-dashed border-[#d9d6cf]" />
          <div className="space-y-1.5 text-[13px] text-[#52576b]">
            <div className="flex justify-between"><span>GST 5%</span><span>₹21.75</span></div>
            <div className="flex justify-between">
              <span>Service charge</span>
              <span>₹21.75 <span className="ml-1 text-[12px] font-medium text-[#9A6700] underline">Remove</span></span>
            </div>
          </div>
          <div className="mt-3 flex justify-between text-[17px] font-semibold"><span>Total</span><span>₹478.50</span></div>
          <div className="mt-6 rounded-[16px] bg-[#f6f3ec] p-4 text-center">
            <div className="text-[14px] font-semibold">How was the food?</div>
            <div className="mt-2 flex justify-center gap-1.5 text-[26px] leading-none">
              {[0, 1, 2, 3, 4].map((i) => (
                <span key={i} style={{ color: i < 4 ? "#9A6700" : "#d9d6cf" }}>★</span>
              ))}
            </div>
          </div>
        </div>
      </PhoneFrame>
    </div>
  );
}

export const STEP_SCENES = [BuilderScene, () => <div className="scale-[0.9]"><TableStand /></div>, OrderScene, KitchenScene, BillScene];

/* ── Pendant lamp ──────────────────────────────────────────────────────────── */

/** A lamp hanging over the last call to action; it switches on as you arrive. */
export function PendantLamp() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 flex flex-col items-center">
      <div className="lp-pendant-cord h-[90px]" />
      <div className="lp-pendant-shade" />
      <div className="lp-pendant-light flex flex-col items-center" data-pendant>
        <div className="lp-pendant-bulb" />
        <div className="lp-pendant-cone" />
      </div>
    </div>
  );
}

/* ── Festoon lights ────────────────────────────────────────────────────────── */

/**
 * A string of bulbs across the gap between two sections, the way a patio is
 * strung for the evening. The bulbs glow in a slow chase.
 */
export function Festoon() {
  const bulbs = 15;
  // A sagging wire: y along a shallow parabola.
  const sag = (i: number) => {
    const t = i / (bulbs - 1);
    return 10 + 46 * 4 * t * (1 - t);
  };
  const path = Array.from({ length: 41 }, (_, k) => {
    const t = k / 40;
    return `${k === 0 ? "M" : "L"}${(t * 1000).toFixed(1)} ${(10 + 46 * 4 * t * (1 - t)).toFixed(1)}`;
  }).join(" ");

  return (
    <div aria-hidden="true" className="pointer-events-none relative h-[110px] overflow-hidden">
      <svg viewBox="0 0 1000 110" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
        <path d={path} fill="none" stroke="#2c2f3e" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      {Array.from({ length: bulbs }, (_, i) => (
        <span
          key={i}
          className="lp-bulb absolute"
          style={{
            left: `${(i / (bulbs - 1)) * 100}%`,
            top: `${(sag(i) / 110) * 100}%`,
            animationDelay: `${(i * 0.22).toFixed(2)}s`,
          }}
        />
      ))}
    </div>
  );
}

/** One bare bulb on a cord, flickering: the light over a service in a rush. */
export function FlickerBulb() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute left-1/2 top-[-140px] z-10 flex -translate-x-1/2 flex-col items-center">
      <div className="h-[110px] w-px bg-gradient-to-b from-transparent to-[#3a3e52]" />
      <div className="h-3 w-4 rounded-t-[3px] bg-[#2a2d3a]" />
      <div className="lp-flicker h-7 w-6 rounded-[50%_50%_45%_45%] bg-[#ffd58a]" />
      <div className="lp-flicker lp-flicker-glow absolute top-[110px] h-[360px] w-[360px] -translate-y-1/3 rounded-full" />
    </div>
  );
}

/** A tealight beside the table card. */
export function Candle({ className = "" }: { className?: string }) {
  return (
    <div aria-hidden="true" className={["pointer-events-none flex flex-col items-center", className].join(" ")}>
      <div className="lp-candle-glow absolute -top-16 h-40 w-40 rounded-full" />
      <div className="lp-flame h-5 w-2.5 rounded-[50%_50%_50%_50%/60%_60%_40%_40%]" />
      <div className="mt-0.5 h-1.5 w-px bg-[#2b2a27]" />
      <div className="h-7 w-14 rounded-b-[6px] rounded-t-[3px] bg-gradient-to-b from-[#e9e2cf] to-[#b9b09a] shadow-[0_10px_20px_-8px_rgba(0,0,0,0.9)]" />
    </div>
  );
}

/* ── Small icons for the details list ──────────────────────────────────────── */

const ICON_PATHS: React.ReactNode[] = [
  <><path d="M7 3h10v18l-2.5-1.5L12 21l-2.5-1.5L7 21Z" /><path d="M10 8h4M10 12h4" /></>,
  <><path d="M6 9V4h12v5" /><rect x="3" y="9" width="18" height="8" rx="2" /><path d="M7 14h10v6H7Z" /><path d="M17 12h.01" /></>,
  <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
  <><path d="M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.8L12 16.9 6.75 19.6l1-5.8L3.5 9.7l5.9-.9Z" /></>,
  <><path d="M5 12h14M12 5v14" transform="rotate(45 12 12)" /><circle cx="7" cy="7" r="2" /><circle cx="17" cy="17" r="2" /></>,
];

export function DetailIcon({ index }: { index: number }) {
  return (
    <span className="lp-icon" aria-hidden="true">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        {ICON_PATHS[index % ICON_PATHS.length]}
      </svg>
    </span>
  );
}
