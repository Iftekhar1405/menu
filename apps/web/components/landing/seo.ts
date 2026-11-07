import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { LOCALE_PATH, LOCALE_TAG, type Locale } from "@/i18n/locales";
import { BRAND_NAME, COMPANY_NAME, COMPANY_URL, LEGACY_BRAND_NAMES, SITE_URL, TOUR } from "@/lib/site";

/** Title, description, canonical, hreflang alternates and social cards. */
export async function landingMetadata(locale: Locale): Promise<Metadata> {
  const t = await getTranslations({ locale, namespace: "meta" });
  const path = LOCALE_PATH[locale];
  const title = `${BRAND_NAME}: ${t("title")}`;

  return {
    metadataBase: new URL(SITE_URL),
    // `absolute` so the root layout's "%s · …" template does not append
    // the brand a second time.
    title: { absolute: title },
    description: t("description"),
    alternates: {
      canonical: path,
      languages: {
        en: LOCALE_PATH.en,
        hi: LOCALE_PATH.hi,
        "x-default": LOCALE_PATH.en,
      },
    },
    openGraph: {
      type: "website",
      url: path,
      siteName: BRAND_NAME,
      title,
      description: t("description"),
      locale: LOCALE_TAG[locale],
      alternateLocale: Object.values(LOCALE_TAG).filter((tag) => tag !== LOCALE_TAG[locale]),
      videos: [{ url: new URL(TOUR.src, SITE_URL).toString(), type: "video/mp4", width: 1280, height: 720 }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: t("description"),
    },
    robots: { index: true, follow: true },
    keywords: [
      "digital menu",
      "QR menu",
      "QR code menu for restaurant",
      "table ordering",
      "restaurant ordering system",
      "kitchen order ticket",
      "KOT printing",
      "thermal printer",
      "cafe menu",
      "restaurant POS India",
      BRAND_NAME,
      ...LEGACY_BRAND_NAMES,
    ],
  };
}

/**
 * schema.org for the landing page: the organisation, the site, the product
 * as a web application, the tour as a video, and the FAQ.
 */
export function landingJsonLd({
  locale,
  description,
  tourName,
  tourDescription,
  faqs,
}: {
  locale: Locale;
  description: string;
  tourName: string;
  tourDescription: string;
  faqs: { q: string; a: string }[];
}) {
  const url = new URL(LOCALE_PATH[locale], SITE_URL).toString();
  const org = { "@type": "Organization", "@id": `${COMPANY_URL}/#org`, name: COMPANY_NAME, url: COMPANY_URL };

  return {
    "@context": "https://schema.org",
    "@graph": [
      org,
      {
        "@type": "WebSite",
        "@id": `${SITE_URL}/#website`,
        url: SITE_URL,
        name: BRAND_NAME,
        // The old name, so searches for it still find the product.
        alternateName: [...LEGACY_BRAND_NAMES],
        inLanguage: ["en", "hi"],
        publisher: { "@id": org["@id"] },
      },
      {
        "@type": "WebApplication",
        "@id": `${SITE_URL}/#app`,
        name: BRAND_NAME,
        alternateName: [...LEGACY_BRAND_NAMES],
        url: SITE_URL,
        description,
        applicationCategory: "BusinessApplication",
        applicationSubCategory: "Restaurant ordering",
        operatingSystem: "Web browser",
        browserRequirements: "Requires a modern browser. Printing requires Chrome or Edge.",
        inLanguage: locale,
        featureList: [
          "Digital menu with QR codes per table",
          "Ordering from the table without an app",
          "Live orders board",
          "Kitchen ticket, token slip and bill printing on thermal printers",
          "Bills on the diner's phone",
          "Staff logins for the kitchen",
        ],
        publisher: { "@id": org["@id"] },
      },
      {
        "@type": "VideoObject",
        name: tourName,
        description: tourDescription,
        thumbnailUrl: new URL(TOUR.poster, SITE_URL).toString(),
        contentUrl: new URL(TOUR.src, SITE_URL).toString(),
        uploadDate: TOUR.uploadDate,
        duration: TOUR.duration,
        inLanguage: "hi",
      },
      {
        "@type": "FAQPage",
        url,
        inLanguage: locale,
        mainEntity: faqs.map((f) => ({
          "@type": "Question",
          name: f.q,
          acceptedAnswer: { "@type": "Answer", text: f.a },
        })),
      },
    ],
  };
}
