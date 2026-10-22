import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../api/client";
import { ApiError, type ChatStreamEvent, NetworkError } from "../../api/types";
import type { StagedAttachment } from "./attachment-types";
import { extractText, type UiMessage } from "./types";

const PENDING_ASSISTANT_ID = "__pending__";

export interface ChatState {
  messages: UiMessage[];
  historyLoading: boolean;
  sending: boolean;
  toolStatus: string | null;
  error: string | null;
  derivationPending: boolean;
  undoing: boolean;
  lastUndoResult: { reverted: number } | null;
}

export interface ChatContainer extends ChatState {
  sendText: (text: string) => Promise<void>;
  sendAttachment: (attachment: StagedAttachment, caption: string) => Promise<void>;
  undoLast: () => Promise<void>;
  dismissError: () => void;
  /** Whether the last message is an assistant turn, i.e. there is something an Undo could plausibly act on. */
  canUndo: boolean;
}

/**
 * Owns the chat screen's data and streaming logic: loading history on
 * mount, sending a message and accumulating its SSE stream into one
 * growing assistant `UiMessage`, tool-activity status, citation
 * mapping, Undo, and error state. `ChatScreen` (the route) renders
 * this container's state through purely presentational components.
 */
export function useChatContainer(client: ApiClient | null): ChatContainer {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [toolStatus, setToolStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [derivationPending, setDerivationPending] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [lastUndoResult, setLastUndoResult] = useState<{ reverted: number } | null>(null);

  const pendingCitations = useRef<Record<string, string>>({});

  const loadHistory = useCallback(async () => {
    if (!client) {
      return;
    }
    setHistoryLoading(true);
    try {
      const response = await client.getChatHistory();
      setMessages(
        response.messages.map((row) => ({
          id: row.id,
          role: row.role,
          text: extractText(row.content),
          citations: Object.fromEntries(
            (row.citations ?? []).map((citation) => [citation.ref, citation.sourceEntryId]),
          ),
          createdAt: row.createdAt,
          pending: false,
        })),
      );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setHistoryLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void loadHistory();
    // Reload whenever the client identity changes (e.g. settings were
    // just saved and a client became available for the first time).
  }, [loadHistory]);

  /**
   * Shared turn-running logic for both a plain text message and an
   * attachment message: stages the optimistic user/assistant pair,
   * runs `startStream` (which already knows which `ApiClient` method
   * to call), and folds its SSE events into `messages` state. `userText`
   * is only what the UI shows for the user's own bubble — for an
   * attachment this is the caption (or a placeholder), never the
   * attachment bytes themselves.
   */
  const runTurn = useCallback(
    async (
      userText: string,
      startStream: (onEvent: (event: ChatStreamEvent) => void) => Promise<void>,
    ) => {
      const userMessage: UiMessage = {
        id: `local-${Date.now()}`,
        role: "user",
        text: userText,
        citations: {},
        createdAt: new Date().toISOString(),
        pending: false,
      };
      const assistantDraft: UiMessage = {
        id: PENDING_ASSISTANT_ID,
        role: "assistant",
        text: "",
        citations: {},
        createdAt: new Date().toISOString(),
        pending: true,
      };

      setMessages((prev) => [...prev, userMessage, assistantDraft]);
      setSending(true);
      setToolStatus(null);
      setError(null);
      setDerivationPending(false);
      pendingCitations.current = {};

      try {
        await startStream((event) => {
          if (event.event === "text") {
            appendAssistantText(setMessages, event.data);
          } else if (event.event === "tool") {
            setToolStatus(event.data.statusSummary);
          } else if (event.event === "citations") {
            pendingCitations.current[event.data.ref] = event.data.sourceEntryId;
            setMessages((prev) =>
              prev.map((message) =>
                message.id === PENDING_ASSISTANT_ID
                  ? { ...message, citations: { ...pendingCitations.current } }
                  : message,
              ),
            );
          } else if (event.event === "done") {
            setDerivationPending(event.data.derivationPending);
            setMessages((prev) =>
              prev.map((message) =>
                message.id === PENDING_ASSISTANT_ID
                  ? { ...message, id: event.data.turnId, pending: false }
                  : message,
              ),
            );
          } else if (event.event === "error") {
            setError(event.data.message);
            setMessages((prev) => prev.filter((message) => message.id !== PENDING_ASSISTANT_ID));
          }
        });
      } catch (err) {
        setError(describeError(err));
        setMessages((prev) => prev.filter((message) => message.id !== PENDING_ASSISTANT_ID));
      } finally {
        setSending(false);
        setToolStatus(null);
      }
    },
    [],
  );

  const sendText = useCallback(
    async (text: string) => {
      if (!client || text.trim().length === 0 || sending) {
        return;
      }
      await runTurn(text, (onEvent) => client.sendTextMessage(text, onEvent));
    },
    [client, sending, runTurn],
  );

  const sendAttachment = useCallback(
    async (attachment: StagedAttachment, caption: string) => {
      if (!client || sending) {
        return;
      }
      const displayText =
        caption.trim().length > 0 ? caption.trim() : attachment.kind === "photo" ? "📷" : "🎤";
      await runTurn(displayText, (onEvent) =>
        client.sendAttachmentMessage(attachment, caption, onEvent),
      );
    },
    [client, sending, runTurn],
  );

  const undoLast = useCallback(async () => {
    if (!client || undoing) {
      return;
    }
    setUndoing(true);
    setError(null);
    try {
      const result = await client.undoLast();
      setLastUndoResult({ reverted: result.reverted });
      await loadHistory();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setUndoing(false);
    }
  }, [client, undoing, loadHistory]);

  const dismissError = useCallback(() => setError(null), []);

  const canUndo = messages.length > 0 && messages[messages.length - 1].role === "assistant";

  return {
    messages,
    historyLoading,
    sending,
    toolStatus,
    error,
    derivationPending,
    undoing,
    lastUndoResult,
    sendText,
    sendAttachment,
    undoLast,
    dismissError,
    canUndo,
  };
}

function appendAssistantText(
  setMessages: React.Dispatch<React.SetStateAction<UiMessage[]>>,
  delta: string,
): void {
  setMessages((prev) =>
    prev.map((message) =>
      message.id === PENDING_ASSISTANT_ID ? { ...message, text: message.text + delta } : message,
    ),
  );
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    return err.message;
  }
  if (err instanceof NetworkError) {
    return "network";
  }
  return err instanceof Error ? err.message : "unknown error";
}
