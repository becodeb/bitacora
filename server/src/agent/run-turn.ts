/**
 * Runs one agent turn: pre-search hints, the Claude tool loop, prompt
 * logging (`agent_runs`), and chat history persistence. See
 * `odd/tasks/mvp.md`'s T06 spec for the full per-message flow this
 * implements.
 */
import { randomUUID } from "node:crypto";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { agentRuns, topics } from "../db/schema.js";
import type { MemoryServiceDeps } from "../memory/service.js";
import type { createHybridSearch } from "../search/hybrid-search.js";
import { loadRecentHistory, persistChatMessage, resolveMessageText } from "./chat-history.js";
import { fetchHitText } from "./content-lookup.js";
import { estimateCostUsd } from "./pricing.js";
import { buildContextBlock, buildSystemPrompt, type PromptContextHint } from "./prompt.js";
import { extractCitations, RefTracker } from "./refs.js";
import {
  estimateTokensForMessage,
  estimateTokensForText,
  fitHistoryToBudget,
  MAX_INPUT_TOKEN_BUDGET,
} from "./token-budget.js";
import { AGENT_TOOLS, executeTool } from "./tools.js";
import type {
  AgentContentBlock,
  AgentMessage,
  AgentStopReason,
  AgentUsage,
  ClaudeClient,
} from "./types.js";

/** Bounds the tool-calling loop so a confused model cannot run forever; the turn ends with a graceful final answer instead (see below). */
const MAX_TOOL_ITERATIONS = 8;
/** Exported so tests can reproduce this module's own token-budget arithmetic exactly instead of re-guessing it (see `run-turn.test.ts`'s token-budget re-check test). */
export const MAX_OUTPUT_TOKENS = 4_096;
const DEFAULT_EFFORT = "low";

export interface AgentTurnDeps {
  db: NodePgDatabase;
  claudeClient: ClaudeClient;
  hybridSearch: ReturnType<typeof createHybridSearch>["hybridSearch"];
  findHints: ReturnType<typeof createHybridSearch>["findHints"];
  memory: MemoryServiceDeps;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Overrides `MAX_INPUT_TOKEN_BUDGET` (see `token-budget.ts`). Exists mainly so tests can force the budget-exceeded path deterministically without needing a multi-megabyte fixture. */
  maxInputTokenBudget?: number;
}

export interface AgentTurnParams {
  /** The entry created for this chat message (text, photo caption, or voice caption) — see `odd/tasks/mvp.md`: every chat message is also a raw-log entry. */
  entryId: string;
  onTextDelta?: (text: string) => void;
  onToolEvent?: (event: { name: string; statusSummary: string }) => void;
}

export interface AgentTurnResult {
  turnId: string;
  text: string;
  citations: Array<{ ref: string; sourceEntryId: string }>;
  stopReason: AgentStopReason;
  usage: AgentUsage;
  derivationPending: boolean;
  droppedHistoryCount: number;
  hitMaxIterations: boolean;
  /** True when a mid-turn tool exchange grew `messages` past the token budget — see the loop's own comment. */
  hitTokenBudget: boolean;
}

function toolResultBlocksFrom(
  toolUseBlocks: Array<{ id: string; name: string; input: unknown }>,
  results: Array<{ resultText: string; isError: boolean }>,
): AgentContentBlock[] {
  return toolUseBlocks.map((block, index) => {
    const result = results[index];
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: result?.resultText ?? "",
      ...(result?.isError ? { is_error: true } : {}),
    };
  });
}

export async function runAgentTurn(
  deps: AgentTurnDeps,
  params: AgentTurnParams,
): Promise<AgentTurnResult> {
  const turnId = randomUUID();
  const effort = deps.effort ?? DEFAULT_EFFORT;

  const { text: messageText, derivationPending } = await resolveMessageText(
    deps.db,
    params.entryId,
  );

  // History is loaded BEFORE this turn's own user row is persisted, so
  // it is never duplicated into `messages` below.
  const history = await loadRecentHistory(deps.db);
  await persistChatMessage(deps.db, {
    role: "user",
    content: [{ type: "text", text: messageText || "(sin texto)" }],
    entryId: params.entryId,
  });

  const tracker = new RefTracker();
  const hits = await deps.findHints(messageText);
  const promptHints: PromptContextHint[] = [];
  for (const hit of hits) {
    if (!hit.sourceEntryId) continue; // topic hits: listed by name only, see buildContextBlock.
    // Never cite the message's own just-created entry back at itself —
    // it is the current message, not a hint about anything else.
    if (hit.sourceEntryId === params.entryId) continue;
    const ref = tracker.assign(hit.sourceEntryId);
    const text = await fetchHitText(deps.db, hit);
    promptHints.push({ ref, scope: hit.scope, text });
  }

  const topicRows = await deps.db.select({ name: topics.name }).from(topics).orderBy(topics.name);
  const topicNames = topicRows.map((row) => row.name);

  let contextBlockText = buildContextBlock({ topicNames, hints: promptHints });
  if (derivationPending) {
    contextBlockText +=
      "\n\n(Note: this message's photo/voice text is still being processed after a bounded wait; continue with what is available and say so to the owner.)";
  }

  const systemPrompt = buildSystemPrompt();
  const apiUserMessage: AgentMessage = {
    role: "user",
    content: [
      { type: "text", text: contextBlockText },
      { type: "text", text: messageText || "(sin texto)" },
    ],
  };

  const effectiveBudget = deps.maxInputTokenBudget ?? MAX_INPUT_TOKEN_BUDGET;
  const systemTokens = estimateTokensForText(systemPrompt);
  const toolsTokens = estimateTokensForText(JSON.stringify(AGENT_TOOLS));
  const reservedTokens =
    systemTokens + toolsTokens + estimateTokensForMessage(apiUserMessage) + MAX_OUTPUT_TOKENS;
  const { kept: boundedHistory, droppedCount } = fitHistoryToBudget(
    history,
    reservedTokens,
    effectiveBudget,
  );
  if (droppedCount > 0) {
    console.warn(
      `agent turn ${turnId}: dropped ${droppedCount} oldest history message(s) to stay under the token budget`,
    );
  }

  const messages: AgentMessage[] = [...boundedHistory, apiUserMessage];
  const textChunks: string[] = [];
  let lastStopReason: AgentStopReason = "end_turn";
  let lastUsage: AgentUsage = { inputTokens: 0, outputTokens: 0 };
  let hitMaxIterations = false;
  let hitTokenBudget = false;

  /**
   * History is trimmed once, before the loop — but tool exchanges
   * added WITHIN this turn (tool_use/tool_result pairs, and any
   * thinking blocks) can only ever grow `messages` afterwards, never
   * shrink: trimming them would split a tool round or drop a thinking
   * block that a later block in the same turn still needs intact (see
   * `chat-history.ts`'s module comment). So re-checked here, before
   * EVERY call in the loop, not just once: if a turn's own accumulated
   * tool results would push this call over budget, stop offering tools
   * and ask for a plain-text final answer instead of growing further.
   */
  function currentRequestTokens(): number {
    return (
      systemTokens +
      toolsTokens +
      messages.reduce((sum, m) => sum + estimateTokensForMessage(m), 0) +
      MAX_OUTPUT_TOKENS
    );
  }

  for (let iteration = 1; iteration <= MAX_TOOL_ITERATIONS; iteration++) {
    const overBudget = currentRequestTokens() > effectiveBudget;
    if (overBudget) {
      hitTokenBudget = true;
    }

    const startedAt = Date.now();
    const result = await deps.claudeClient.runTurn(
      {
        system: [{ text: systemPrompt, cacheControl: true }],
        // No tools offered once over budget: the model cannot grow
        // `messages` any further this turn and is pushed toward a
        // final text answer instead.
        tools: overBudget ? [] : AGENT_TOOLS,
        messages,
        effort,
        maxTokens: MAX_OUTPUT_TOKENS,
      },
      (delta) => params.onTextDelta?.(delta),
    );
    const latencyMillis = Date.now() - startedAt;

    lastStopReason = result.stopReason;
    lastUsage = result.usage;

    await deps.db.insert(agentRuns).values({
      turnId,
      requestJson: {
        system: systemPrompt,
        messages,
        toolNames: overBudget ? [] : AGENT_TOOLS.map((t) => t.name),
      },
      stopReason: result.stopReason,
      usage: result.usage,
      estimatedCostUsd: estimateCostUsd(result.usage).toFixed(6),
      latencyMillis,
    });

    await persistChatMessage(deps.db, { role: "assistant", content: result.content });

    for (const block of result.content) {
      if (block.type === "text") {
        textChunks.push(block.text);
      }
    }

    messages.push({ role: "assistant", content: result.content });

    if (result.stopReason === "refusal" || result.stopReason === "max_tokens") {
      break;
    }

    if (overBudget) {
      // No tools were offered this call (see above) — whatever text
      // came back is this turn's final answer, win or lose.
      break;
    }

    const toolUseBlocks = result.content.filter(
      (block): block is { type: "tool_use"; id: string; name: string; input: unknown } =>
        block.type === "tool_use",
    );
    if (toolUseBlocks.length === 0) {
      break;
    }

    if (iteration === MAX_TOOL_ITERATIONS) {
      hitMaxIterations = true;
      textChunks.push(
        "\n\n(Llegué al límite de pasos para este turno; te cuento lo que pude resolver hasta ahora.)",
      );
      break;
    }

    const toolResults = await Promise.all(
      toolUseBlocks.map((block) =>
        executeTool(block.name, block.input, {
          db: deps.db,
          hybridSearch: deps.hybridSearch,
          memory: deps.memory,
          refTracker: tracker,
          turnId,
          defaultSourceEntryId: params.entryId,
        }),
      ),
    );

    for (const [index, block] of toolUseBlocks.entries()) {
      const toolResult = toolResults[index];
      if (toolResult) {
        params.onToolEvent?.({ name: block.name, statusSummary: toolResult.statusSummary });
      }
    }

    const toolResultBlocks = toolResultBlocksFrom(toolUseBlocks, toolResults);
    await persistChatMessage(deps.db, { role: "tool", content: toolResultBlocks });
    messages.push({ role: "user", content: toolResultBlocks });
  }

  const finalText = textChunks.join("");
  const citations = extractCitations(finalText, tracker);

  return {
    turnId,
    text: finalText,
    citations,
    stopReason: lastStopReason,
    usage: lastUsage,
    derivationPending,
    droppedHistoryCount: droppedCount,
    hitMaxIterations,
    hitTokenBudget,
  };
}
