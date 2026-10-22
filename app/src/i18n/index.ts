import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { en, type Translation } from "./translations/en";
import { es } from "./translations/es";

export type Language = "en" | "es";

export const LANGUAGE_STORAGE_KEY = "bitacora.language";
export const DEFAULT_LANGUAGE: Language = "en";

const dictionaries: Record<Language, Translation> = { en, es };

/** Dot path into a nested translation object, e.g. "chat.send". */
type Path<T> = T extends object
  ? {
      [K in keyof T & string]: T[K] extends string ? K : `${K}.${Path<T[K]>}`;
    }[keyof T & string]
  : never;

export type TranslationKey = Path<Translation>;

function resolve(dict: Translation, key: string): string {
  const parts = key.split(".");
  // biome-ignore lint/suspicious/noExplicitAny: walking a nested dictionary by dot path
  let node: any = dict;
  for (const part of parts) {
    node = node?.[part];
  }
  return typeof node === "string" ? node : key;
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    name in params ? String(params[name]) : match,
  );
}

export interface I18nContextValue {
  language: Language;
  setLanguage: (language: Language) => void | Promise<void>;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

export const I18nContext = createContext<I18nContextValue | null>(null);

/**
 * Builds the context value for `I18nContext.Provider`. Kept as a plain
 * hook (rather than baked into a component) so the settings container
 * can own persistence while this stays a pure translation lookup.
 */
export function useI18nValue(initialLanguage: Language): I18nContextValue {
  const [language, setLanguage] = useState<Language>(initialLanguage);

  const t = useCallback(
    (key: TranslationKey, params?: Record<string, string | number>) =>
      interpolate(resolve(dictionaries[language], key), params),
    [language],
  );

  return useMemo(() => ({ language, setLanguage, t }), [language, t]);
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used within an I18nContext.Provider");
  }
  return ctx;
}
