/**
 * The three theme knobs an owner controls: layout, accent, font pairing.
 *
 * Deliberately a closed set. Constrained enough that every menu on the
 * platform looks composed; expressive enough that an owner feels it is theirs.
 * Hierarchy is carried by type and space — the accent is a highlight, never
 * a background wash.
 */

export const THEME_LAYOUTS = ["editorial", "compact", "grid"] as const;
export type ThemeLayout = (typeof THEME_LAYOUTS)[number];

export interface LayoutMeta {
  id: ThemeLayout;
  name: string;
  /** Shown under the name in the template picker. */
  blurb: string;
  /** Who this layout is actually for. */
  suits: string;
  /** Whether item photography drives the layout. */
  photoLed: boolean;
}

export const LAYOUT_META: Record<ThemeLayout, LayoutMeta> = {
  editorial: {
    id: "editorial",
    name: "Editorial",
    blurb: "Large photography, generous whitespace, one dish per row.",
    suits: "Places whose food photographs well",
    photoLed: true,
  },
  compact: {
    id: "compact",
    name: "Compact",
    blurb: "Dense two-line rows with a sticky category rail. Fast to scan.",
    suits: "Cinema concessions and high-volume cafes",
    photoLed: false,
  },
  grid: {
    id: "grid",
    name: "Grid",
    blurb: "Photo-forward cards, two across on mobile.",
    suits: "Broad menus with strong visuals",
    photoLed: true,
  },
};

export interface AccentMeta {
  id: string;
  name: string;
  /** Base accent. Must clear 4.5:1 on the light surface for body-size text. */
  hex: string;
  /** Darker step for text on tinted chips. */
  hexStrong: string;
  /** Very light tint for chips and selected states. */
  hexSoft: string;
}

export const ACCENTS: AccentMeta[] = [
  { id: "amber", name: "Amber", hex: "#9A6700", hexStrong: "#7A5100", hexSoft: "#FBF0DC" },
  { id: "pine", name: "Pine", hex: "#1D6F5C", hexStrong: "#155245", hexSoft: "#E6F2EE" },
  { id: "terracotta", name: "Terracotta", hex: "#B4532A", hexStrong: "#8A3F20", hexSoft: "#FAEDE7" },
  { id: "ink", name: "Ink", hex: "#274472", hexStrong: "#1B3153", hexSoft: "#E9EEF6" },
  { id: "burgundy", name: "Burgundy", hex: "#8C2F39", hexStrong: "#6B222A", hexSoft: "#F8EAEC" },
  { id: "plum", name: "Plum", hex: "#6B3A73", hexStrong: "#512B57", hexSoft: "#F3EAF5" },
];

export const DEFAULT_ACCENT = ACCENTS[0]!.hex;

export interface FontPairing {
  id: string;
  name: string;
  /** Headings and the business name. */
  display: string;
  /** Item names, prices, body copy. */
  body: string;
  /** Google Fonts family query, appended to the stylesheet href. */
  googleQuery: string;
  displayStack: string;
  bodyStack: string;
}

export const FONT_PAIRINGS: FontPairing[] = [
  {
    id: "inter-fraunces",
    name: "Warm editorial",
    display: "Fraunces",
    body: "Inter",
    googleQuery:
      "family=Fraunces:opsz,wght@9..144,400;9..144,600&family=Inter:wght@400;500;600",
    displayStack: '"Fraunces", ui-serif, Georgia, serif',
    bodyStack: '"Inter", ui-sans-serif, system-ui, -apple-system, sans-serif',
  },
  {
    id: "dmserif-inter",
    name: "Classic plate",
    display: "DM Serif Display",
    body: "Inter",
    googleQuery:
      "family=DM+Serif+Display:ital@0;1&family=Inter:wght@400;500;600",
    displayStack: '"DM Serif Display", ui-serif, Georgia, serif',
    bodyStack: '"Inter", ui-sans-serif, system-ui, -apple-system, sans-serif',
  },
  {
    id: "outfit-outfit",
    name: "Modern counter",
    display: "Outfit",
    body: "Outfit",
    googleQuery: "family=Outfit:wght@300;400;500;600;700",
    displayStack: '"Outfit", ui-sans-serif, system-ui, sans-serif',
    bodyStack: '"Outfit", ui-sans-serif, system-ui, sans-serif',
  },
  {
    id: "playfair-lato",
    name: "Fine dining",
    display: "Playfair Display",
    body: "Lato",
    googleQuery:
      "family=Playfair+Display:wght@500;600;700&family=Lato:wght@400;700",
    displayStack: '"Playfair Display", ui-serif, Georgia, serif',
    bodyStack: '"Lato", ui-sans-serif, system-ui, sans-serif',
  },
  {
    id: "spacegrotesk-inter",
    name: "Contemporary",
    display: "Space Grotesk",
    body: "Inter",
    googleQuery:
      "family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600",
    displayStack: '"Space Grotesk", ui-sans-serif, system-ui, sans-serif',
    bodyStack: '"Inter", ui-sans-serif, system-ui, -apple-system, sans-serif',
  },
];

export const DEFAULT_FONT_PAIRING = FONT_PAIRINGS[0]!.id;

export function findAccent(hex: string): AccentMeta {
  return ACCENTS.find((a) => a.hex.toLowerCase() === hex.toLowerCase()) ?? ACCENTS[0]!;
}

export function findFontPairing(id: string): FontPairing {
  return FONT_PAIRINGS.find((f) => f.id === id) ?? FONT_PAIRINGS[0]!;
}

/**
 * Resolve the three tokens into the CSS custom properties the public menu
 * templates read. Returned as a plain object so it can go straight into a
 * React `style` prop.
 */
export function themeCssVars(accentHex: string, fontPairingId: string): Record<string, string> {
  const accent = findAccent(accentHex);
  const font = findFontPairing(fontPairingId);
  return {
    "--accent": accent.hex,
    "--accent-strong": accent.hexStrong,
    "--accent-soft": accent.hexSoft,
    "--font-display": font.displayStack,
    "--font-body": font.bodyStack,
  };
}

export function googleFontsHref(fontPairingId: string): string {
  const font = findFontPairing(fontPairingId);
  return `https://fonts.googleapis.com/css2?${font.googleQuery}&display=swap`;
}
