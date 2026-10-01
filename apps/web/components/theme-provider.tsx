"use client";

import { createContext, useContext, useEffect, useState } from "react";

export type ColorTheme = "amber" | "violet" | "cyan" | "indigo";
export type DarkMode = "light" | "dark" | "system";

interface ThemeContextValue {
  mode: DarkMode;
  setMode: (m: DarkMode) => void;
  theme: ColorTheme;
  setTheme: (t: ColorTheme) => void;
  /** Resolved value — what is actually applied to the DOM right now. */
  resolvedDark: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<DarkMode>("system");
  const [theme, setThemeState] = useState<ColorTheme>("amber");
  const [resolvedDark, setResolvedDark] = useState(false);

  /* Hydrate from localStorage on mount. */
  useEffect(() => {
    const savedMode = localStorage.getItem("ui-mode") as DarkMode | null;
    const savedTheme = localStorage.getItem("ui-theme") as ColorTheme | null;
    if (savedMode) setModeState(savedMode);
    if (savedTheme) setThemeState(savedTheme);
  }, []);

  /* Resolve actual dark state whenever mode or system preference changes. */
  useEffect(() => {
    const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

    function resolve() {
      const dark =
        mode === "dark" ||
        (mode === "system" && systemDark.matches);
      setResolvedDark(dark);
      document.documentElement.classList.toggle("dark", dark);
    }

    resolve();
    systemDark.addEventListener("change", resolve);
    return () => systemDark.removeEventListener("change", resolve);
  }, [mode]);

  /* Apply the color theme as a data attribute. */
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  function setMode(m: DarkMode) {
    setModeState(m);
    localStorage.setItem("ui-mode", m);
  }

  function setTheme(t: ColorTheme) {
    setThemeState(t);
    localStorage.setItem("ui-theme", t);
  }

  return (
    <ThemeContext.Provider value={{ mode, setMode, theme, setTheme, resolvedDark }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}

export const THEMES: { value: ColorTheme; label: string; color: string }[] = [
  { value: "amber",  label: "Amber",  color: "#d97706" },
  { value: "violet", label: "Violet", color: "#7c3aed" },
  { value: "cyan",   label: "Cyan",   color: "#0891b2" },
  { value: "indigo", label: "Indigo", color: "#4f46e5" },
];
