export interface Country {
  code: string;
  name: string;
  dial: string;
  flag: string;
}

/**
 * A curated list rather than all 249 ISO entries.
 *
 * The full set would need a metadata library on a signup form that mostly
 * serves one country. India leads because that is the market; the rest cover
 * the diaspora and common travel origins. The field still accepts a typed
 * +country code for anywhere not listed.
 */
export const COUNTRIES: Country[] = [
  { code: "IN", name: "India", dial: "+91", flag: "🇮🇳" },
  { code: "AE", name: "United Arab Emirates", dial: "+971", flag: "🇦🇪" },
  { code: "GB", name: "United Kingdom", dial: "+44", flag: "🇬🇧" },
  { code: "US", name: "United States", dial: "+1", flag: "🇺🇸" },
  { code: "CA", name: "Canada", dial: "+1", flag: "🇨🇦" },
  { code: "AU", name: "Australia", dial: "+61", flag: "🇦🇺" },
  { code: "SG", name: "Singapore", dial: "+65", flag: "🇸🇬" },
  { code: "MY", name: "Malaysia", dial: "+60", flag: "🇲🇾" },
  { code: "SA", name: "Saudi Arabia", dial: "+966", flag: "🇸🇦" },
  { code: "QA", name: "Qatar", dial: "+974", flag: "🇶🇦" },
  { code: "NP", name: "Nepal", dial: "+977", flag: "🇳🇵" },
  { code: "LK", name: "Sri Lanka", dial: "+94", flag: "🇱🇰" },
  { code: "BD", name: "Bangladesh", dial: "+880", flag: "🇧🇩" },
  { code: "DE", name: "Germany", dial: "+49", flag: "🇩🇪" },
  { code: "FR", name: "France", dial: "+33", flag: "🇫🇷" },
  { code: "NZ", name: "New Zealand", dial: "+64", flag: "🇳🇿" },
];

export const DEFAULT_COUNTRY = "IN";

export function findCountry(code: string): Country {
  return COUNTRIES.find((c) => c.code === code) ?? COUNTRIES[0]!;
}

/**
 * Best guess at the visitor's country without asking for permission.
 *
 * `navigator.geolocation` would raise a browser prompt on a signup form to
 * learn something the timezone already implies — a bad trade. On Vercel the
 * server passes down the edge geo header, which is better still; this is the
 * client-side fallback for local development and other hosts.
 */
export function guessCountryClient(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
    const byZone: Record<string, string> = {
      "Asia/Kolkata": "IN",
      "Asia/Calcutta": "IN",
      "Asia/Dubai": "AE",
      "Asia/Singapore": "SG",
      "Asia/Kuala_Lumpur": "MY",
      "Asia/Kathmandu": "NP",
      "Asia/Colombo": "LK",
      "Asia/Dhaka": "BD",
      "Asia/Riyadh": "SA",
      "Asia/Qatar": "QA",
      "Europe/London": "GB",
      "Europe/Berlin": "DE",
      "Europe/Paris": "FR",
    };
    if (byZone[tz]) return byZone[tz]!;

    if (tz.startsWith("America/")) return "US";
    if (tz.startsWith("Australia/")) return "AU";
    if (tz.startsWith("Pacific/Auckland")) return "NZ";
    if (tz.startsWith("Europe/")) return "GB";
  } catch {
    // Locked-down browser: fall through to the default.
  }
  return DEFAULT_COUNTRY;
}

/** True when the typed value looks like a phone number rather than an email. */
export function looksLikePhone(value: string): boolean {
  const v = value.trim();
  if (v.includes("@")) return false;
  return /^[+()\d][\d\s\-().]*$/.test(v) && /\d/.test(v);
}
