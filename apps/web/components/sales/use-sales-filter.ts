"use client";

import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  PERIOD_PRESETS,
  localToday,
  paramsToObject,
  presetRange,
  salesFilterSchema,
  salesFilterToParams,
  type PeriodPreset,
  type SalesFilter,
} from "@menu/shared";

export type PresetOrCustom = PeriodPreset | "custom";

function isPreset(v: string | null): v is PeriodPreset {
  return v !== null && (PERIOD_PRESETS as readonly string[]).includes(v);
}

/**
 * The URL is the state. A filtered view survives refresh, can be bookmarked,
 * and is what an owner sends their accountant (who logs in as them).
 *
 * A preset is re-evaluated against today, so a bookmarked "This month" is
 * always this month, not the month it was saved in.
 */
export function filterFromSearch(
  search: URLSearchParams,
  tz: string,
  now: Date = new Date(),
): { filter: SalesFilter; preset: PresetOrCustom } {
  const today = localToday(tz, now);
  const p = search.get("p");
  const obj: Record<string, unknown> = paramsToObject(search);
  delete obj.p;
  if (isPreset(p)) Object.assign(obj, presetRange(p, today));
  const parsed = salesFilterSchema.safeParse(obj);
  if (parsed.success) return { filter: parsed.data, preset: isPreset(p) ? p : "custom" };
  return { filter: { ...presetRange("this_month", today) } as SalesFilter, preset: "this_month" };
}

export function useSalesFilter(tz: string) {
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const { filter, preset } = useMemo(
    () => filterFromSearch(new URLSearchParams(search.toString()), tz),
    [search, tz],
  );

  const setFilter = useCallback(
    (next: SalesFilter, nextPreset: PresetOrCustom = "custom") => {
      const params = salesFilterToParams(next);
      params.set("p", nextPreset);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname],
  );

  const query = useMemo(() => salesFilterToParams(filter).toString(), [filter]);
  return { filter, preset, setFilter, query };
}
