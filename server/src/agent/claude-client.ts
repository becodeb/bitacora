/**
 * Real `ClaudeClient`: wraps `@anthropic-ai/sdk`'s streaming
 * `messages.stream()` (manual loop, not the beta tool runner — see
 * `odd/tasks/mvp.md`'s T06 instructions: `tool_choice: "auto"` only,
 * no forced tools, no assistant prefill, validate tool inputs before
 * running them).
 *
 * Docs relied on (bundled claude-api skill, read 2026-10-22):
 * - `thinking: { type: "adaptive" }` for Haiku 5.5 (no `budget_tokens`).
 * - `output_config: { effort }` controls reasoning effort.
 * - Check `stop_reason` (`refusal`, `max_tokens`) before trusting tool
 *   input or running tools on it.
 */
import Anthropic from "@anthropic-ai/sdk";
import type {
  AgentContentBlock,
  AgentStopReason,
  AgentUsage,
  ClaudeClient,
  ClaudeTurnRequest,
  ClaudeTurnResult,
} from "./types.js";

const MODEL = "claude-haiku-5-5";

export interface AnthropicClaudeClientOptions {
  apiKey: string;
  client?: Anthropic;
}

function toAnthropicSystem(system: ClaudeTurnRequest["system"]): Anthropic.TextBlockParam[] {
  return system.map((block, index) => ({
    type: "text",
    text: block.text,
    // Cache control goes on the LAST stable block only (see
    // `shared/prompt-caching.md`): every byte of the prefix up to and
    // including that block is then eligible to be served from cache on
    // the next call with the same prefix.
    ...(block.cacheControl && index === system.length - 1
      ? { cache_control: { type: "ephemeral" as const } }
      : {}),
  }));
}

function toAnthropicTools(tools: ClaudeTurnRequest["tools"]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  }));
}

function toAnthropicMessages(messages: ClaudeTurnRequest["messages"]): Anthropic.MessageParam[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.map((block): Anthropic.ContentBlockParam => {
      if (block.type === "text") {
        return { type: "text", text: block.text };
      }
      if (block.type === "tool_use") {
        return { type: "tool_use", id: block.id, name: block.name, input: block.input };
      }
      if (block.type === "thinking") {
        // Echoed exactly as received — see the type's own doc comment
        // in `types.ts`: a modified thinking block is a 400.
        return { type: "thinking", thinking: block.thinking, signature: block.signature };
      }
      if (block.type === "redacted_thinking") {
        return { type: "redacted_thinking", data: block.data };
      }
      return {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: block.content,
        ...(block.is_error ? { is_error: true } : {}),
      };
    }),
  }));
}

function fromAnthropicContent(content: Anthropic.ContentBlock[]): AgentContentBlock[] {
  const blocks: AgentContentBlock[] = [];
  for (const block of content) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      blocks.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
    } else if (block.type === "thinking") {
      // Kept, not dropped: required when using tools with extended
      // thinking — must be replayed verbatim (see `types.ts`) both
      // within this turn's own tool loop and across later turns (see
      // `chat-history.ts`'s module comment for that decision).
      blocks.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
    } else if (block.type === "redacted_thinking") {
      blocks.push({ type: "redacted_thinking", data: block.data });
    }
    // Other block types (server tools, ...) are not used by this agent
    // and are intentionally dropped.
  }
  return blocks;
}

/**
 * Anthropic's `stop_reason` already matches `AgentStopReason` 1:1
 * except `null`, which only occurs on a non-final streaming event and
 * never on the resolved final message this client returns — so it maps
 * to `"end_turn"` defensively rather than widening the port's type.
 */
function toAgentStopReason(stopReason: Anthropic.StopReason | null): AgentStopReason {
  return stopReason ?? "end_turn";
}

function toAgentUsage(usage: Anthropic.Usage): AgentUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? undefined,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? undefined,
  };
}

export function createAnthropicClaudeClient(options: AnthropicClaudeClientOptions): ClaudeClient {
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey });

  async function runTurn(
    request: ClaudeTurnRequest,
    onTextDelta: (text: string) => void,
  ): Promise<ClaudeTurnResult> {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: request.maxTokens,
      thinking: { type: "adaptive" },
      output_config: { effort: request.effort },
      system: toAnthropicSystem(request.system),
      tools: toAnthropicTools(request.tools),
      tool_choice: { type: "auto" },
      messages: toAnthropicMessages(request.messages),
    });

    stream.on("text", (delta) => onTextDelta(delta));

    const message = await stream.finalMessage();

    return {
      content: fromAnthropicContent(message.content),
      stopReason: toAgentStopReason(message.stop_reason),
      usage: toAgentUsage(message.usage),
    };
  }

  return { runTurn };
}
