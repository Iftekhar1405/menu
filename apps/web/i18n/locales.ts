/**
 * Locales the marketing page is published in.
 *
 * Only the logged-out landing page is translated. The dashboard stays in
 * English, so nothing outside `app/(marketing)` reads these.
 */
export const LOCALES = ["en", "hi"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Where each locale's landing page lives. English owns the bare root. */
export const LOCALE_PATH: Record<Locale, string> = { en: "/", hi: "/hi" };

/** BCP 47 tags for Open Graph and `hreflang`. */
export const LOCALE_TAG: Record<Locale, string> = { en: "en_IN", hi: "hi_IN" };
