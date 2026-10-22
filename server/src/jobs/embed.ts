import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { fromDrizzle, type PgBoss } from "pg-boss";
import { entries, memories, topics } from "../db/schema.js";
import type { Embedder } from "../embeddings/types.js";
import { EMBED_QUEUE, type EmbedJobData } from "./queues.js";

export interface EmbedDeps {
  db: NodePgDatabase;
  embedder: Embedder;
}

/**
 * Loads the text to embed for one target row, or `null` when there is
 * nothing worth embedding yet (e.g. a photo entry with no caption whose
 * OCR has not produced any text). `entries` combines the owner's own
 * text with its derived text (OCR/transcript), matching the column each
 * table's `search_vector` is generated from in `db/schema.ts`, so FTS
 * and vector search stay consistent about what counts as a row's text.
 */
async function loadTextToEmbed(deps: EmbedDeps, job: EmbedJobData): Promise<string | null> {
  switch (job.targetTable) {
    case "entries": {
      const [row] = await deps.db
        .select({ textBody: entries.textBody, derivedText: entries.derivedText })
        .from(entries)
        .where(sql`${entries.id} = ${job.targetId}`);
      if (!row) throw new Error(`entry ${job.targetId} not found`);
      return joinNonEmpty([row.textBody, row.derivedText]);
    }
    case "memories": {
      const [row] = await deps.db
        .select({ content: memories.content })
        .from(memories)
        .where(sql`${memories.id} = ${job.targetId}`);
      if (!row) throw new Error(`memory ${job.targetId} not found`);
      return joinNonEmpty([row.content]);
    }
    case "topics": {
      const [row] = await deps.db
        .select({ name: topics.name, description: topics.description, summary: topics.summary })
        .from(topics)
        .where(sql`${topics.id} = ${job.targetId}`);
      if (!row) throw new Error(`topic ${job.targetId} not found`);
      return joinNonEmpty([row.name, row.description, row.summary]);
    }
  }
}

function joinNonEmpty(parts: Array<string | null>): string | null {
  const text = parts.filter((part): part is string => Boolean(part && part.length > 0)).join(" ");
  return text.length > 0 ? text : null;
}

/**
 * Re-embed policy, per target table:
 *
 * - `entries` and `memories` are immutable once written (see their
 *   comments in `db/schema.ts`: an entry's own text is set once, a
 *   memory is never edited in place), so "write once" is correct and
 *   the update is guarded by `embedding IS NULL` — safe to retry, and a
 *   no-op if another attempt already wrote it.
 * - `topics` can be edited later (the "What I know about you" screen,
 *   T10), so its embedding is always overwritten. Callers are expected
 *   to only enqueue a topic's embedding when its name/description/
 *   summary actually changed.
 */
export async function processEmbedJob(deps: EmbedDeps, job: EmbedJobData): Promise<void> {
  const text = await loadTextToEmbed(deps, job);
  if (text === null) {
    return;
  }

  const [vector] = await deps.embedder.embed([text], "document");
  if (!vector) {
    throw new Error(`embedder returned no vector for ${job.targetTable} ${job.targetId}`);
  }

  switch (job.targetTable) {
    case "entries":
      await deps.db
        .update(entries)
        .set({ embedding: vector })
        .where(sql`${entries.id} = ${job.targetId} and ${entries.embedding} is null`);
      return;
    case "memories":
      await deps.db
        .update(memories)
        .set({ embedding: vector })
        .where(sql`${memories.id} = ${job.targetId} and ${memories.embedding} is null`);
      return;
    case "topics":
      await deps.db
        .update(topics)
        .set({ embedding: vector })
        .where(sql`${topics.id} = ${job.targetId}`);
      return;
  }
}

/**
 * Enqueues an embedding job for one entry/memory/topic row. Pass `tx`
 * (the active Drizzle transaction) to enqueue atomically alongside the
 * write that created or changed the row's text — the same `fromDrizzle`
 * pattern `ingestion/entries.ts` uses for the derivation queues.
 * Without `tx`, the job is sent on its own (used by the voice/photo jobs
 * once their own write already committed, and available to the T06
 * memory/topic writer when it is not already inside a transaction).
 */
export async function enqueueEmbedJob(
  boss: PgBoss,
  job: EmbedJobData,
  // biome-ignore lint/suspicious/noExplicitAny: fromDrizzle's TransactionLike is a minimal structural interface that a Drizzle transaction satisfies but TS cannot always see through the transaction callback's inferred type (same reasoning as `ingestion/entries.ts`).
  tx?: any,
): Promise<void> {
  await boss.send(EMBED_QUEUE, job, tx ? { db: fromDrizzle(tx, sql) } : undefined);
}

/** Just enough of pg-boss's `JobWithMetadata` for the retry-exhaustion check below; see `voice-transcribe.ts`'s `JobAttempt`. */
export interface JobAttempt {
  data: EmbedJobData;
  retryCount: number;
  retryLimit: number;
}

/**
 * Runs one attempt at an embed job. Unlike the voice/photo derivation
 * jobs, embeddable rows have no status column to flip to "failed" once
 * retries are exhausted — an embedding is either present or absent, and
 * absent just means search degrades to its lexical rankers for that row
 * (see `search/hybrid-search.ts`). So a failure here only logs and
 * re-throws for pg-boss's own retry/dead-letter handling; nothing else
 * in the app observes it directly.
 */
export async function runEmbedJobAttempt(deps: EmbedDeps, job: JobAttempt): Promise<void> {
  try {
    await processEmbedJob(deps, job.data);
  } catch (error) {
    console.error(
      `embedding failed for ${job.data.targetTable} ${job.data.targetId} (attempt ${job.retryCount}/${job.retryLimit}):`,
      error,
    );
    throw error;
  }
}

/** Registers the pg-boss worker for the embed queue. */
export function registerEmbedWorker(boss: PgBoss, deps: EmbedDeps): Promise<string> {
  return boss.work<EmbedJobData, void, { includeMetadata: true }>(
    EMBED_QUEUE,
    { includeMetadata: true },
    async ([job]) => {
      if (!job) return;
      await runEmbedJobAttempt(deps, job);
    },
  );
}
