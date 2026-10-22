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
 * decision (or `fallback`, default `keep_both`) on each call, in order,
 * tagged with `outcome` (default `"ok"` — pass `"refusal"`/`"error"` to
 * simulate a judge call that fell back rather than reaching a genuine
 * decision; see `types.ts`'s own doc comment). Records every call's
 * candidate in `calls`.
 */
export function createScriptedConsolidationJudge(
  decisions: ConsolidationDecision[],
  options: {
    fallback?: ConsolidationDecision;
    outcomes?: Array<"ok" | "refusal" | "error">;
  } = {},
): ConsolidationJudge & { calls: ConsolidationCandidate[] } {
  const fallback = options.fallback ?? { action: "keep_both" };
  const calls: ConsolidationCandidate[] = [];
  let index = 0;

  return {
    calls,
    async decide(candidate) {
      calls.push(candidate);
      const decision = decisions[index] ?? fallback;
      const outcome = options.outcomes?.[index] ?? "ok";
      index += 1;
      return { decision, usage: DEFAULT_USAGE, requestJson: { candidate }, outcome };
    },
  };
}

/** A real summary, or a non-`"ok"` outcome (refusal / error — see `types.ts`'s own doc comment). Same shape as `rollup/test-helpers.ts`'s `ScriptedRollupOutcome`. */
export type ScriptedTopicSummaryOutcome = { summary: string } | { outcome: "refusal" | "error" };

/** A scriptable fake `TopicSummarizer`, same shape as `createScriptedConsolidationJudge`. */
export function createScriptedTopicSummarizer(
  scripts: ScriptedTopicSummaryOutcome[],
): TopicSummarizer & { calls: TopicSummarizeParams[] } {
  const calls: TopicSummarizeParams[] = [];
  let index = 0;

  return {
    calls,
    async summarize(params) {
      calls.push(params);
      const script = scripts[index] ?? { outcome: "error" as const };
      index += 1;
      if ("summary" in script) {
        return {
          summary: script.summary,
          usage: DEFAULT_USAGE,
          requestJson: { params },
          outcome: "ok",
        };
      }
      return {
        summary: null,
        usage: DEFAULT_USAGE,
        requestJson: { params },
        outcome: script.outcome,
      };
    },
  };
}
