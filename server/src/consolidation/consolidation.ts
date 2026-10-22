/**
 * T08's nightly memory consolidation: merges near-duplicate live
 * memories and refreshes stale topic summaries. Every memory mutation
 * goes through `change_log` grouped by this run's own id, so it is
 * undoable with the existing `memory/service.ts`'s `undoTurn(runId)` —
 * each row here is written in exactly the shape (`memories`
 * insert/update, `before`/`after`) that function already knows how to
 * revert; see its own doc comment for what reverting an insert vs. an
 * update does.
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgBoss } from "pg-boss";
import { estimateCostUsd } from "../agent/pricing.js";
import type { AgentUsage } from "../agent/types.js";
import { agentRuns, changeLog, memories, topics } from "../db/schema.js";
import { enqueueEmbedJob } from "../jobs/embed.js";
import { bumpTopicMemoriesChanged } from "../memory/service.js";
import type {
  ConsolidationCandidate,
  ConsolidationDecision,
  ConsolidationJudge,
  TopicSummarizer,
} from "./types.js";

/**
 * Calibrated against `odd/tasks/mvp.md`'s T05 note: real `voyage-3.5`
 * related-but-distinct pairs scored 0.52-0.64, so a near-duplicate pair
 * (not just "related") should sit well above that gap. Started
 * deliberately high and documented here rather than tuned further
 * without real duplicate data yet — revisit once nightly runs have
 * produced some.
 */
export const VECTOR_DUP_SIMILARITY_MIN = 0.85;
/** `pg_trgm`'s whole-text `similarity()` (not `word_similarity`, per-word — see `search/hybrid-search.ts`'s own distinction) catches near-exact text even when one or both memories have no embedding yet. */
export const TRIGRAM_DUP_SIMILARITY_MIN = 0.9;
/** Bounds one run's work — see `odd/tasks/mvp.md`'s T08 spec. */
export const MAX_CANDIDATE_PAIRS_PER_RUN = 50;
/** A memory younger than this is never touched, so consolidation cannot race a live chat turn still reasoning about it (see `agent/run-turn.ts`'s own in-flight writes via `memory/service.ts`). */
export const DEFAULT_RECENT_MEMORY_GUARD_MINUTES = 30;
/** How many of a topic's live memories are sent to the topic summarizer — bounds both the prompt size and the cost of a topic with a very long history. */
const TOPIC_SUMMARY_MEMORY_LIMIT = 50;

export interface ConsolidationDeps {
  db: NodePgDatabase;
  boss: PgBoss;
  judge: ConsolidationJudge;
  topicSummarizer: TopicSummarizer;
  /** Overrides `DEFAULT_RECENT_MEMORY_GUARD_MINUTES` — mainly for tests. */
  recentMemoryGuardMinutes?: number;
}

interface CandidatePairRow {
  idA: string;
  contentA: string;
  topicIdA: string | null;
  sourceEntryIdA: string;
  /** Raw `db.execute` row — unlike a typed `db.select(...)`, this comes back as a string, not a `Date`; see `applyDecision`'s own normalization. */
  createdAtA: string;
  idB: string;
  contentB: string;
  topicIdB: string | null;
  sourceEntryIdB: string;
  createdAtB: string;
  vectorSimilarity: number | null;
  trigramSimilarity: number;
}

/**
 * Self-join over live memories, bounded to `MAX_CANDIDATE_PAIRS_PER_RUN`
 * and excluding anything younger than `cutoff`. No index backs this
 * (same tradeoff `search/hybrid-search.ts` makes for its own trigram
 * rankers): with a single owner and small tables, a sequential self-join
 * is not a performance concern.
 */
async function findCandidatePairs(db: NodePgDatabase, cutoff: Date): Promise<CandidatePairRow[]> {
  const result = await db.execute(sql`
    select
      a.id as "idA", a.content as "contentA", a.topic_id as "topicIdA",
      a.source_entry_id as "sourceEntryIdA", a.created_at as "createdAtA",
      b.id as "idB", b.content as "contentB", b.topic_id as "topicIdB",
      b.source_entry_id as "sourceEntryIdB", b.created_at as "createdAtB",
      case when a.embedding is not null and b.embedding is not null
        then 1 - (a.embedding <=> b.embedding) else null end as "vectorSimilarity",
      similarity(a.content, b.content) as "trigramSimilarity"
    from memories a
    join memories b on b.id > a.id
    where a.valid_to is null and b.valid_to is null
      and a.created_at < ${cutoff} and b.created_at < ${cutoff}
      and (
        (a.embedding is not null and b.embedding is not null
          and (1 - (a.embedding <=> b.embedding)) >= ${VECTOR_DUP_SIMILARITY_MIN})
        or similarity(a.content, b.content) >= ${TRIGRAM_DUP_SIMILARITY_MIN}
      )
    order by greatest(
      coalesce(case when a.embedding is not null and b.embedding is not null
        then 1 - (a.embedding <=> b.embedding) else null end, 0),
      coalesce(similarity(a.content, b.content), 0)
    ) desc
    limit ${MAX_CANDIDATE_PAIRS_PER_RUN}
  `);
  return result.rows as unknown as CandidatePairRow[];
}

function toJudgeCandidate(pair: CandidatePairRow): ConsolidationCandidate {
  return {
    idA: pair.idA,
    contentA: pair.contentA,
    idB: pair.idB,
    contentB: pair.contentB,
    vectorSimilarity: pair.vectorSimilarity,
    trigramSimilarity: pair.trigramSimilarity,
  };
}

async function isLiveMemory(
  // biome-ignore lint/suspicious/noExplicitAny: a Drizzle transaction, same structural-typing limitation as memory/service.ts.
  tx: any,
  id: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ validTo: memories.validTo })
    .from(memories)
    .where(eq(memories.id, id));
  return Boolean(row) && row.validTo === null;
}

async function logChangeLog(
  // biome-ignore lint/suspicious/noExplicitAny: same as above.
  tx: any,
  entry: {
    actionGroupId: string;
    targetId: string;
    operation: "insert" | "update";
    before: unknown;
    after: unknown;
  },
): Promise<void> {
  await tx.insert(changeLog).values({
    actionGroupId: entry.actionGroupId,
    targetTable: "memories" as const,
    targetId: entry.targetId,
    operation: entry.operation,
    before: entry.before ?? null,
    after: entry.after ?? null,
  });
}

async function invalidateMemory(
  // biome-ignore lint/suspicious/noExplicitAny: same as above.
  tx: any,
  runId: string,
  memoryId: string,
): Promise<void> {
  const now = new Date();
  await tx.update(memories).set({ validTo: now }).where(eq(memories.id, memoryId));
  await logChangeLog(tx, {
    actionGroupId: runId,
    targetId: memoryId,
    operation: "update",
    before: { validTo: null },
    after: { validTo: now.toISOString() },
  });
}

export type PairOutcome = "merged" | "a_supersedes_b" | "b_supersedes_a" | "kept_both" | "stale";

/**
 * Applies one pair's decision inside its own transaction. Re-checks both
 * memories are still live before mutating anything: candidates were all
 * fetched in one query up front (see `runNightlyConsolidation`), so an
 * earlier pair in the same run may have already invalidated one of
 * these two (e.g. A matched both B and C) — that pair is skipped as
 * `"stale"` rather than double-processed, and is a candidate again on a
 * future run if a genuine duplicate remains.
 */
async function applyDecision(
  deps: ConsolidationDeps,
  runId: string,
  pair: CandidatePairRow,
  decision: ConsolidationDecision,
): Promise<PairOutcome> {
  if (decision.action === "keep_both") {
    return "kept_both";
  }

  return deps.db.transaction(async (tx) => {
    const [liveA, liveB] = await Promise.all([
      isLiveMemory(tx, pair.idA),
      isLiveMemory(tx, pair.idB),
    ]);
    if (!liveA || !liveB) {
      return "stale";
    }

    if (decision.action === "merge") {
      const topicId = pair.topicIdA ?? pair.topicIdB ?? null;
      // `db.execute`'s raw rows are not passed through Drizzle's own
      // column type mapping — `created_at` comes back as a string, not
      // a `Date`, unlike every typed `db.select(...)` elsewhere in this
      // codebase — so both are normalized here before comparing.
      const newestSourceEntryId =
        new Date(pair.createdAtA).getTime() >= new Date(pair.createdAtB).getTime()
          ? pair.sourceEntryIdA
          : pair.sourceEntryIdB;
      const memoryId = randomUUID();
      const insertValues = {
        id: memoryId,
        content: decision.mergedContent,
        topicId,
        sourceEntryId: newestSourceEntryId,
        // One supersedes link only: both A and B are invalidated below
        // regardless, this just records which one the merged memory's
        // own lineage points at.
        supersedesId: pair.idA,
      };
      await tx.insert(memories).values(insertValues);
      await logChangeLog(tx, {
        actionGroupId: runId,
        targetId: memoryId,
        operation: "insert",
        before: null,
        after: insertValues,
      });
      await enqueueEmbedJob(deps.boss, { targetTable: "memories", targetId: memoryId }, tx);
      await bumpTopicMemoriesChanged(tx, topicId);

      await invalidateMemory(tx, runId, pair.idA);
      await invalidateMemory(tx, runId, pair.idB);
      return "merged";
    }

    if (decision.action === "a_supersedes_b") {
      await invalidateMemory(tx, runId, pair.idB);
      await bumpTopicMemoriesChanged(tx, pair.topicIdB);
      return "a_supersedes_b";
    }

    await invalidateMemory(tx, runId, pair.idA);
    await bumpTopicMemoriesChanged(tx, pair.topicIdA);
    return "b_supersedes_a";
  });
}

export interface MergeDuplicatesResult {
  runId: string;
  candidatePairCount: number;
  outcomes: Record<PairOutcome, number>;
}

/**
 * Logs one judge call into `agent_runs`, grouped under `runId` (this
 * job run) the same way `agent/run-turn.ts` groups its own calls under
 * a turn id — so T08's nightly cost is visible per run, not just per
 * individual call.
 */
async function logAgentRun(
  db: NodePgDatabase,
  params: {
    turnId: string;
    requestJson: unknown;
    stopReason: string;
    usage: AgentUsage;
    latencyMillis: number;
  },
): Promise<void> {
  await db.insert(agentRuns).values({
    turnId: params.turnId,
    requestJson: params.requestJson,
    stopReason: params.stopReason,
    usage: params.usage,
    estimatedCostUsd: estimateCostUsd(params.usage).toFixed(6),
    latencyMillis: params.latencyMillis,
  });
}

async function mergeDuplicates(
  deps: ConsolidationDeps,
  runId: string,
): Promise<MergeDuplicatesResult> {
  const guardMinutes = deps.recentMemoryGuardMinutes ?? DEFAULT_RECENT_MEMORY_GUARD_MINUTES;
  const cutoff = new Date(Date.now() - guardMinutes * 60 * 1000);
  const pairs = await findCandidatePairs(deps.db, cutoff);

  const outcomes: Record<PairOutcome, number> = {
    merged: 0,
    a_supersedes_b: 0,
    b_supersedes_a: 0,
    kept_both: 0,
    stale: 0,
  };

  for (const pair of pairs) {
    const startedAt = Date.now();
    const { decision, usage, requestJson } = await deps.judge.decide(toJudgeCandidate(pair));
    await logAgentRun(deps.db, {
      turnId: runId,
      requestJson,
      stopReason: decision.action === "keep_both" ? "end_turn" : "tool_use",
      usage,
      latencyMillis: Date.now() - startedAt,
    });

    const outcome = await applyDecision(deps, runId, pair, decision);
    outcomes[outcome] += 1;
  }

  return { runId, candidatePairCount: pairs.length, outcomes };
}

interface StaleTopic {
  id: string;
  name: string;
}

async function findStaleTopics(db: NodePgDatabase): Promise<StaleTopic[]> {
  const result = await db.execute(sql`
    select id, name
    from topics
    where memories_changed_at is not null
      and (summary_generated_at is null or memories_changed_at > summary_generated_at)
  `);
  return result.rows as unknown as StaleTopic[];
}

export interface RefreshTopicSummariesResult {
  staleTopicCount: number;
  refreshedTopicCount: number;
}

async function refreshTopicSummaries(
  deps: ConsolidationDeps,
  runId: string,
): Promise<RefreshTopicSummariesResult> {
  const staleTopics = await findStaleTopics(deps.db);
  let refreshedTopicCount = 0;

  for (const topic of staleTopics) {
    const liveMemories = await deps.db
      .select({ content: memories.content })
      .from(memories)
      .where(sql`${memories.topicId} = ${topic.id} and ${memories.validTo} is null`)
      .orderBy(sql`${memories.createdAt} desc`)
      .limit(TOPIC_SUMMARY_MEMORY_LIMIT);

    // A topic can go stale (its `memoriesChangedAt` bumped) and then end
    // up with no live memories at all (e.g. every one of them was just
    // merged away above) — nothing to summarize, and no model call for
    // it; `summaryGeneratedAt` is still stamped so it is not retried
    // forever.
    if (liveMemories.length === 0) {
      await deps.db
        .update(topics)
        .set({ summaryGeneratedAt: new Date() })
        .where(eq(topics.id, topic.id));
      continue;
    }

    const startedAt = Date.now();
    const result = await deps.topicSummarizer.summarize({
      topicName: topic.name,
      memoryContents: liveMemories.map((row) => row.content),
    });
    await logAgentRun(deps.db, {
      turnId: runId,
      requestJson: result.requestJson,
      stopReason: result.summary ? "end_turn" : "refusal",
      usage: result.usage,
      latencyMillis: Date.now() - startedAt,
    });

    if (!result.summary) {
      // Leave the old summary and `summaryGeneratedAt` alone: a
      // transient bad call is retried on the next nightly run, per
      // `TopicSummarizeResult`'s own doc comment — not marked done.
      continue;
    }

    // Deliberately not logged to `change_log`: a topic's `summary` is a
    // regenerable derived field (recomputed the same way `summary`
    // itself already is), not owner-authored content — the same
    // exemption `memory/service.ts`'s `findOrCreateTopic` already makes
    // for topic creation, for the same reason (nothing here is data the
    // owner would lose by not being able to undo it).
    await deps.db
      .update(topics)
      .set({ summary: result.summary, summaryGeneratedAt: new Date() })
      .where(eq(topics.id, topic.id));
    await enqueueEmbedJob(deps.boss, { targetTable: "topics", targetId: topic.id });
    refreshedTopicCount += 1;
  }

  return { staleTopicCount: staleTopics.length, refreshedTopicCount };
}

export interface RunNightlyConsolidationResult {
  runId: string;
  mergeDuplicates: MergeDuplicatesResult;
  topicSummaries: RefreshTopicSummariesResult;
}

/**
 * Runs one full nightly consolidation pass: merges duplicate memories,
 * then refreshes stale topic summaries (in that order, so a topic whose
 * memories were just merged gets a summary reflecting the merged state
 * in the same run instead of waiting another night). Safe to re-run:
 * duplicate-merge mutations are grouped under this call's own fresh
 * `runId` and are each independently undoable; topic summary refreshes
 * are idempotent regenerations.
 */
export async function runNightlyConsolidation(
  deps: ConsolidationDeps,
): Promise<RunNightlyConsolidationResult> {
  const runId = randomUUID();
  const mergeResult = await mergeDuplicates(deps, runId);
  const topicResult = await refreshTopicSummaries(deps, runId);
  return { runId, mergeDuplicates: mergeResult, topicSummaries: topicResult };
}
