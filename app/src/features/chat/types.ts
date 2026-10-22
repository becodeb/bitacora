import type { AgentContentBlock, AgentRole } from "../../api/types";

/**
 * The chat UI's own message shape, derived from either a persisted
 * `ChatHistoryRow` (`GET /v1/chat/history`) or an in-progress streamed
 * turn. Both paths converge here so `MessageList`/`MessageBubble` have
 * one shape to render regardless of where a message came from.
 */
export interface UiMessage {
  id: string;
  role: AgentRole;
  text: string;
  /**
   * `ref` → source entry id, for `[#n]`-style citation markers found
   * in `text`. Only ever populated for a message built live during
   * this session (`citations` SSE events) — a message loaded from
   * history has no citation mapping (the server does not persist
   * one), so its `[#n]` markers render as plain text. See the T10
   * writer report's "gaps" for why.
   */
  citations: Record<string, string>;
  createdAt: string;
  pending: boolean;
}

export function extractText(content: AgentContentBlock[]): string {
  return content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}
