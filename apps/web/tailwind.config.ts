import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        paper:   "var(--paper)",
        surface: "var(--surface)",
        raised:  "var(--raised)",
        line:    "var(--line)",
        ink:     "var(--ink)",
        muted:   "var(--muted)",
        faint:   "var(--faint)",
        accent:  "var(--accent)",
        "accent-strong": "var(--accent-strong)",
        "accent-soft":   "var(--accent-soft)",
      },
      fontFamily: {
        display: ["var(--font-display)"],
        body:    ["var(--font-body)"],
      },
      borderRadius: {
        xl:  "14px",
        "2xl": "20px",
      },
      boxShadow: {
        card: "0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)",
        lift: "0 8px 30px -8px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.06)",
        glow: "0 0 20px var(--accent-glow)",
      },
      animation: {
        "float-up": "float-up 240ms cubic-bezier(0.22, 1, 0.36, 1) both",
        "scale-in": "scale-in 220ms cubic-bezier(0.22, 1, 0.36, 1) both",
      },
    },
  },
  plugins: [],
} satisfies Config;

