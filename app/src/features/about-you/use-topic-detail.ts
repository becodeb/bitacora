import { useCallback, useEffect, useState } from "react";
import type { ApiClient } from "../../api/client";
import type { MemorySummary, TopicOverview } from "../../api/types";
import { describeError } from "./describe-error";

export interface TopicDetailContainer {
  topic: TopicOverview | null;
  memories: MemorySummary[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Returns the mutation's `groupId` (for an Undo snackbar) on success, `null` on failure — every edit here applies immediately, no confirmation (`odd/tasks/mvp.md`). */
  editMemoryContent: (memoryId: string, content: string) => Promise<string | null>;
  moveMemory: (memoryId: string, topicId: string | null) => Promise<string | null>;
  deleteMemory: (memoryId: string) => Promise<string | null>;
}

/**
 * Owns one topic's detail view: its own `TopicOverview` plus its live
 * memories, and the three ways the owner can correct a memory in
 * place (T10 work unit (c)). `topicId: null` selects the "no topic"
 * bucket (`GET /v1/me/memories?topicId=none`), matching the server's
 * own `listLiveMemories` shape. `topicId: undefined` means this
 * detail view is not active yet (the owner is still on the topics
 * list) — the hook is still mounted unconditionally (it is called
 * from a fixed position in `AboutYouScreen`, same as every other
 * hook there), but it fetches nothing until a real selection arrives.
 */
export function useTopicDetail(
  client: ApiClient | null,
  topicId: string | null | undefined,
): TopicDetailContainer {
  const [topic, setTopic] = useState<TopicOverview | null>(null);
  const [memories, setMemories] = useState<MemorySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (mode: "initial" | "refresh") => {
      if (!client || topicId === undefined) {
        return;
      }
      mode === "initial" ? setLoading(true) : setRefreshing(true);
      setError(null);
      try {
        if (topicId) {
          const response = await client.getTopic(topicId);
          setTopic(response.topic);
          setMemories(response.memories);
        } else {
          const response = await client.getMemoriesWithoutTopic();
          setTopic(null);
          setMemories(response.memories);
        }
      } catch (err) {
        setError(describeError(err));
      } finally {
        mode === "initial" ? setLoading(false) : setRefreshing(false);
      }
    },
    [client, topicId],
  );

  useEffect(() => {
    void load("initial");
  }, [load]);

  const refresh = useCallback(() => load("refresh"), [load]);

  const editMemoryContent = useCallback(
    async (memoryId: string, content: string) => {
      if (!client) return null;
      try {
        const response = await client.correctMemoryContent(memoryId, content);
        await load("refresh");
        return response.groupId;
      } catch (err) {
        setError(describeError(err));
        return null;
      }
    },
    [client, load],
  );

  const moveMemory = useCallback(
    async (memoryId: string, newTopicId: string | null) => {
      if (!client) return null;
      try {
        const response = await client.moveMemoryTopic(memoryId, newTopicId);
        await load("refresh");
        return response.groupId;
      } catch (err) {
        setError(describeError(err));
        return null;
      }
    },
    [client, load],
  );

  const deleteMemory = useCallback(
    async (memoryId: string) => {
      if (!client) return null;
      try {
        const response = await client.deleteMemory(memoryId);
        await load("refresh");
        return response.groupId;
      } catch (err) {
        setError(describeError(err));
        return null;
      }
    },
    [client, load],
  );

  return {
    topic,
    memories,
    loading,
    refreshing,
    error,
    refresh,
    editMemoryContent,
    moveMemory,
    deleteMemory,
  };
}
