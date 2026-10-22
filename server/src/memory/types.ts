/**
 * Mem0-style dedup decision for `rememberFact` (see `service.ts`). Kept
 * behind the `MemoryJudge` port so tests can script a fake judge
 * instead of making a real Claude call.
 */
export type JudgeDecision =
  | { action: "add" }
  | { action: "update"; supersedesId: string }
  | { action: "noop" };

/** One existing live memory offered to the judge as a dedup candidate. */
export interface MemoryJudgeCandidate {
  id: string;
  content: string;
  /** Cosine similarity to the new fact, in [-1, 1] (practically [0, 1] for short text). */
  similarity: number;
}

export interface MemoryJudgeParams {
  newContent: string;
  candidates: MemoryJudgeCandidate[];
}

/**
 * Decides whether a new fact should be added, should replace
 * (supersede) one of `candidates`, or is already covered by one of them
 * (NOOP). Never throws for a "the model didn't answer well" case —
 * implementations should fall back to a safe default (see
 * `claude-judge.ts`) and let the caller log it.
 */
export interface MemoryJudge {
  decide(params: MemoryJudgeParams): Promise<JudgeDecision>;
}
