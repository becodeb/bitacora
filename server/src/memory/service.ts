/**
 * Memory service: dedup'd fact writes, rule writes, and Undo. Every
 * mutation here is wrapped in a transaction and logged to `change_log`
 * grouped by `actionGroupId` (the calling turn's id), so `undoTurn` can
 * revert a whole turn's writes together (see that function's own
 * comment for exactly what is and is not undone).
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgBoss } from "pg-boss";
import { changeLog, memories, rules, topics } from "../db/schema.js";
import type { Embedder } from "../embeddings/types.js";
import { enqueueEmbedJob } from "../jobs/embed.js";
import type { JudgeDecision, MemoryJudge, MemoryJudgeCandidate } from "./types.js";

export interface MemoryServiceDeps {
  db: NodePgDatabase;
  boss: PgBoss;
  embedder: Embedder;
  judge: MemoryJudge;
}

/** How many existing live memories are offered to the judge as dedup candidates. */
const DEDUP_CANDIDATE_LIMIT = 5;

export interface RememberFactParams {
  content: string;
  topicName?: string;
  sourceEntryId: string;
  turnId: string;
}

export interface RememberFactResult {
  /** Absent for `action: "noop"`: nothing was written. */
  memoryId?: string;
  action: "add" | "update" | "noop";
  /** Set only for `action: "update"`: the memory the new one replaces. */
  supersededId?: string;
  topicId?: string;
}

export interface UpdateRuleParams {
  key: string;
  payload: unknown;
  topicName?: string;
  turnId: string;
}

export interface UpdateRuleResult {
  ruleId: string;
  action: "insert" | "update";
}

/**
 * Finds a topic by case-insensitive name, creating it (and enqueueing
 * its embedding) if it does not exist yet. Topic creation is
 * deliberately NOT logged to `change_log` / undone by `undoTurn` — see
 * that function's comment for why.
 */
async function findOrCreateTopic(
  deps: Pick<MemoryServiceDeps, "db" | "boss">,
  // biome-ignore lint/suspicious/noExplicitAny: a Drizzle transaction, same structural-typing limitation as ingestion/entries.ts.
  tx: any,
  name: string,
): Promise<string> {
  const [existing] = await tx
    .select({ id: topics.id })
    .from(topics)
    .where(sql`lower(${topics.name}) = lower(${name})`);
  if (existing) {
    return existing.id;
  }

  const topicId = randomUUID();
  await tx.insert(topics).values({ id: topicId, name });
  await enqueueEmbedJob(deps.boss, { targetTable: "topics", targetId: topicId }, tx);
  return topicId;
}

async function writeChangeLog(
  // biome-ignore lint/suspicious/noExplicitAny: same as findOrCreateTopic above.
  tx: any,
  entry: {
    actionGroupId: string;
    targetTable: "memories" | "rules" | "topics";
    targetId: string;
    operation: "insert" | "update" | "delete";
    before: unknown;
    after: unknown;
  },
): Promise<void> {
  await tx.insert(changeLog).values({
    actionGroupId: entry.actionGroupId,
    targetTable: entry.targetTable,
    targetId: entry.targetId,
    operation: entry.operation,
    before: entry.before ?? null,
    after: entry.after ?? null,
  });
}

/**
 * Finds the `DEDUP_CANDIDATE_LIMIT` live memories most similar to
 * `content` (optionally restricted to one topic), asks the judge to
 * decide ADD / UPDATE / NOOP, and applies that decision:
 *
 * - `add`: inserts a new memory (creating its topic on demand) and
 *   enqueues its embedding.
 * - `update`: inserts a new memory with `supersedesId` pointing at the
 *   judge's chosen candidate, and sets that candidate's `validTo` to
 *   now — both in the same transaction, both logged.
 * - `noop`: nothing is written; the existing candidate already covers
 *   this fact.
 *
 * `embedder.embed` can fail (e.g. Voyage rate-limited, see
 * `odd/tasks/mvp.md`'s T05 notes): dedup then degrades to "no
 * candidates found", so the judge only ever sees `add` as an option.
 * This is a deliberate trade-off: a transient embedding outage must
 * never block remembering a new fact, even if it means an occasional
 * avoidable duplicate that nightly consolidation (T08) can merge later.
 */
export async function rememberFact(
  deps: MemoryServiceDeps,
  params: RememberFactParams,
): Promise<RememberFactResult> {
  const candidates = await findDedupCandidates(deps, params.content, params.topicName);
  const rawDecision = await deps.judge.decide({ newContent: params.content, candidates });
  const decision = normalizeJudgeDecision(rawDecision, candidates);

  return deps.db.transaction(async (tx) => {
    const topicId = params.topicName
      ? await findOrCreateTopic(deps, tx, params.topicName)
      : undefined;

    if (decision.action === "noop") {
      return { action: "noop" as const, topicId };
    }

    const memoryId = randomUUID();
    const insertValues = {
      id: memoryId,
      content: params.content,
      topicId: topicId ?? null,
      sourceEntryId: params.sourceEntryId,
      supersedesId: decision.action === "update" ? decision.supersedesId : null,
    };
    await tx.insert(memories).values(insertValues);
    await writeChangeLog(tx, {
      actionGroupId: params.turnId,
      targetTable: "memories",
      targetId: memoryId,
      operation: "insert",
      before: null,
      after: insertValues,
    });
    await enqueueEmbedJob(deps.boss, { targetTable: "memories", targetId: memoryId }, tx);

    if (decision.action === "update") {
      const [before] = await tx
        .select({ validTo: memories.validTo })
        .from(memories)
        .where(eq(memories.id, decision.supersedesId));
      const now = new Date();
      await tx.update(memories).set({ validTo: now }).where(eq(memories.id, decision.supersedesId));
      await writeChangeLog(tx, {
        actionGroupId: params.turnId,
        targetTable: "memories",
        targetId: decision.supersedesId,
        operation: "update",
        before: { validTo: before?.validTo ?? null },
        after: { validTo: now.toISOString() },
      });
      return {
        memoryId,
        action: "update" as const,
        supersededId: decision.supersedesId,
        topicId,
      };
    }

    return { memoryId, action: "add" as const, topicId };
  });
}

/**
 * Guards against a judge that returns `update` with a `supersedesId`
 * that was never offered to it as a candidate — a hallucinated or
 * otherwise-real-but-unrelated memory id, from a judge implementation
 * that does not validate its own tool input as strictly as
 * `claude-judge.ts` does (or a future one that doesn't validate at
 * all). Downgraded to `add`, not `noop`: this project's existing
 * stance (see `rememberFact`'s own comment on a degraded-candidates
 * outage) is that an occasional avoidable duplicate — fixable later by
 * nightly consolidation, T08 — is the safer failure than silently
 * dropping a fact the owner told it. Logged so it is visible rather
 * than silent.
 */
function normalizeJudgeDecision(
  decision: JudgeDecision,
  candidates: MemoryJudgeCandidate[],
): JudgeDecision {
  if (decision.action !== "update") {
    return decision;
  }
  if (candidates.some((candidate) => candidate.id === decision.supersedesId)) {
    return decision;
  }
  console.warn(
    `rememberFact: judge chose to supersede memory ${decision.supersedesId}, which was not among the ${candidates.length} candidate(s) it was shown; treating as add instead.`,
  );
  return { action: "add" };
}

async function findDedupCandidates(
  deps: Pick<MemoryServiceDeps, "db" | "embedder">,
  content: string,
  topicName: string | undefined,
): Promise<Array<{ id: string; content: string; similarity: number }>> {
  let vector: number[] | undefined;
  try {
    [vector] = await deps.embedder.embed([content], "document");
  } catch (error) {
    console.error(
      "rememberFact: embedding the new fact failed, degrading to no candidates:",
      error,
    );
    return [];
  }
  if (!vector) {
    return [];
  }

  const vectorLiteral = `[${vector.join(",")}]`;
  const topicFilter = topicName
    ? sql`and ${memories.topicId} in (select id from ${topics} where lower(${topics.name}) = lower(${topicName}))`
    : sql``;

  const result = await deps.db.execute(sql`
    select id, content, 1 - (embedding <=> ${vectorLiteral}::vector) as similarity
    from ${memories}
    where valid_to is null and embedding is not null ${topicFilter}
    order by embedding <=> ${vectorLiteral}::vector asc
    limit ${DEDUP_CANDIDATE_LIMIT}
  `);

  return (result.rows as unknown as Array<{ id: string; content: string; similarity: number }>).map(
    (row) => ({ id: row.id, content: row.content, similarity: Number(row.similarity) }),
  );
}

/**
 * Inserts or updates a rule by its (globally unique, per
 * `db/schema.ts`'s `rules_key_unique_idx`) key, logging before/after.
 * `topicName` only sets the rule's `topicId` when creating or updating
 * it — it does not scope uniqueness, since `rules.key` is unique across
 * topics (see `odd/tasks/mvp.md`'s T03 "Open" note).
 */
export async function updateRule(
  deps: Pick<MemoryServiceDeps, "db" | "boss">,
  params: UpdateRuleParams,
): Promise<UpdateRuleResult> {
  return deps.db.transaction(async (tx) => {
    const topicId = params.topicName
      ? await findOrCreateTopic(deps, tx, params.topicName)
      : undefined;

    const [existing] = await tx.select().from(rules).where(eq(rules.key, params.key));

    if (!existing) {
      const ruleId = randomUUID();
      const insertValues = {
        id: ruleId,
        key: params.key,
        kind: "config",
        payload: params.payload,
        topicId: topicId ?? null,
      };
      await tx.insert(rules).values(insertValues);
      await writeChangeLog(tx, {
        actionGroupId: params.turnId,
        targetTable: "rules",
        targetId: ruleId,
        operation: "insert",
        before: null,
        after: insertValues,
      });
      return { ruleId, action: "insert" as const };
    }

    const before = {
      payload: existing.payload,
      topicId: existing.topicId,
      active: existing.active,
    };
    const after = {
      payload: params.payload,
      topicId: topicId ?? existing.topicId,
      active: true,
    };
    await tx
      .update(rules)
      .set({
        payload: after.payload,
        topicId: after.topicId,
        active: after.active,
        updatedAt: new Date(),
      })
      .where(eq(rules.id, existing.id));
    await writeChangeLog(tx, {
      actionGroupId: params.turnId,
      targetTable: "rules",
      targetId: existing.id,
      operation: "update",
      before,
      after,
    });
    return { ruleId: existing.id, action: "update" as const };
  });
}

export interface UndoResult {
  turnId: string;
  revertedCount: number;
}

/**
 * Reverts every not-yet-undone `change_log` row grouped under `turnId`,
 * in reverse chronological order, and marks each `undoneAt`. Idempotent:
 * calling it again on an already-undone turn finds no live rows and
 * reverts nothing.
 *
 * Deliberately NOT undone:
 *
 * - **Topic creation.** A topic created on demand while remembering a
 *   fact is never deleted by undo: by the time of a correction, a later
 *   turn's own memory may already reference the same topic, and
 *   deleting it would silently clear that memory's `topicId` (the FK is
 *   `ON DELETE SET NULL`) even though that other memory was never part
 *   of this undo. Topic creation is therefore not logged to
 *   `change_log` at all (see `findOrCreateTopic`) — an orphaned empty
 *   topic after an undone `remember` is the accepted, documented cost.
 *
 * What undo does revert, per `change_log` row:
 *
 * - `memories` `insert`: the inserted memory is hard-deleted, not just
 *   invalidated. Chosen over soft-invalidation (set `validTo`) because
 *   within one turn a newly-remembered fact cannot yet have been
 *   "cited" by anything else the owner can see — no later memory can
 *   supersede it before this undo runs (there is no later turn yet),
 *   and the chat UI shows it was just undone. A soft invalidation would
 *   leave a dead row with no way to tell it apart from a real historical
 *   fact later. The FK `supersedesId` is `ON DELETE SET NULL`, so
 *   deleting it is always safe even if an update op in the same group
 *   pointed at it.
 * - `memories` `update`: this is always the "supersede" half of an
 *   UPDATE decision (`rememberFact`'s only other write to an existing
 *   memory row) — reverted by restoring `before.validTo` (`null`),
 *   making the candidate live again.
 * - `rules` `insert`: hard-deleted.
 * - `rules` `update`: restored from `before` (`payload`, `topicId`,
 *   `active`).
 */
export async function undoTurn(
  deps: Pick<MemoryServiceDeps, "db">,
  turnId: string,
): Promise<UndoResult> {
  return deps.db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(changeLog)
      .where(and(eq(changeLog.actionGroupId, turnId), isNull(changeLog.undoneAt)))
      .orderBy(desc(changeLog.createdAt));

    for (const row of rows) {
      if (row.targetTable === "memories") {
        if (row.operation === "insert") {
          await tx.delete(memories).where(eq(memories.id, row.targetId));
        } else if (row.operation === "update") {
          const before = row.before as { validTo: string | null } | null;
          await tx
            .update(memories)
            .set({ validTo: before?.validTo ? new Date(before.validTo) : null })
            .where(eq(memories.id, row.targetId));
        }
      } else if (row.targetTable === "rules") {
        if (row.operation === "insert") {
          await tx.delete(rules).where(eq(rules.id, row.targetId));
        } else if (row.operation === "update") {
          const before = row.before as {
            payload: unknown;
            topicId: string | null;
            active: boolean;
          } | null;
          if (before) {
            await tx
              .update(rules)
              .set({ payload: before.payload, topicId: before.topicId, active: before.active })
              .where(eq(rules.id, row.targetId));
          }
        }
      }

      await tx.update(changeLog).set({ undoneAt: new Date() }).where(eq(changeLog.id, row.id));
    }

    return { turnId, revertedCount: rows.length };
  });
}

/** Undoes the most recently created, not-yet-undone turn's change group. No-op (reverts 0) if there is none. */
export async function undoLast(deps: Pick<MemoryServiceDeps, "db">): Promise<UndoResult | null> {
  const [latest] = await deps.db
    .select({ actionGroupId: changeLog.actionGroupId })
    .from(changeLog)
    .where(isNull(changeLog.undoneAt))
    .orderBy(desc(changeLog.createdAt))
    .limit(1);

  if (!latest) {
    return null;
  }

  return undoTurn(deps, latest.actionGroupId);
}
