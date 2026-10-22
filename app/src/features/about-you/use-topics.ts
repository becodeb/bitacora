import { useCallback, useEffect, useState } from "react";
import type { ApiClient } from "../../api/client";
import type { TopicOverview } from "../../api/types";
import { describeError } from "./describe-error";

export interface TopicsContainer {
  topics: TopicOverview[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  load: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Applies immediately per `odd/tasks/mvp.md`'s "No confirmations" decision — the caller is expected to show the returned `groupId` as an Undo snackbar. */
  renameTopic: (topicId: string, name: string) => Promise<string | null>;
}

/** Owns the topics list behind the "What I know about you" tab's first screen (T10 work unit (c)). */
export function useTopics(client: ApiClient | null): TopicsContainer {
  const [topics, setTopics] = useState<TopicOverview[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!client) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await client.getTopics();
      setTopics(response.topics);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [client]);

  const refresh = useCallback(async () => {
    if (!client) {
      return;
    }
    setRefreshing(true);
    setError(null);
    try {
      const response = await client.getTopics();
      setTopics(response.topics);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setRefreshing(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const renameTopic = useCallback(
    async (topicId: string, name: string) => {
      if (!client) {
        return null;
      }
      try {
        const response = await client.renameTopic(topicId, { name });
        await load();
        return response.groupId;
      } catch (err) {
        setError(describeError(err));
        return null;
      }
    },
    [client, load],
  );

  return { topics, loading, refreshing, error, load, refresh, renameTopic };
}
