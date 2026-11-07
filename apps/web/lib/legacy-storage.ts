/**
 * Reading a storage key that was renamed when the product went from "menu"
 * to "supermenu".
 *
 * Returns the value under `key`; if there is none but `legacyKey` holds one,
 * moves it across first so the old name is read exactly once. Callers keep
 * their own try/catch — storage throws in private mode and some webviews.
 */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function readMigrating(store: KeyValueStore, key: string, legacyKey: string): string | null {
  const current = store.getItem(key);
  if (current !== null) return current;
  const legacy = store.getItem(legacyKey);
  if (legacy === null) return null;
  store.setItem(key, legacy);
  store.removeItem(legacyKey);
  return legacy;
}
