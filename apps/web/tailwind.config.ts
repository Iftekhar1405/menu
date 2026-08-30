import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Product chrome is achromatic by design: the tenant's accent is the
        // only colour in the interface. See ink/paper scales in globals.css.
        paper: "var(--paper)",
        surface: "var(--surface)",
        raised: "var(--raised)",
        line: "var(--line)",
        ink: "var(--ink)",
        muted: "var(--muted)",
        faint: "var(--faint)",
        accent: "var(--accent)",
        "accent-strong": "var(--accent-strong)",
        "accent-soft": "var(--accent-soft)",
      },
      fontFamily: {
        display: ["var(--font-display)"],
        body: ["var(--font-body)"],
      },
      borderRadius: { xl: "14px", "2xl": "20px" },
      boxShadow: {
        card: "0 1px 2px rgba(17,17,19,0.04), 0 1px 1px rgba(17,17,19,0.03)",
        lift: "0 8px 24px -8px rgba(17,17,19,0.14)",
      },
    },
  },
  plugins: [],
} satisfies Config;
