/**
 * Test-only helpers for memory-service tests. Not matched by Vitest's
 * `src/**\/*.test.ts` include pattern — see the same convention in
 * `embeddings/test-helpers.ts`.
 */
import type { JudgeDecision, MemoryJudge, MemoryJudgeParams } from "./types.js";

/**
 * A scriptable fake `MemoryJudge`: returns the next decision from
 * `decisions` on each call (in order), or `fallback` once exhausted.
 * Records every call's params in `calls` so a test can assert what the
 * judge was actually asked.
 */
export function createScriptedJudge(
  decisions: JudgeDecision[],
  fallback: JudgeDecision = { action: "add" },
): MemoryJudge & { calls: MemoryJudgeParams[] } {
  const calls: MemoryJudgeParams[] = [];
  let index = 0;

  return {
    calls,
    async decide(params) {
      calls.push(params);
      const decision = decisions[index] ?? fallback;
      index += 1;
      return decision;
    },
  };
}
