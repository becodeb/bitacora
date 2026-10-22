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
  /** `null` when Claude refused or returned no usable text — the caller skips writing a rollup row for the day rather than storing an empty/garbage summary. */
  summary: string | null;
  usage: AgentUsage;
  /** The exact request sent, logged into `agent_runs.requestJson` the same way `agent/run-turn.ts` does. */
  requestJson: unknown;
}

export interface RollupSummarizer {
  summarize(params: RollupSummarizeParams): Promise<RollupSummarizeResult>;
}
