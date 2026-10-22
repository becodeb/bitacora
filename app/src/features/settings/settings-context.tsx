import { createContext, type ReactNode, useContext } from "react";
import type { SettingsContainer } from "./use-settings";
import { useSettingsContainer } from "./use-settings";

const SettingsContext = createContext<SettingsContainer | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const settings = useSettingsContainer();
  return <SettingsContext.Provider value={settings}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContainer {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error("useSettings must be used within a SettingsProvider");
  }
  return ctx;
}
