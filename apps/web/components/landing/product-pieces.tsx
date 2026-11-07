import { MenuView } from "@/components/templates";
import { PhoneFrame } from "@/components/phone-frame";
import { sampleMenu } from "@/lib/sample-menu";
import { KitchenTicket } from "./kitchen-ticket";

/*
 * Product UI shown on the landing page.
 *
 * The phones render the real menu component with real theme tokens, so what
 * is pictured is what an owner gets. The orders board and the paper are
 * faithful small copies of screens and printouts that cannot be rendered
 * here without an account; they use the app's own labels, which is why they
 * stay in English on the Hindi page too.
 */

/** The same menu in three of the real layout, colour and type choices. */
export function DesignTrio({ layouts }: { layouts: string[] }) {
  const variants = [
    { layout: "editorial", accent: "#1D6F5C", fontPairing: "inter-fraunces" },
    { layout: "compact", accent: "#B4532A", fontPairing: "outfit-outfit" },
    { layout: "grid", accent: "#274472", fontPairing: "playfair-lato" },
  ] as const;

  return (
    <div aria-hidden="true" inert className="pointer-events-none flex items-end justify-center gap-3 sm:gap-5">
      {variants.map((v, i) => (
        <figure key={v.layout} className={i === 1 ? "-mb-0 sm:-mb-6" : "mb-6 hidden sm:block"}>
          <PhoneFrame scale={i === 1 ? 0.6 : 0.5}>
            <MenuView menu={sampleMenu({ layout: v.layout, accent: v.accent, fontPairing: v.fontPairing })} compactChrome />
          </PhoneFrame>
          <figcaption className="mt-3 text-center text-[13px] text-[var(--lp-muted)]">{layouts[i]}</figcaption>
        </figure>
      ))}
    </div>
  );
}

/** The live orders board, at rest mid-service. */
export function OrdersBoardMini() {
  const columns = [
    {
      title: "New",
      cards: [
        {
          table: "Table 4",
          meta: "#42, running",
          running: true,
          rounds: [
            { name: "Round 2", items: [["1", "Filter coffee", "Single"]] },
          ],
          total: "₹435",
          action: "Accept",
        },
        {
          table: "Table 11",
          meta: "#46, just now",
          rounds: [{ name: "Round 1", items: [["2", "Masala dosa", ""], ["2", "Cold brew", ""]] }],
          total: "₹640",
          action: "Accept",
        },
      ],
    },
    {
      title: "Being made",
      cards: [
        {
          table: "Table 9",
          meta: "#43, 6 min",
          rounds: [{ name: "Round 1", items: [["1", "Chicken cutlet", ""], ["2", "Cold brew", ""]] }],
          total: "₹570",
          action: "Ready",
        },
      ],
    },
    {
      title: "Ready",
      cards: [
        {
          table: "Table 2",
          meta: "#41, 14 min",
          rounds: [{ name: "Round 1", items: [["3", "Filter coffee", "Double"]] }],
          total: "₹285",
          action: "Bill",
        },
      ],
    },
  ];

  return (
    <div
      aria-hidden="true"
      className="overflow-hidden rounded-[20px] border border-[var(--lp-line)] bg-[#101117] p-4 shadow-[0_40px_100px_-50px_rgba(0,0,0,0.9)] sm:p-6"
    >
      <div className="flex items-baseline justify-between">
        <span className="font-display text-[22px] font-semibold tracking-tight">Orders</span>
        <span className="text-[12px] text-[var(--lp-faint)]">4 open</span>
      </div>
      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {columns.map((col, ci) => (
          <div key={col.title} className={ci > 0 ? "hidden sm:block" : undefined}>
            <div className="mb-3 text-[11px] font-semibold tracking-[0.08em] text-[var(--lp-muted)]">
              {col.title} <span className="text-[var(--lp-text)]">{col.cards.length}</span>
            </div>
            <div className="space-y-3">
              {col.cards.map((card) => (
                <div
                  key={card.table}
                  className={[
                    "rounded-[14px] border bg-[var(--lp-surface)] p-3.5",
                    card.running ? "border-[rgba(245,158,11,0.45)]" : "border-[var(--lp-line)]",
                  ].join(" ")}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[14px] font-semibold">{card.table}</span>
                    <span className={["text-[11px]", card.running ? "text-[var(--lp-amber)]" : "text-[var(--lp-faint)]"].join(" ")}>
                      {card.meta}
                    </span>
                  </div>
                  {card.rounds.map((r) => (
                    <div key={r.name} className="mt-2.5">
                      <div className="text-[10px] font-semibold tracking-[0.08em] text-[var(--lp-faint)]">{r.name}</div>
                      {r.items.map(([q, n, v]) => (
                        <div key={n + v} className="mt-1 text-[12.5px]">
                          <span className="font-semibold">{q}×</span> {n}
                          {v && <span className="text-[var(--lp-muted)]">, {v}</span>}
                        </div>
                      ))}
                    </div>
                  ))}
                  <div className="mt-3 flex items-center justify-between border-t border-[var(--lp-line)] pt-2.5">
                    <span className="text-[12.5px] font-semibold">{card.total}</span>
                    <span className="rounded-full bg-[var(--lp-raised)] px-3 py-1 text-[11.5px] font-semibold text-[var(--lp-text)]">
                      {card.action}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The three print jobs, hung on a ticket rail the way they would be in a
 * kitchen. Same token number on the slip and the ticket, so the counter and
 * the kitchen are talking about the same order.
 */
export function TicketRail({ jobs }: { jobs: { name: string; note: string }[] }) {
  return (
    <div>
      <div aria-hidden="true" className="relative">
        <div className="h-[10px] rounded-full border border-[#343849] bg-gradient-to-b from-[#3a3e50] to-[#20222c]" />
        <div className="-mt-[3px] grid grid-cols-2 items-start gap-3 sm:grid-cols-3 sm:gap-5">
          {/* Token slip */}
          <div className="lp-paper px-3 pt-4 text-center">
            <div className="text-[10.5px]">Kumar Coffee House</div>
            <div className="text-[10.5px]">your token</div>
            <div className="my-1 font-display text-[44px] font-bold leading-none tracking-tight sm:text-[56px]">42</div>
            <div className="text-[10.5px]">Table 4</div>
            <div className="lp-paper-rule my-2" />
            <div className="text-[10px]">19:42</div>
          </div>

          {/* Kitchen ticket */}
          <KitchenTicket
            className="!text-[11px] !px-3"
            ticket={{
              token: "42",
              table: "Table 4",
              round: "Round 1",
              time: "19:42",
              items: [
                { qty: 2, name: "Masala dosa", note: "less spicy" },
                { qty: 1, name: "Filter coffee", note: "Double" },
              ],
            }}
          />

          {/* Bill */}
          <div className="lp-paper hidden px-3 pt-4 !text-[11px] sm:block">
            <div className="text-center font-bold">BILL</div>
            <div className="text-center text-[10px]">Table 4, token 42</div>
            <div className="lp-paper-rule my-2" />
            {[
              ["2 Masala dosa", "280"],
              ["1 Filter coffee", "95"],
              ["1 Filter coffee", "60"],
            ].map(([n, p], i) => (
              <div key={i} className="flex justify-between gap-2">
                <span className="truncate">{n}</span>
                <span>{p}</span>
              </div>
            ))}
            <div className="lp-paper-rule my-2" />
            <div className="flex justify-between"><span>GST 5%</span><span>21.75</span></div>
            <div className="flex justify-between font-bold"><span>Total</span><span>₹456.75</span></div>
          </div>
        </div>
      </div>

      <dl className="mt-6 grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 sm:gap-5">
        {jobs.map((job) => (
          <div key={job.name}>
            <dt className="text-[14.5px] font-semibold text-[var(--lp-text)]">{job.name}</dt>
            <dd className="mt-1 text-[13px] leading-snug text-[var(--lp-muted)]">{job.note}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/*
 * A QR-shaped pattern for the illustration. Deliberately not a real code —
 * a decorative one that scanned to nowhere would be a broken promise on a
 * page about scanning.
 */
function qrCells(size = 21): boolean[][] {
  let seed = 7;
  const rand = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const grid = Array.from({ length: size }, () => Array.from({ length: size }, () => rand() > 0.52));
  const finder = (r0: number, c0: number) => {
    for (let r = -1; r < 8; r++)
      for (let c = -1; c < 8; c++) {
        const rr = r0 + r;
        const cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const ring = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        grid[rr]![cc] = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (ring || core);
      }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);
  return grid;
}

/** An acrylic table stand with a table card in it. */
export function TableStand() {
  const cells = qrCells();
  return (
    <div aria-hidden="true" className="relative mx-auto w-[260px] sm:w-[300px]">
      <div className="relative rounded-[22px] border border-white/20 bg-white/[0.06] p-3 shadow-[0_50px_80px_-40px_rgba(0,0,0,0.95),inset_0_1px_0_rgba(255,255,255,0.25)] backdrop-blur-sm">
        <div className="rounded-[14px] bg-[#fbfaf7] px-6 pb-6 pt-6 text-center text-[#17171a]">
          <div className="font-[Fraunces,serif] text-[22px] font-semibold leading-tight">Kumar Coffee House</div>
          <div className="mt-1 text-[12px] text-[#6b6b73]">Table 4</div>
          <svg viewBox="0 0 21 21" className="mx-auto mt-5 h-[150px] w-[150px]" shapeRendering="crispEdges">
            {cells.flatMap((row, r) =>
              row.map((on, c) => (on ? <rect key={`${r}-${c}`} x={c} y={r} width="1" height="1" fill="#17171a" /> : null)),
            )}
          </svg>
          <div className="mt-5 text-[14px] font-semibold">Scan to order</div>
          <div className="mt-0.5 text-[11.5px] text-[#6b6b73]">No app needed</div>
        </div>
      </div>
      {/* The stand's foot */}
      <div className="mx-auto h-[14px] w-[78%] rounded-b-[10px] border border-t-0 border-white/15 bg-white/[0.05]" />
      <div className="mx-auto mt-2 h-6 w-[90%] rounded-[50%] bg-black/60 blur-xl" />
    </div>
  );
}
