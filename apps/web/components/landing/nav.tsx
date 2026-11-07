"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Mark } from "@/components/brand";
import { BRAND_NAME } from "@/lib/site";

export interface NavLabels {
  how: string;
  features: string;
  tour: string;
  faq: string;
  signIn: string;
  startFree: string;
  openMenu: string;
  closeMenu: string;
  switchLanguage: string;
  switchLanguageLabel: string;
  skip: string;
}

export function LandingNav({
  labels,
  switchHref,
  switchLang,
}: {
  labels: NavLabels;
  /** The same page in the other language. */
  switchHref: string;
  switchLang: string;
}) {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const sections = [
    { href: "#how", label: labels.how },
    { href: "#features", label: labels.features },
    { href: "#tour", label: labels.tour },
    { href: "#faq", label: labels.faq },
  ];

  return (
    <>
      <a href="#main" className="lp-skip">
        {labels.skip}
      </a>
      <header
        className="lp-nav fixed inset-x-0 top-0 z-50 pt-[env(safe-area-inset-top,0px)]"
        data-scrolled={scrolled || open}
      >
        <nav className="lp-wrap flex h-[68px] items-center justify-between gap-6" aria-label="Primary">
          <Link href="/" className="flex items-center gap-2.5 rounded-md" aria-label={BRAND_NAME}>
            <span className="rounded-[8px] ring-1 ring-white/15">
              <Mark size={26} />
            </span>
            <span className="font-display text-[19px] font-semibold tracking-tight text-[var(--lp-text)]">
              supermenu<span className="text-[var(--lp-faint)]">.irad</span>
            </span>
          </Link>

          <ul className="hidden items-center gap-8 text-[14.5px] lg:flex">
            {sections.map((s) => (
              <li key={s.href}>
                <a href={s.href} className="lp-link">
                  {s.label}
                </a>
              </li>
            ))}
          </ul>

          <div className="flex items-center gap-2 sm:gap-3">
            <Link
              href={switchHref}
              hrefLang={switchLang}
              lang={switchLang}
              aria-label={labels.switchLanguageLabel}
              className="lp-link hidden px-2 text-[14.5px] sm:inline"
            >
              {labels.switchLanguage}
            </Link>
            <Link href="/login" className="lp-link hidden px-2 text-[14.5px] sm:inline">
              {labels.signIn}
            </Link>
            <Link href="/signup" className="lp-btn lp-btn-primary lp-btn-sm">
              {labels.startFree}
            </Link>
            <button
              type="button"
              className="grid h-10 w-10 place-items-center rounded-[10px] border border-[var(--lp-line)] text-[var(--lp-text)] lg:hidden"
              aria-expanded={open}
              aria-controls="lp-mobile-nav"
              aria-label={open ? labels.closeMenu : labels.openMenu}
              onClick={() => setOpen((o) => !o)}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 8h16M4 16h16" />}
              </svg>
            </button>
          </div>
        </nav>

        {open && (
          <div id="lp-mobile-nav" className="lp-wrap pb-6 lg:hidden">
            <ul className="flex flex-col border-t border-[var(--lp-line-soft)] pt-2 text-[17px]">
              {sections.map((s) => (
                <li key={s.href}>
                  <a href={s.href} className="block py-3 text-[var(--lp-text)]" onClick={() => setOpen(false)}>
                    {s.label}
                  </a>
                </li>
              ))}
              <li className="mt-2 flex gap-5 border-t border-[var(--lp-line-soft)] pt-4 text-[15px]">
                <Link href="/login" className="lp-link">
                  {labels.signIn}
                </Link>
                <Link href={switchHref} hrefLang={switchLang} lang={switchLang} className="lp-link">
                  {labels.switchLanguage}
                </Link>
              </li>
            </ul>
          </div>
        )}
      </header>
    </>
  );
}
