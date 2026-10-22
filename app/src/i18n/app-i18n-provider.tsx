import type { ReactNode } from "react";
import { useCallback, useMemo } from "react";
import { useSettings } from "../features/settings/settings-context";
import { I18nContext, type Language, useI18nValue } from "./index";

/**
 * Bridges the settings container's persisted `language` into
 * `I18nContext`, so `useI18n().setLanguage` both updates the live
 * translations and persists the choice. Must be rendered inside
 * `SettingsProvider`.
 */
export function AppI18nProvider({ children }: { children: ReactNode }) {
  const settings = useSettings();
  const value = useI18nValue(settings.language);

  const setLanguage = useCallback(
    async (language: Language) => {
      await settings.setLanguage(language);
    },
    [settings],
  );

  const contextValue = useMemo(
    () => ({ language: settings.language, setLanguage, t: value.t }),
    [settings.language, setLanguage, value.t],
  );

  return <I18nContext.Provider value={contextValue}>{children}</I18nContext.Provider>;
}
