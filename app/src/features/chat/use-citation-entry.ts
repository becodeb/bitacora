import { useCallback, useState } from "react";
import type { ApiClient } from "../../api/client";
import type { EntryView } from "../../api/types";

export interface CitationEntryState {
  open: boolean;
  loading: boolean;
  entry: EntryView | null;
  error: string | null;
  openCitation: (sourceEntryId: string) => Promise<void>;
  close: () => void;
}

/** Owns fetching one source entry (`GET /v1/entries/:id`) for the citation sheet, so `CitationSheet` itself stays presentational. */
export function useCitationEntry(client: ApiClient | null): CitationEntryState {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [entry, setEntry] = useState<EntryView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openCitation = useCallback(
    async (sourceEntryId: string) => {
      if (!client) {
        return;
      }
      setOpen(true);
      setLoading(true);
      setError(null);
      setEntry(null);
      try {
        const response = await client.getEntry(sourceEntryId);
        setEntry(response.entry);
      } catch (err) {
        setError(err instanceof Error ? err.message : "unknown error");
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  const close = useCallback(() => {
    setOpen(false);
    setEntry(null);
    setError(null);
  }, []);

  return { open, loading, entry, error, openCitation, close };
}
