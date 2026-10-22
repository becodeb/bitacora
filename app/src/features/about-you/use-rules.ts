import { useCallback, useEffect, useState } from "react";
import type { ApiClient } from "../../api/client";
import type { RuleSummary } from "../../api/types";
import { describeError } from "./describe-error";

export interface RulesContainer {
  rules: RuleSummary[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  saveRule: (key: string, payload: unknown, topicName?: string) => Promise<string | null>;
  deleteRule: (key: string) => Promise<string | null>;
}

/** Owns the rules list ("What I know about you" → Rules, T10 work unit (c)): `server/src/http/me.ts`'s `GET/PUT/DELETE /v1/me/rules`. */
export function useRules(client: ApiClient | null): RulesContainer {
  const [rules, setRules] = useState<RuleSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (mode: "initial" | "refresh") => {
      if (!client) return;
      mode === "initial" ? setLoading(true) : setRefreshing(true);
      setError(null);
      try {
        const response = await client.getRules();
        setRules(response.rules);
      } catch (err) {
        setError(describeError(err));
      } finally {
        mode === "initial" ? setLoading(false) : setRefreshing(false);
      }
    },
    [client],
  );

  useEffect(() => {
    void load("initial");
  }, [load]);

  const refresh = useCallback(() => load("refresh"), [load]);

  const saveRule = useCallback(
    async (key: string, payload: unknown, topicName?: string) => {
      if (!client) return null;
      try {
        const response = await client.putRule(key, payload, topicName);
        await load("refresh");
        return response.groupId;
      } catch (err) {
        setError(describeError(err));
        return null;
      }
    },
    [client, load],
  );

  const deleteRule = useCallback(
    async (key: string) => {
      if (!client) return null;
      try {
        const response = await client.deleteRule(key);
        await load("refresh");
        return response.groupId;
      } catch (err) {
        setError(describeError(err));
        return null;
      }
    },
    [client, load],
  );

  return { rules, loading, refreshing, error, refresh, saveRule, deleteRule };
}
