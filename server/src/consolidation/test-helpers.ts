/**
 * Test-only helpers for consolidation tests. Not matched by Vitest's
 * `src/**\/*.test.ts` include pattern — same convention as
 * `embeddings/test-helpers.ts`.
 */
import type { AgentUsage } from "../agent/types.js";
import type {
  ConsolidationCandidate,
  ConsolidationDecision,
  ConsolidationJudge,
  TopicSummarizeParams,
  TopicSummarizer,
} from "./types.js";

const DEFAULT_USAGE: AgentUsage = { inputTokens: 5, outputTokens: 5 };

/**
 * A scriptable fake `ConsolidationJudge`: returns the next scripted
 * decision (or `fallback`, default `keep_both`) on each call, in order.
 * Records every call's candidate in `calls`.
 */
export function createScriptedConsolidationJudge(
  decisions: ConsolidationDecision[],
  fallback: ConsolidationDecision = { action: "keep_both" },
): ConsolidationJudge & { calls: ConsolidationCandidate[] } {
  const calls: ConsolidationCandidate[] = [];
  let index = 0;

  return {
    calls,
    async decide(candidate) {
      calls.push(candidate);
      const decision = decisions[index] ?? fallback;
      index += 1;
      return { decision, usage: DEFAULT_USAGE, requestJson: { candidate } };
    },
  };
}

/** A scriptable fake `TopicSummarizer`, same shape as `createScriptedConsolidationJudge`. */
export function createScriptedTopicSummarizer(
  summaries: Array<string | null>,
): TopicSummarizer & { calls: TopicSummarizeParams[] } {
  const calls: TopicSummarizeParams[] = [];
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
