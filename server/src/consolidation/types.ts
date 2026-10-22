/**
 * Dedup-merge decision for the nightly consolidation job (T08), asked
 * about one candidate pair of similar live memories. Shaped like
 * `memory/types.ts`'s `JudgeDecision` (same reasoning: a narrow,
 * structured decision behind a port, so tests script a fake judge
 * instead of a real Claude call) but with a different action set — this
 * judge compares two existing memories to each other, not one new fact
 * against several candidates.
 */
import type { AgentUsage } from "../agent/types.js";

export type ConsolidationDecision =
  | { action: "merge"; mergedContent: string }
  | { action: "keep_both" }
  | { action: "a_supersedes_b" }
  | { action: "b_supersedes_a" };

export interface ConsolidationCandidate {
  idA: string;
  contentA: string;
  idB: string;
  contentB: string;
  /** Cosine similarity between the two memories' embeddings, when both have one — see `consolidation.ts`'s candidate query. */
  vectorSimilarity: number | null;
  /** `pg_trgm` whole-text `similarity()` between the two contents. */
  trigramSimilarity: number;
}

/**
 * Decides whether `candidate`'s two memories should be merged into one,
 * kept as-is, or have one supersede the other. Never throws for a
 * "the model didn't answer well" case — falls back to `keep_both` (see
 * `claude-consolidation-judge.ts`), the only decision with no data-loss
 * risk, and lets the caller log it.
 */
export interface ConsolidationDecisionResult {
  decision: ConsolidationDecision;
  usage: AgentUsage;
  /** Logged into `agent_runs.requestJson`, same convention as `agent/run-turn.ts` and `rollup/claude-rollup.ts`. */
  requestJson: unknown;
}

export interface ConsolidationJudge {
  decide(candidate: ConsolidationCandidate): Promise<ConsolidationDecisionResult>;
}

export interface TopicSummarizeParams {
  topicName: string;
  /** The topic's live memories' content, newest first, already bounded to a fixed count by the caller. */
  memoryContents: string[];
}

export interface TopicSummarizeResult {
  /** `null` on refusal/empty output — the caller skips the write and leaves the old summary + `summaryGeneratedAt` in place, so a transient bad call is retried on the next nightly run rather than wiping a good summary. */
  summary: string | null;
  usage: AgentUsage;
  requestJson: unknown;
}

export interface TopicSummarizer {
  summarize(params: TopicSummarizeParams): Promise<TopicSummarizeResult>;
}
