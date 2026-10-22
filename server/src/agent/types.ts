/**
 * Provider-independent agent-turn domain types. `agent/claude-client.ts`
 * implements `ClaudeClient` against the real `@anthropic-ai/sdk`;
 * `run-turn.ts` depends only on this port, so tests can script a fake
 * client instead of making a real API call (see `test-helpers.ts`).
 */

export type AgentRole = "user" | "assistant";

/**
 * A minimal, provider-shaped content block — close enough to
 * Anthropic's own `ContentBlockParam` that a real request can be built
 * directly from it, but with no SDK import required to construct one
 * in a test.
 *
 * `thinking`/`redacted_thinking` must be echoed back to the API
 * byte-for-byte (`signature`/`data` included) whenever an assistant
 * turn that produced them is replayed — see `claude-client.ts` and
 * `chat-history.ts` for where that matters.
 */
export type AgentContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

export interface AgentMessage {
  role: AgentRole;
  content: AgentContentBlock[];
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export type AgentStopReason =
  | "end_turn"
  | "max_tokens"
  | "refusal"
  | "tool_use"
  | "pause_turn"
  | "stop_sequence"
  | "model_context_window_exceeded";

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export interface ClaudeTurnRequest {
  /** The stable, cacheable system prompt — see `prompt.ts`'s `buildSystemBlocks`. */
  system: Array<{ text: string; cacheControl?: boolean }>;
  tools: AgentToolDefinition[];
  messages: AgentMessage[];
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens: number;
}

export interface ClaudeTurnResult {
  content: AgentContentBlock[];
  stopReason: AgentStopReason;
  usage: AgentUsage;
}

/**
 * One Claude API call. `onTextDelta` is invoked with each streamed text
 * chunk as it arrives — the SSE route (`http/chat.ts`) uses it to emit
 * `text` events without waiting for the whole turn to finish.
 */
export interface ClaudeClient {
  runTurn(
    request: ClaudeTurnRequest,
    onTextDelta: (text: string) => void,
  ): Promise<ClaudeTurnResult>;
}
