import { useCallback, useEffect, useState } from "react";
import type { ApiClient } from "../../api/client";
import type { ChangeGroupSummary } from "../../api/types";
import { describeError } from "./describe-error";

export interface ChangesContainer {
  changes: ChangeGroupSummary[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  /** The groupId currently being undone, for a per-row spinner — `null` when nothing is in flight. */
  undoingGroupId: string | null;
  /** Set right after a successful undo, for a transient confirmation snackbar; the caller clears it. */
  lastUndoResult: { groupId: string; reverted: number } | null;
  dismissUndoResult: () => void;
  refresh: () => Promise<void>;
  undo: (groupId: string) => Promise<void>;
}

/**
 * Owns the "Changes" history ("What I know about you" → Changes, T10
 * work unit (c)): `GET /v1/me/changes` and
 * `POST /v1/me/changes/:groupId/undo`. Every owner-made edit
 * elsewhere in this feature creates its own change group (see
 * `http/me.ts`'s own doc comment), so this is also where those edits
 * become undoable after the fact — not just immediately after making
 * them.
 */
export function useChanges(client: ApiClient | null): ChangesContainer {
  const [changes, setChanges] = useState<ChangeGroupSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undoingGroupId, setUndoingGroupId] = useState<string | null>(null);
  const [lastUndoResult, setLastUndoResult] = useState<{
    groupId: string;
    reverted: number;
  } | null>(null);

  const load = useCallback(
    async (mode: "initial" | "refresh") => {
      if (!client) return;
      mode === "initial" ? setLoading(true) : setRefreshing(true);
      setError(null);
      try {
        const response = await client.getChanges();
        setChanges(response.changes);
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

  const undo = useCallback(
    async (groupId: string) => {
      if (!client || undoingGroupId) return;
      setUndoingGroupId(groupId);
      setError(null);
      try {
        const result = await client.undoChangeGroup(groupId);
        setLastUndoResult({ groupId, reverted: result.reverted });
        await load("refresh");
      } catch (err) {
        setError(describeError(err));
      } finally {
        setUndoingGroupId(null);
      }
    },
    [client, undoingGroupId, load],
  );

  const dismissUndoResult = useCallback(() => setLastUndoResult(null), []);

  return {
    changes,
    loading,
    refreshing,
    error,
    undoingGroupId,
    lastUndoResult,
    dismissUndoResult,
    refresh,
    undo,
  };
}
