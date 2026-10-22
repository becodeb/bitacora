/**
 * Test-only helpers for agent-loop tests. Not matched by Vitest's
 * `src/**\/*.test.ts` include pattern — same convention as
 * `embeddings/test-helpers.ts`.
 */
import type { AgentTurnDeps } from "./run-turn.js";
import type { ClaudeClient, ClaudeTurnRequest, ClaudeTurnResult } from "./types.js";

/**
 * A scriptable fake `ClaudeClient`: returns the next scripted
 * `ClaudeTurnResult` on each `runTurn` call (in order). Streams any
 * `text` blocks in the scripted result through `onTextDelta` as a
 * single chunk (good enough for tests — no real per-token streaming is
 * being exercised here, only that the callback fires). Records every
 * call's request in `calls` so a test can assert what was actually
 * sent (e.g. that `tool_choice` is never forced, or that a given fact
 * is or is not present in the request).
 */
export function createScriptedClaudeClient(
  scripts: ClaudeTurnResult[],
): ClaudeClient & { calls: ClaudeTurnRequest[] } {
  const calls: ClaudeTurnRequest[] = [];
  let index = 0;

  return {
    calls,
    async runTurn(request, onTextDelta) {
      // `request.messages` is the SAME array instance `run-turn.ts`'s
      // loop keeps mutating (`messages.push(...)`) on every later
      // iteration — recording `request` by reference would make every
      // entry in `calls` reflect the FINAL mutated state once the turn
      // finishes, not the state at the moment each call was actually
      // made. A structural clone snapshots it instead, so a test can
      // correctly inspect what an EARLIER call looked like.
      calls.push(structuredClone(request));
      const script = scripts[index];
      index += 1;
      if (!script) {
        throw new Error(`createScriptedClaudeClient: no script left for call #${index}`);
      }
      for (const block of script.content) {
        if (block.type === "text") {
          onTextDelta(block.text);
        }
      }
      return script;
    },
  };
}

/**
 * A stub `AgentTurnDeps` for tests that build an `AppDeps` but only
 * exercise routes unrelated to the agent/chat (e.g. `/health`,
 * `/v1/me`, `/v1/entries`) — same role as `ingestion/test-helpers.ts`'s
 * `createStubIngestDeps`. Every field is deliberately unusable; calling
 * into it is a bug in the test, not a case to support quietly.
 */
export function createStubAgentDeps(): AgentTurnDeps {
  return {
    db: undefined as unknown as AgentTurnDeps["db"],
    claudeClient: undefined as unknown as AgentTurnDeps["claudeClient"],
    hybridSearch: undefined as unknown as AgentTurnDeps["hybridSearch"],
    findHints: undefined as unknown as AgentTurnDeps["findHints"],
    memory: undefined as unknown as AgentTurnDeps["memory"],
  };
}
