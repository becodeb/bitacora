import { PgBoss } from "pg-boss";
import { EMBED_QUEUE, PHOTO_OCR_QUEUE, VOICE_TRANSCRIPTION_QUEUE } from "./queues.js";

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
}
