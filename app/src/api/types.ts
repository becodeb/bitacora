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
  /** `[#n]` ref -> source entry id, persisted with the assistant message (see T10's work unit (a)). `null`/absent for a row with no citations, or any non-assistant row. */
  citations: Array<{ ref: string; sourceEntryId: string }> | null;
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

/**
 * Types mirroring `server/src/memory/owner-view.ts` and
 * `server/src/http/me.ts`, behind the "What I know about you" tab
 * (T10 work unit (c)).
 */

export interface TopicOverview {
  id: string;
  name: string;
  description: string | null;
  summary: string | null;
  liveMemoryCount: number;
  lastChangeAt: string;
}

export interface MemorySummary {
  id: string;
  content: string;
  topicId: string | null;
  sourceEntryId: string;
  createdAt: string;
  validFrom: string;
}

export interface RuleSummary {
  key: string;
  payload: unknown;
  topicName: string | null;
}

export interface ChangeGroupSummary {
  groupId: string;
  source: "chat_turn" | "consolidation" | "manual_edit";
  createdAt: string;
  undone: boolean;
  summary: string;
}

export interface MeTopicsResponse {
  ok: true;
  topics: TopicOverview[];
}

export interface MeTopicDetailResponse {
  ok: true;
  topic: TopicOverview;
  memories: MemorySummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface MeMemoriesResponse {
  ok: true;
  memories: MemorySummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface MeRulesResponse {
  ok: true;
  rules: RuleSummary[];
}

export interface MeChangesResponse {
  ok: true;
  changes: ChangeGroupSummary[];
}

/** The common shape of every owner-made `/v1/me` mutation's response — each endpoint also adds its own fields (e.g. `topic`, `memoryId`), intentionally left untyped here since callers that need them read the response loosely. */
export interface MeMutationResponse {
  ok: true;
  groupId: string;
  [key: string]: unknown;
}

export interface MeUndoResponse {
  ok: true;
  turnId: string;
  reverted: number;
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
