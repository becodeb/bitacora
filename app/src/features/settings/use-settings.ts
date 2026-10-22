import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiClient } from "../../api/client";
import type { Language } from "../../i18n/index";
import {
  clearConnection,
  DEFAULT_BASE_URL,
  loadStoredSettings,
  saveConnection,
  saveLanguage,
} from "./settings-store";

export type ValidationError = "unreachable" | "unauthorized";

export interface SettingsState {
  /** True while the stored settings are being read on app start. */
  loading: boolean;
  baseUrl: string;
  token: string;
  language: Language;
  /** True once a baseUrl/token pair has been saved (not necessarily re-validated this session). */
  configured: boolean;
}

export interface SettingsContainer extends SettingsState {
  /** Validates `baseUrl`/`token` against the server, and persists them only on success. Returns `null` on success, or the reason it failed. */
  connect: (baseUrl: string, token: string) => Promise<ValidationError | null>;
  setLanguage: (language: Language) => Promise<void>;
  signOut: () => Promise<void>;
  client: ApiClient | null;
}

/**
 * Owns connection settings (server URL, bearer token, language):
 * loading them on mount, validating a new pair against the server
 * before persisting (`GET /health` then an authed `GET /v1/me`, per
 * T10's scope), and exposing a ready-to-use `ApiClient` once
 * configured. Screens (onboarding, settings) are presentational
 * consumers of this container.
 */
export function useSettingsContainer(): SettingsContainer {
  const [state, setState] = useState<SettingsState>({
    loading: true,
    baseUrl: DEFAULT_BASE_URL,
    token: "",
    language: "en",
    configured: false,
  });

  useEffect(() => {
    let mounted = true;
    loadStoredSettings().then((stored) => {
      if (!mounted) {
        return;
      }
      setState({
        loading: false,
        baseUrl: stored.baseUrl ?? DEFAULT_BASE_URL,
        token: stored.token ?? "",
        language: stored.language,
        configured: Boolean(stored.baseUrl && stored.token),
      });
    });
    return () => {
      mounted = false;
    };
  }, []);

  const connect = useCallback(
    async (baseUrl: string, token: string): Promise<ValidationError | null> => {
      const trimmedUrl = baseUrl.trim();
      const trimmedToken = token.trim();
      const client = new ApiClient({ baseUrl: trimmedUrl, token: trimmedToken });

      const healthy = await client.checkHealth();
      if (!healthy) {
        return "unreachable";
      }
      const authorized = await client.checkAuth();
      if (!authorized) {
        return "unauthorized";
      }

      await saveConnection(trimmedUrl, trimmedToken);
      setState((prev) => ({
        ...prev,
        baseUrl: trimmedUrl,
        token: trimmedToken,
        configured: true,
      }));
      return null;
    },
    [],
  );

  const setLanguage = useCallback(async (language: Language) => {
    await saveLanguage(language);
    setState((prev) => ({ ...prev, language }));
  }, []);

  const signOut = useCallback(async () => {
    await clearConnection();
    setState((prev) => ({ ...prev, baseUrl: DEFAULT_BASE_URL, token: "", configured: false }));
  }, []);

  const client = useMemo(
    () => (state.configured ? new ApiClient({ baseUrl: state.baseUrl, token: state.token }) : null),
    [state.configured, state.baseUrl, state.token],
  );

  return { ...state, connect, setLanguage, signOut, client };
}
