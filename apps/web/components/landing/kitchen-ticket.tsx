/**
 * Thermal paper, laid out the way the real ESC/POS kitchen ticket is: token
 * and table on top, dishes with their notes, and nothing about money —
 * the kitchen ticket never carries prices.
 */
export interface Ticket {
  token: string;
  table: string;
  round: string;
  time: string;
  items: { qty: number; name: string; note?: string }[];
}

export function KitchenTicket({ ticket, className }: { ticket: Ticket; className?: string }) {
  return (
    <div className={["lp-paper px-4 pt-4", className].filter(Boolean).join(" ")}>
      <div className="flex items-baseline justify-between">
        <span className="font-bold tracking-wide">KOT</span>
        <span className="font-bold">#{ticket.token}</span>
      </div>
      <div className="mt-0.5 flex items-baseline justify-between text-[11.5px]">
        <span>{ticket.table}</span>
        <span>{ticket.time}</span>
      </div>
      <div className="text-[11.5px]">{ticket.round}</div>
      <div className="lp-paper-rule my-2.5" />
      <ul className="space-y-1.5">
        {ticket.items.map((item) => (
          <li key={item.name + (item.note ?? "")}>
            <div className="flex gap-3">
              <span className="w-4 shrink-0 font-bold">{item.qty}</span>
              <span className="font-bold">{item.name}</span>
            </div>
            {item.note && <div className="pl-7 text-[11.5px]">{item.note}</div>}
          </li>
        ))}
      </ul>
      <div className="lp-paper-rule my-2.5" />
      <div className="text-center text-[11px]">token {ticket.token}</div>
    </div>
  );
}
