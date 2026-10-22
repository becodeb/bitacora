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
  if (block.type === "tool_result") return estimateTokensForText(block.content);
  if (block.type === "thinking") return estimateTokensForText(block.thinking);
  // redacted_thinking: `data` is opaque/encrypted, not reasoning text —
  // a fixed small estimate stands in for it rather than sizing the
  // (unrelated) byte length of the encrypted blob.
  return 16;
}

export function estimateTokensForMessage(message: AgentMessage): number {
  return message.content.reduce((sum, block) => sum + estimateTokensForBlock(block), 0);
}

/**
 * A plain user turn: the owner's own message (text only — never a
 * `tool_result` reply, which is also sent as `role: "user"` per
 * Anthropic's API, see `chat-history.ts`). This is the only point in
 * the stored history where it is ever valid to start a request's
 * `messages` array: starting mid-exchange would either begin with an
 * `assistant` message (invalid — the API requires the first message to
 * be `role: "user"`) or with an orphan `tool_result` whose matching
 * `tool_use` was dropped (a 400 from the API either way).
 */
function isExchangeStart(message: AgentMessage): boolean {
  return message.role === "user" && message.content.every((block) => block.type === "text");
}

/**
 * Groups `history` into exchanges: each one starts at an
 * `isExchangeStart` message and includes every message up to (not
 * including) the next one. A leading fragment with no such message at
 * all (e.g. history that was already truncated badly before this
 * function existed) becomes its own exchange so it is still a candidate
 * to drop, never silently kept.
 */
function splitIntoExchanges(history: AgentMessage[]): AgentMessage[][] {
  const exchanges: AgentMessage[][] = [];
  for (const message of history) {
    if (exchanges.length === 0 || isExchangeStart(message)) {
      exchanges.push([message]);
    } else {
      exchanges[exchanges.length - 1]?.push(message);
    }
  }
  return exchanges;
}

/**
 * Drops the oldest whole exchanges (an owner message plus every
 * assistant/tool-result message that followed it, up to the next owner
 * message) until the remaining history plus `reservedTokens` (system +
 * tools + volatile context, estimated by the caller) fits `budget`.
 * Dropping by exchange — never by individual message — is what
 * guarantees the result either is empty or starts with a plain user
 * text message: splitting an exchange could otherwise leave an orphan
 * `tool_result` (whose `tool_use` got dropped) or a leading `assistant`
 * message at the head of `messages`, both of which the API rejects
 * with a 400. Returns the kept messages and how many were dropped, so
 * the caller can log/report the truncation.
 */
export function fitHistoryToBudget(
  history: AgentMessage[],
  reservedTokens: number,
  budget: number = MAX_INPUT_TOKEN_BUDGET,
): { kept: AgentMessage[]; droppedCount: number } {
  let exchanges = splitIntoExchanges(history);
  let droppedCount = 0;

  const flatten = () => exchanges.flat();
  const totalTokens = () =>
    reservedTokens + flatten().reduce((sum, m) => sum + estimateTokensForMessage(m), 0);

  for (;;) {
    const [first, ...rest] = exchanges;
    if (!first) {
      break;
    }
    // The second condition only ever fires for a leading fragment with
    // no proper exchange start at all (see `splitIntoExchanges`) — it
    // is always safe to drop, since keeping it would violate the
    // "starts with a plain user message" guarantee regardless of
    // budget.
    const firstMessage = first[0];
    if (totalTokens() <= budget && firstMessage && isExchangeStart(firstMessage)) {
      break;
    }
    droppedCount += first.length;
    exchanges = rest;
  }

  return { kept: flatten(), droppedCount };
}
