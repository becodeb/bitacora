/**
 * Test-only helpers for rollup tests. Not matched by Vitest's
 * `src/**\/*.test.ts` include pattern — same convention as
 * `embeddings/test-helpers.ts`.
 */
import type { AgentUsage } from "../agent/types.js";
import type { RollupSummarizeParams, RollupSummarizer } from "./types.js";

const DEFAULT_USAGE: AgentUsage = { inputTokens: 10, outputTokens: 10 };

/**
 * A scriptable fake `RollupSummarizer`: returns the next scripted
 * summary (or `null`, simulating a refusal/empty response) on each
 * call, in order. Records every call's params in `calls`.
 */
export function createScriptedRollupSummarizer(
  summaries: Array<string | null>,
): RollupSummarizer & { calls: RollupSummarizeParams[] } {
  const calls: RollupSummarizeParams[] = [];
  let index = 0;

  return {
    calls,
    async summarize(params) {
      calls.push(params);
      const summary = summaries[index] ?? null;
      index += 1;
      return { summary, usage: DEFAULT_USAGE, requestJson: { params } };
    },
  };
}
