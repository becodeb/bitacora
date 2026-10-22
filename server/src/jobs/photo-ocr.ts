import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgBoss } from "pg-boss";
import { attachments, entries } from "../db/schema.js";
import type { OcrPort } from "../ocr/types.js";
import type { AttachmentStorage } from "../storage/attachment-storage.js";
import { enqueueEmbedJob } from "./embed.js";
import { type DerivationJobData, PHOTO_OCR_QUEUE } from "./queues.js";

export interface PhotoOcrDeps {
  db: NodePgDatabase;
  storage: AttachmentStorage;
  ocr: OcrPort;
  boss: PgBoss;
}

/**
 * Runs OCR on one photo attachment. Two distinct non-error outcomes:
 *
 * - `done`: the recognized text is written to `entries.derivedText`
 *   (once, guarded by `derived_text is null` — see `db/schema.ts`), and
 *   the attachment's status becomes "done".
 * - `not_available`: today's only real outcome, since the OCR engine is
 *   chosen in T07 (`ocr/placeholder.ts`). The attachment's status
 *   becomes "not_available" — a permanent, expected state, never
 *   retried, and never confused with an actual OCR failure.
 *
 * A thrown error (e.g. the file cannot be read) is left to
 * `registerPhotoOcrWorker` below, same retry/failed handling as voice.
 */
export async function processPhotoJob(deps: PhotoOcrDeps, job: DerivationJobData): Promise<void> {
  const row = await loadAttachmentRow(deps, job.attachmentId);

  const outcome = await deps.ocr.recognize({
    filePath: deps.storage.resolvePath(row.storageKey),
    mimeType: row.mimeType,
  });

  if (outcome.status === "not_available") {
    await deps.db
      .update(attachments)
      .set({ derivedTextStatus: "not_available" })
      .where(sql`${attachments.id} = ${job.attachmentId}`);
    return;
  }

  await deps.db.transaction(async (tx) => {
    const updated = await tx.execute(
      sql`update ${entries} set derived_text = ${outcome.text} where id = ${job.entryId} and derived_text is null`,
    );
    await tx
      .update(attachments)
      .set({ derivedTextStatus: "done" })
      .where(sql`${attachments.id} = ${job.attachmentId}`);

    // Same "only on the write that actually happened" guard as
    // `voice-transcribe.ts`'s `processVoiceJob` — see its comment.
    if (updated.rowCount && updated.rowCount > 0) {
      await enqueueEmbedJob(deps.boss, { targetTable: "entries", targetId: job.entryId }, tx);
    }
  });
}

async function loadAttachmentRow(
  deps: PhotoOcrDeps,
  attachmentId: string,
): Promise<{ storageKey: string; mimeType: string }> {
  const [row] = await deps.db
    .select({ storageKey: attachments.storageKey, mimeType: attachments.mimeType })
    .from(attachments)
    .where(sql`${attachments.id} = ${attachmentId}`);

  if (!row) {
    throw new Error(`attachment ${attachmentId} not found`);
  }

  return row;
}

/** Just enough of pg-boss's `JobWithMetadata` for the retry-exhaustion check below; see `voice-transcribe.ts`'s `JobAttempt`. */
export interface JobAttempt {
  data: DerivationJobData;
  retryCount: number;
  retryLimit: number;
}

/**
 * Runs one attempt at a photo-OCR job, with the same retry/failed
 * policy as `runVoiceJobAttempt` in `voice-transcribe.ts`. Note that an
 * `ocr.recognize()` resolving `not_available` is handled inside
 * `processPhotoJob` above and never reaches this catch — it is not an
 * error, so it is never retried and never marks the attachment
 * "failed".
 */
export async function runPhotoJobAttempt(deps: PhotoOcrDeps, job: JobAttempt): Promise<void> {
  try {
    await processPhotoJob(deps, job.data);
  } catch (error) {
    console.error(`photo OCR failed for attachment ${job.data.attachmentId}:`, error);
    if (job.retryCount >= job.retryLimit) {
      await deps.db
        .update(attachments)
        .set({ derivedTextStatus: "failed" })
        .where(sql`${attachments.id} = ${job.data.attachmentId}`);
    }
    throw error;
  }
}

/** Registers the pg-boss worker for the photo-ocr queue; see `runPhotoJobAttempt` for the per-attempt policy. */
export function registerPhotoOcrWorker(boss: PgBoss, deps: PhotoOcrDeps): Promise<string> {
  return boss.work<DerivationJobData, void, { includeMetadata: true }>(
    PHOTO_OCR_QUEUE,
    { includeMetadata: true },
    async ([job]) => {
      if (!job) return;
      await runPhotoJobAttempt(deps, job);
    },
  );
}
