/**
 * Provider-independent port for the daily rollup's summarizer, mirroring
 * `agent/types.ts`'s `ClaudeClient` / `memory/types.ts`'s `MemoryJudge`
 * split between a domain port and its real Claude-backed implementation
 * (`claude-rollup.ts`) — so tests can script a fake instead of making a
 * real API call.
 */
import type { AgentUsage } from "../agent/types.js";

export interface RollupSummarizeParams {
  /** Buenos-Aires-local date label the summary is for, e.g. for the prompt's own reference to "today"/"that day". */
  dateLabel: string;
  /** The day's gathered raw content (entries + chat text), already assembled and budget-truncated by `rollup.ts`. */
  content: string;
}

export interface RollupSummarizeResult {
  /** `null` whenever `outcome` is not `"ok"` — the caller skips writing a rollup row for the day rather than storing an empty/garbage summary. */
  summary: string | null;
  usage: AgentUsage;
  /** The exact request sent, logged into `agent_runs.requestJson` the same way `agent/run-turn.ts` does. */
  requestJson: unknown;
  /**
   * `"ok"`: a real summary was produced. `"refusal"`: Claude's own
   * `stop_reason: "refusal"` — a legitimate model decision, not a bug.
   * `"error"`: anything else that kept a real summary from coming back
   * (the API call itself threw, or the response had no usable text) —
   * `rollup.ts` logs this distinctly into `agent_runs.stopReason` so it
   * is never mistaken for a genuine `end_turn` completion.
   */
  outcome: "ok" | "refusal" | "error";
}

export interface RollupSummarizer {
  summarize(params: RollupSummarizeParams): Promise<RollupSummarizeResult>;
}
