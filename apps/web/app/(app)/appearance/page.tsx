"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ACCENTS,
  FONT_PAIRINGS,
  LAYOUT_META,
  THEME_LAYOUTS,
  type ThemeLayout,
} from "@menu/shared";
import { ApiError, api } from "@/lib/api-client";
import { toPreviewMenu } from "@/lib/preview";
import { sampleMenu } from "@/lib/sample-menu";
import type { Category } from "@/lib/types";
import { useSession } from "@/components/session";
import { PreviewButton, PreviewRail } from "@/components/menu-preview";
import { Banner, Button, cx } from "@/components/ui";
import { ThemeToggle } from "@/components/theme-toggle";

export default function AppearancePage() {
  const { current, refreshBusinesses } = useSession();
  const [categories, setCategories] = useState<Category[]>([]);
  const [layout, setLayout] = useState<ThemeLayout>("editorial");
  const [accent, setAccent] = useState<string>(ACCENTS[0]!.hex);
  const [font, setFont] = useState<string>(FONT_PAIRINGS[0]!.id);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!current) return;
    setLayout(current.themeLayout);
    setAccent(current.themeAccent);
    setFont(current.themeFont);
    const data = await api.get<Category[]>(`/businesses/${current.id}/menu`);
    setCategories(data);
  }, [current]);

  useEffect(() => {
    void load();
  }, [load]);

  const preview = useMemo(() => {
    if (!current) return null;
    const hasItems = categories.some((c) => c.items.length > 0);
    if (!hasItems) return sampleMenu({ layout, accent, fontPairing: font });
    return toPreviewMenu(current, categories, { layout, accent, fontPairing: font });
  }, [current, categories, layout, accent, font]);

  if (!current) return null;

  const dirty =
    layout !== current.themeLayout ||
    accent !== current.themeAccent ||
    font !== current.themeFont;

  async function save() {
    if (!current) return;
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/businesses/${current.id}`, {
        themeLayout: layout,
        themeAccent: accent,
        themeFont: font,
      });
      await refreshBusinesses();
      setSaved(true);
      setTimeout(() => setSaved(false), 2200);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save your appearance settings. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="lg:grid lg:min-h-[100dvh] lg:grid-cols-[minmax(0,1fr)_400px]">
      <div className="mx-auto w-full max-w-2xl px-5 py-8 sm:px-6 sm:py-10 lg:px-10 lg:py-12">
        <header className="mb-8 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[26px] font-semibold leading-tight tracking-tight sm:text-[30px]">
              Appearance
            </h1>
            <p className="mt-1 text-[14.5px] text-muted">
              Customise how your dashboard and menu look.
            </p>
          </div>
          <div className="shrink-0 lg:hidden">
            <PreviewButton menu={preview} />
          </div>
        </header>

        {error && <div className="mb-6"><Banner>{error}</Banner></div>}

        {/* ── Dashboard appearance ─────────────────────────────────────── */}
        <section className="mb-9">
          <ThemeToggle />
        </section>

        {/* ── Menu layout ──────────────────────────────────────────────── */}
        {/* ── Menu accent ──────────────────────────────────────────────── */}
        <section className="mb-9">
          <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.12em] text-faint">
            Menu Accent
          </h2>
          <div className="flex flex-wrap gap-2.5">
            {ACCENTS.map((a) => (
              <button
                key={a.id}
                onClick={() => setAccent(a.hex)}
                aria-pressed={accent === a.hex}
                aria-label={a.name}
                title={a.name}
                className={cx(
                  "spring h-11 w-11 rounded-full border-2",
                  accent === a.hex
                    ? "border-ink scale-110"
                    : "border-transparent hover:scale-105",
                )}
                style={{ background: a.hex }}
              />
            ))}
          </div>
          <p className="hidden">
            This colours your public menu only — use the Dashboard Theme above for the admin panel.
          </p>
        </section>

        {/* ── Menu typography ──────────────────────────────────────────── */}
        <section className="mb-9">
          <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.12em] text-faint">
            Menu Layout
          </h2>
          <div className="space-y-2">
            {THEME_LAYOUTS.map((id) => {
              const meta = LAYOUT_META[id];
              const active = layout === id;
              return (
                <button
                  key={id}
                  onClick={() => setLayout(id)}
                  aria-pressed={active}
                  className={cx(
                    "spring block w-full rounded-2xl border p-4 text-left",
                    active
                      ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                      : "border-line bg-surface hover:border-[var(--accent-soft)] hover:bg-raised",
                  )}
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="font-display text-[15px] font-semibold text-ink">
                      {meta.name}
                    </span>
                    <span className="text-[12px] text-muted">{meta.suits}</span>
                  </span>
                  <span className="mt-1 block text-[13.5px] leading-relaxed text-muted">
                    {meta.blurb}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="mb-9">
          <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.12em] text-faint">
            Menu Typography
          </h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {FONT_PAIRINGS.map((f) => (
              <button
                key={f.id}
                onClick={() => setFont(f.id)}
                aria-pressed={font === f.id}
                className={cx(
                  "spring rounded-2xl border p-3.5 text-left",
                  font === f.id
                    ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                    : "border-line bg-surface hover:border-[var(--accent-soft)] hover:bg-raised",
                )}
              >
                <span
                  className="block text-[19px] leading-tight text-ink"
                  style={{ fontFamily: f.displayStack }}
                >
                  {f.name}
                </span>
                <span className="mt-0.5 block text-[12.5px] text-muted">
                  {f.display} with {f.body}
                </span>
              </button>
            ))}
          </div>
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            className="w-full sm:w-auto"
            onClick={() => void save()}
            loading={saving}
            disabled={!dirty}
          >
            {dirty ? "Save changes" : "Saved"}
          </Button>
          {saved && <span className="text-[13.5px] text-muted">Your menu is updated.</span>}
        </div>
      </div>

      <PreviewRail
        menu={preview}
        scale={0.82}
        className="hidden border-l border-line bg-surface lg:block"
      />
    </div>
  );
}
