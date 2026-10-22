import { PgBoss } from "pg-boss";
import {
  DAILY_ROLLUP_QUEUE,
  EMBED_QUEUE,
  NIGHTLY_CONSOLIDATION_QUEUE,
  PHOTO_OCR_QUEUE,
  VOICE_TRANSCRIPTION_QUEUE,
} from "./queues.js";
import { scheduleNightlyJobs } from "./schedule.js";

/**
 * T08's two nightly jobs are each idempotent and safe to re-run (see
 * `rollup/rollup.ts` and `consolidation/consolidation.ts`), so a retry
 * on transient failure (a dropped DB connection, a rate-limited Claude
 * call) is safe; kept shorter/fewer than the derivation queues' because
 * a nightly job failing all its retries just waits for tomorrow's run
 * (or an admin backfill) rather than blocking anything the owner is
 * waiting on.
 */
const NIGHTLY_JOB_RETRY_OPTIONS = {
  retryLimit: 2,
  retryDelay: 60,
  retryBackoff: true,
} as const;

/**
 * Retries a few times with backoff before giving up — a transcription
 * or OCR call can fail on a transient network/provider error, and the
 * owner is never blocked on it (ingestion already acknowledged). Not
 * used for the OCR queue's "not_available" outcome, which is not an
 * error and is never retried (see `ocr/placeholder.ts`).
 */
const DERIVATION_RETRY_OPTIONS = {
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
} as const;

/** Builds the pg-boss instance against the same Postgres database as the rest of the server. */
export function createBoss(databaseUrl: string): PgBoss {
  return new PgBoss(databaseUrl);
}

/**
 * Starts `boss` (installing/migrating its own `pgboss` schema on first
 * run) and creates both derivation queues. `createQueue` is idempotent,
 * so this is safe to call every time the server starts. Must resolve
 * before anything calls `boss.send()` for either queue, including the
 * ingestion path in `http/entries.ts`.
 */
export async function startBoss(boss: PgBoss): Promise<void> {
  await boss.start();
  await boss.createQueue(VOICE_TRANSCRIPTION_QUEUE, DERIVATION_RETRY_OPTIONS);
  await boss.createQueue(PHOTO_OCR_QUEUE, DERIVATION_RETRY_OPTIONS);
  // Same retry shape as the derivation queues: a Voyage call can fail on
  // a transient network/provider error, and nothing downstream blocks on
  // it (search just degrades, see `search/hybrid-search.ts`).
  await boss.createQueue(EMBED_QUEUE, DERIVATION_RETRY_OPTIONS);
  await boss.createQueue(DAILY_ROLLUP_QUEUE, NIGHTLY_JOB_RETRY_OPTIONS);
  await boss.createQueue(NIGHTLY_CONSOLIDATION_QUEUE, NIGHTLY_JOB_RETRY_OPTIONS);
  await scheduleNightlyJobs(boss);
}
