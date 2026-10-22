/**
 * Conservative char-based token-count estimate, used to keep every
 * request under Haiku 5.5's 100K-input-token pricing cliff (see
 * `pricing.ts`) BEFORE the call is made — the real token count is only
 * known from the API response's `usage`, too late to avoid an
 * over-budget request. `messages.countTokens` would be exact but costs
 * an extra API round-trip per turn iteration; a char-based estimate is
 * free and, divided conservatively, cannot under-count by much for
 * Spanish/English natural-language text (which generally runs closer
 * to 4 chars/token).
 */
import type { AgentContentBlock, AgentMessage } from "./types.js";

const CONSERVATIVE_CHARS_PER_TOKEN = 3;

/** Upper bound this budget enforces (see module comment); leaves headroom under the real 100K cliff for the estimate's conservatism and for `maxTokens` output. */
export const MAX_INPUT_TOKEN_BUDGET = 90_000;

export function estimateTokensForText(text: string): number {
  return Math.ceil(text.length / CONSERVATIVE_CHARS_PER_TOKEN);
}

function estimateTokensForBlock(block: AgentContentBlock): number {
  if (block.type === "text") return estimateTokensForText(block.text);
  if (block.type === "tool_use") return estimateTokensForText(JSON.stringify(block.input));
  return estimateTokensForText(block.content);
}

export function estimateTokensForMessage(message: AgentMessage): number {
  return message.content.reduce((sum, block) => sum + estimateTokensForBlock(block), 0);
}

/**
 * Drops the oldest messages (in pairs, so a `tool_use` is never
 * separated from its `tool_result`) until the remaining history plus
 * `reservedTokens` (system + tools + volatile context, estimated by the
 * caller) fits `budget`. Returns the kept messages and whether anything
 * was dropped, so the caller can log/report the truncation.
 */
export function fitHistoryToBudget(
  history: AgentMessage[],
  reservedTokens: number,
  budget: number = MAX_INPUT_TOKEN_BUDGET,
): { kept: AgentMessage[]; droppedCount: number } {
  let kept = history;
  let droppedCount = 0;

  const totalTokens = () =>
    reservedTokens + kept.reduce((sum, m) => sum + estimateTokensForMessage(m), 0);

  while (kept.length > 0 && totalTokens() > budget) {
    kept = kept.slice(1);
    droppedCount += 1;
  }

  return { kept, droppedCount };
}
