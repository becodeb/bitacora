import * as SecureStore from "expo-secure-store";

/**
 * Thin typed wrapper around `expo-secure-store`. Values are stored as
 * plain strings; `getJSON`/`setJSON` add JSON (de)serialization for
 * structured values (e.g. the settings object) without leaking parsing
 * concerns into callers.
 */

export async function getItem(key: string): Promise<string | null> {
  return SecureStore.getItemAsync(key);
}

export async function setItem(key: string, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value);
}

export async function deleteItem(key: string): Promise<void> {
  await SecureStore.deleteItemAsync(key);
}

export async function getJSON<T>(key: string): Promise<T | null> {
  const raw = await getItem(key);
  if (raw === null) {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A corrupted or stale value is treated as absent rather than
    // thrown, so one bad write never locks the owner out of settings.
    return null;
  }
}

export async function setJSON(key: string, value: unknown): Promise<void> {
  await setItem(key, JSON.stringify(value));
}
