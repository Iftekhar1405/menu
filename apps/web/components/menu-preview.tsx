"use client";

import { useState } from "react";
import { Button, Sheet } from "@/components/ui";
import { PhoneFrame } from "@/components/phone-frame";
import { MenuView } from "@/components/templates";
import type { PublicMenu } from "@menu/shared";

/**
 * The diner's menu, shown to the owner building it.
 *
 * On a desktop this is a phone drawn on the page, because the owner is
 * designing something they will never see at the size it gets read. On a
 * phone that reasoning inverts: they are already holding the device, so
 * drawing a phone inside it would shrink the very thing the preview exists
 * to show. There it opens full-bleed instead, at the real width, with real
 * scrolling — which is not a preview of the menu so much as the menu.
 */
export function PreviewButton({ menu }: { menu: PublicMenu | null }) {
  const [open, setOpen] = useState(false);

  if (!menu) return null;

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Preview
      </Button>

      {open && (
        <Sheet label="Preview" onClose={() => setOpen(false)} className="h-full">
          <header className="chrome-blur pt-safe flex shrink-0 items-center justify-between border-b border-line px-5">
            <h2 className="font-display text-[16px] font-semibold">
              What diners see
            </h2>
            <button
              onClick={() => setOpen(false)}
              className="h-14 px-2 text-[14px] font-medium text-[var(--accent-strong)]"
            >
              Done
            </button>
          </header>

          <div className="scroll-quiet overscroll-contain-y flex-1 overflow-y-auto bg-white">
            <MenuView menu={menu} />
          </div>
        </Sheet>
      )}
    </>
  );
}

/**
 * The desktop rail. Sticky, full-height, and hidden below the width where
 * there is room for it alongside the controls — at which point PreviewButton
 * takes over.
 */
export function PreviewRail({
  menu,
  label,
  scale = 0.8,
  className,
}: {
  menu: PublicMenu | null;
  label?: string;
  scale?: number;
  className?: string;
}) {
  return (
    <aside className={className}>
      <div className="sticky top-0 flex h-[100dvh] flex-col items-center justify-center px-6">
        {menu && (
          <PhoneFrame scale={scale} label={label}>
            <MenuView menu={menu} compactChrome />
          </PhoneFrame>
        )}
      </div>
    </aside>
  );
}
