"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";

export interface SalesLookups {
  tables: string[];
  categories: { id: string; name: string }[];
  items: { id: string; name: string; categoryId: string }[];
}

const EMPTY: SalesLookups = { tables: [], categories: [], items: [] };

/**
 * What the filter bar offers: current table labels and the menu's
 * categories and dishes. Shared by Sales and Insights so both offer the same
 * choices.
 */
export function useSalesLookups(businessId: string | undefined): SalesLookups {
  const [lookups, setLookups] = useState<SalesLookups>(EMPTY);

  useEffect(() => {
    if (!businessId) return;
    let live = true;
    void Promise.all([
      api.get<{ label: string }[]>(`/businesses/${businessId}/tables`),
      api.get<{ id: string; name: string; items: { id: string; name: string }[] }[]>(
        `/businesses/${businessId}/menu`,
      ),
    ])
      .then(([tables, menu]) => {
        if (!live) return;
        setLookups({
          tables: tables.map((t) => t.label),
          categories: menu.map((c) => ({ id: c.id, name: c.name })),
          items: menu.flatMap((c) => c.items.map((i) => ({ id: i.id, name: i.name, categoryId: c.id }))),
        });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [businessId]);

  return lookups;
}
