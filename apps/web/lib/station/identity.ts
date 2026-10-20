/**
 * Which station this machine is, remembered per business.
 *
 * Per business, not one id: a machine whose user has two venues in the
 * switcher would otherwise have the second venue's tab claiming the
 * first venue's tickets.
 *
 * Every access is guarded. Private mode and some embedded webviews throw
 * on localStorage, and a station page that crashes on load cannot even
 * show why.
 */
const key = (businessId: string) => `station:${businessId}`;

export function stationIdFor(businessId: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key(businessId)) ?? null;
  } catch {
    return null;
  }
}

export function rememberStation(businessId: string, stationId: string): void {
  try {
    globalThis.localStorage?.setItem(key(businessId), stationId);
  } catch {
    /* A station that cannot remember still works; it just asks again. */
  }
}

export function forgetStation(businessId: string): void {
  try {
    globalThis.localStorage?.removeItem(key(businessId));
  } catch {
    /* ignore */
  }
}
