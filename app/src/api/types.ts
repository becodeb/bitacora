/**
 * Types mirroring the server's contracts (`server/src/http/*.ts`,
 * `server/src/agent/*.ts`). Kept hand-written and minimal: the server
 * has no published OpenAPI/schema package to generate from, so these
 * are read off the route handlers directly (see T10's writer report
 * for the exact files read).
 */

export type AgentRole = "user" | "assistant" | "tool";

/** Loosely typed Anthropic-style content block, as stored in `chat_messages.content`. Only the shapes the UI renders are modeled; anything else is passed through opaquely. */
export type AgentContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown; is_error?: boolean }
  | { type: string; [key: string]: unknown };

export interface ChatHistoryRow {
  id: string;
  role: AgentRole;
  content: AgentContentBlock[];
  entryId: string | null;
  createdAt: string;
}

export interface ChatHistoryResponse {
  ok: true;
  messages: ChatHistoryRow[];
}

export type AgentStopReason = "end_turn" | "max_tokens" | "refusal" | "tool_use" | string;

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  [key: string]: unknown;
}

export interface ChatDoneEvent {
  turnId: string;
  stopReason: AgentStopReason;
  usage: AgentUsage;
  derivationPending: boolean;
}

export interface ChatToolEvent {
  name: string;
  statusSummary: string;
}

export interface ChatCitationEvent {
  ref: string;
  sourceEntryId: string;
}

export interface ChatErrorEvent {
  code: string;
  message: string;
}

/** The typed, parsed form of one `POST /v1/chat` SSE event — see `api/sse.ts` for how raw frames become this. */
export type ChatStreamEvent =
  | { event: "text"; data: string }
  | { event: "tool"; data: ChatToolEvent }
  | { event: "citations"; data: ChatCitationEvent }
  | { event: "done"; data: ChatDoneEvent }
  | { event: "error"; data: ChatErrorEvent };

export interface UndoResponse {
  ok: true;
  turnId?: string;
  reverted: number;
}

export interface EntryAttachmentView {
  id: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  derivedTextStatus: "pending" | "done" | "failed" | "not_available";
  createdAt: string;
}

export interface EntryView {
  id: string;
  kind: "text" | "photo" | "voice";
  textBody: string | null;
  derivedText: string | null;
  createdAt: string;
  attachments: EntryAttachmentView[];
}

export interface EntryResponse {
  ok: true;
  entry: EntryView;
}

export interface ApiErrorResponse {
  ok: false;
  error: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}
