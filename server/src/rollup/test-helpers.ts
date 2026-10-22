/**
 * Test-only helpers for rollup tests. Not matched by Vitest's
 * `src/**\/*.test.ts` include pattern — same convention as
 * `embeddings/test-helpers.ts`.
 */
import type { AgentUsage } from "../agent/types.js";
import type { RollupSummarizeParams, RollupSummarizer } from "./types.js";

const DEFAULT_USAGE: AgentUsage = { inputTokens: 10, outputTokens: 10 };

/** A real summary, or a non-`"ok"` outcome (refusal / error — see `types.ts`'s own doc comment). */
export type ScriptedRollupOutcome = { summary: string } | { outcome: "refusal" | "error" };

/**
 * A scriptable fake `RollupSummarizer`: returns the next scripted
 * outcome on each call, in order (defaulting to `"error"` once
 * exhausted, so an under-scripted test fails loudly rather than
 * quietly reusing the last one). Records every call's params in
 * `calls`.
 */
export function createScriptedRollupSummarizer(
  scripts: ScriptedRollupOutcome[],
): RollupSummarizer & { calls: RollupSummarizeParams[] } {
  const calls: RollupSummarizeParams[] = [];
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
