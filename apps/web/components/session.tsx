"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { findAccent } from "@menu/shared";
import { api, restoreSession } from "@/lib/api-client";
import type { Business, Me } from "@/lib/types";

interface SessionValue {
  me: Me | null;
  businesses: Business[];
  current: Business | null;
  setCurrentId: (id: string) => void;
  refreshBusinesses: () => Promise<void>;
  /** Applies a theme change locally before the save lands, so the picker feels instant. */
  previewAccent: (hex: string | null) => void;
  loading: boolean;
}

const Ctx = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = useContext(Ctx);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    // The access token lives in memory, so a reload always starts by trading
    // the httpOnly refresh cookie for a new one.
    const ok = await restoreSession();
    if (!ok) {
      router.replace("/login");
      return;
    }
    const [meRes, bizRes] = await Promise.all([
      api.get<Me>("/auth/me"),
      api.get<Business[]>("/businesses/mine"),
    ]);
    setMe(meRes);
    setBusinesses(bizRes);
    setCurrentId((prev) => prev ?? bizRes[0]?.id ?? null);
    setLoading(false);
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshBusinesses = useCallback(async () => {
    const bizRes = await api.get<Business[]>("/businesses/mine");
    setBusinesses(bizRes);
    setPreview(null);
  }, []);

  const current = useMemo(
    () => businesses.find((b) => b.id === currentId) ?? businesses[0] ?? null,
    [businesses, currentId],
  );

  /*
   * The tenant's accent is the only colour in the product, so it is written
   * onto the document root rather than threaded through components. Changing
   * it in the template picker recolours every button, focus ring and link at
   * once — which is the point: the owner is choosing the product's colour,
   * not a swatch in a settings page.
   */
  useEffect(() => {
    const hex = preview ?? current?.themeAccent;
    if (!hex) return;
    const accent = findAccent(hex);
    const root = document.documentElement;
    root.style.setProperty("--accent", accent.hex);
    root.style.setProperty("--accent-strong", accent.hexStrong);
    root.style.setProperty("--accent-soft", accent.hexSoft);
  }, [current?.themeAccent, preview]);

  const value: SessionValue = {
    me,
    businesses,
    current,
    setCurrentId,
    refreshBusinesses,
    previewAccent: setPreview,
    loading,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
