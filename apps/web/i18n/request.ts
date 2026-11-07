import { getRequestConfig } from "next-intl/server";
import { DEFAULT_LOCALE, isLocale } from "./locales";

/*
 * No middleware and no `[locale]` segment: the landing pages set their locale
 * with `setRequestLocale`, and anything else that ever asks gets English.
 * That keeps every existing route exactly where it is.
 */
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = isLocale(requested) ? requested : DEFAULT_LOCALE;
  const messages = (await import(`../messages/${locale}`)).default;
  return { locale, messages };
});
