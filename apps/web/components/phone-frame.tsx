"use client";

/**
 * A phone with the diner's actual menu inside it.
 *
 * This is the one piece of visual indulgence in the product, and it earns its
 * place: an owner building a menu is designing something that will only ever
 * be read on a phone held at a table. Without seeing it that way they are
 * guessing — about line lengths, about whether a dish name wraps, about
 * whether the photo they chose reads at that size. Everything else in the
 * dashboard is deliberately plain so this can carry the weight.
 *
 * Scaled with CSS transform rather than a real viewport, so it stays cheap
 * enough to re-render on every keystroke in the builder.
 */
export function PhoneFrame({
  children,
  label,
  scale = 1,
}: {
  children: React.ReactNode;
  label?: string;
  scale?: number;
}) {
  const W = 320;
  const H = 660;

  return (
    <div className="flex flex-col items-center">
      <div
        style={{
          width: W * scale,
          height: H * scale,
        }}
      >
        <div
          style={{
            width: W,
            height: H,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
          }}
          className="relative rounded-[42px] bg-[#101014] p-[10px] shadow-[0_24px_60px_-20px_rgba(17,17,19,0.45)]"
        >
          <div className="relative h-full w-full overflow-hidden rounded-[33px] bg-white">
            {/* Status bar. Present because its absence is what makes a mockup
                look like a mockup rather than a phone. */}
            <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex h-11 items-center justify-between px-6 text-[12px] font-semibold text-[#17171a]">
              <span className="tnum">9:41</span>
              <span className="flex items-center gap-1" aria-hidden="true">
                <svg width="17" height="11" viewBox="0 0 17 11" fill="currentColor">
                  <rect x="0" y="7" width="3" height="4" rx="1" />
                  <rect x="4.5" y="5" width="3" height="6" rx="1" />
                  <rect x="9" y="2.5" width="3" height="8.5" rx="1" />
                  <rect x="13.5" y="0" width="3" height="11" rx="1" opacity="0.35" />
                </svg>
                <svg width="25" height="12" viewBox="0 0 25 12" fill="none">
                  <rect x="0.5" y="0.5" width="20" height="11" rx="3" stroke="currentColor" opacity="0.4" />
                  <rect x="2" y="2" width="15" height="8" rx="1.5" fill="currentColor" />
                  <path d="M22 4v4a2 2 0 0 0 0-4Z" fill="currentColor" opacity="0.4" />
                </svg>
              </span>
            </div>

            <div className="scroll-quiet h-full overflow-y-auto pt-11">{children}</div>

            {/* Home indicator */}
            <div className="pointer-events-none absolute inset-x-0 bottom-1.5 flex justify-center">
              <div className="h-[5px] w-[110px] rounded-full bg-[#17171a] opacity-25" />
            </div>
          </div>
        </div>
      </div>

      {label && <p className="mt-3 text-[12px] text-faint">{label}</p>}
    </div>
  );
}
