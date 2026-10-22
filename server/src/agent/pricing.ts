/**
 * Haiku 5.5 pricing (`odd/tasks/mvp.md`, "Architecture"): $0.10 / $0.50
 * per MTok input/output for requests under 100K input tokens (5x above
 * that — `token-budget.ts`'s budget keeps every call under it, so the
 * 5x tier is never reached and not modeled here).
 *
 * Cache read/write pricing for `claude-haiku-5-5` was not found in the
 * bundled claude-api docs as of 2026-10-22, so cache tokens are recorded
 * in `agent_runs.usage` but not priced — `estimatedCostUsd` only covers
 * `inputTokens`/`outputTokens`, which makes it a (small) underestimate
 * whenever the cache was written or read. See `odd/tasks/mvp.md`'s T06
 * progress notes for this as an open gap.
 */
import type { AgentUsage } from "./types.js";

const INPUT_PRICE_PER_MILLION_TOKENS = 0.1;
const OUTPUT_PRICE_PER_MILLION_TOKENS = 0.5;

export function estimateCostUsd(usage: AgentUsage): number {
  return (
    (usage.inputTokens / 1_000_000) * INPUT_PRICE_PER_MILLION_TOKENS +
    (usage.outputTokens / 1_000_000) * OUTPUT_PRICE_PER_MILLION_TOKENS
  );
}
