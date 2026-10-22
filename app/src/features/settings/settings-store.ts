import { DEFAULT_LANGUAGE, type Language } from "../../i18n/index";
import { deleteItem, getItem, setItem } from "../../lib/secure-storage";

/**
 * Raw persistence for connection settings. Split from `useSettings`
 * (the container hook) so tests can exercise read/write behavior
 * without mounting React, and so the hook's own logic (validation,
 * loading state) stays focused.
 */

const BASE_URL_KEY = "bitacora.baseUrl";
const TOKEN_KEY = "bitacora.token";
const LANGUAGE_KEY = "bitacora.language";

export const DEFAULT_BASE_URL = "https://bitacora.becode.com.ar";

export interface StoredSettings {
  baseUrl: string | null;
  token: string | null;
  language: Language;
}

export async function loadStoredSettings(): Promise<StoredSettings> {
  const [baseUrl, token, language] = await Promise.all([
    getItem(BASE_URL_KEY),
    getItem(TOKEN_KEY),
    getItem(LANGUAGE_KEY),
  ]);
  return {
    baseUrl,
    token,
    language: language === "es" ? "es" : DEFAULT_LANGUAGE,
  };
}

export async function saveConnection(baseUrl: string, token: string): Promise<void> {
  await Promise.all([setItem(BASE_URL_KEY, baseUrl), setItem(TOKEN_KEY, token)]);
}

export async function clearConnection(): Promise<void> {
  await Promise.all([deleteItem(BASE_URL_KEY), deleteItem(TOKEN_KEY)]);
}

export async function saveLanguage(language: Language): Promise<void> {
  await setItem(LANGUAGE_KEY, language);
}
