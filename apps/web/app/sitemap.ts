import type { MetadataRoute } from "next";
import { LOCALE_PATH } from "@/i18n/locales";
import { SITE_URL } from "@/lib/site";

/** The two landing pages, each pointing at the other as its translation. */
export default function sitemap(): MetadataRoute.Sitemap {
  const languages = {
    en: `${SITE_URL}${LOCALE_PATH.en}`,
    hi: `${SITE_URL}${LOCALE_PATH.hi}`,
  };
  return [
    { url: languages.en, changeFrequency: "monthly", priority: 1, alternates: { languages } },
    { url: languages.hi, changeFrequency: "monthly", priority: 0.9, alternates: { languages } },
  ];
}
