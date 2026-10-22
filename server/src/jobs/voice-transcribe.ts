import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgBoss } from "pg-boss";
import { attachments, entries } from "../db/schema.js";
import type { AttachmentStorage } from "../storage/attachment-storage.js";
import type { Transcriber } from "../transcription/types.js";
import { type DerivationJobData, VOICE_TRANSCRIPTION_QUEUE } from "./queues.js";

/** Voice notes are recorded in Spanish (Rioplatense), per `odd/tasks/mvp.md`. */
const TRANSCRIPTION_LANGUAGE = "es";

export interface VoiceTranscribeDeps {
  db: NodePgDatabase;
  storage: AttachmentStorage;
  transcriber: Transcriber;
}

/**
 * Transcribes one voice attachment and writes the result:
 * `entries.derivedText` is filled from the transcript (only ever
 * written once, guarded by `derived_text is null` below — see the
 * column's comment in `db/schema.ts`), and the attachment's status
 * moves from "pending" to "done". A thrown error leaves the status
 * "pending" and lets pg-boss retry per `DERIVATION_RETRY_OPTIONS`;
 * `attachments.derived_text_status` only ever becomes "failed" once
 * retries are exhausted, via `registerVoiceTranscribeWorker`'s catch
 * below.
 */
export async function processVoiceJob(
  deps: VoiceTranscribeDeps,
  job: DerivationJobData,
): Promise<void> {
  const row = await loadAttachmentRow(deps, job.attachmentId);

  const transcript = await deps.transcriber.transcribe({
    audio: deps.storage.resolvePath(row.storageKey),
    mimeType: row.mimeType,
    language: TRANSCRIPTION_LANGUAGE,
    diarize: false,
  });

  const text = transcript.segments
    .map((segment) => segment.text)
    .join(" ")
    .trim();

  await deps.db.transaction(async (tx) => {
    await tx.execute(
      sql`update ${entries} set derived_text = ${text} where id = ${job.entryId} and derived_text is null`,
    );
    await tx
      .update(attachments)
      .set({ derivedTextStatus: "done" })
      .where(sql`${attachments.id} = ${job.attachmentId}`);
  });
}

async function loadAttachmentRow(
  deps: VoiceTranscribeDeps,
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

/** Just enough of pg-boss's `JobWithMetadata` for the retry-exhaustion check below, kept narrow so it is easy to construct in tests without a real pg-boss job. */
export interface JobAttempt {
  data: DerivationJobData;
  retryCount: number;
  retryLimit: number;
}

/**
 * Runs one attempt at a voice-transcription job. On failure, always
 * re-throws so pg-boss counts it as a retry attempt (per
 * `DERIVATION_RETRY_OPTIONS` in `jobs/boss.ts`); the attachment's status
 * is only moved to "failed" once `retryCount` has reached `retryLimit`
 * — i.e. this was the last attempt pg-boss will make. Until then the
 * status stays "pending", since the job is still retriable and "failed"
 * would be misleading. Exported separately from
 * `registerVoiceTranscribeWorker` so tests can exercise the
 * retry/failed policy without a real pg-boss job object.
 */
export async function runVoiceJobAttempt(
  deps: VoiceTranscribeDeps,
  job: JobAttempt,
): Promise<void> {
  try {
    await processVoiceJob(deps, job.data);
  } catch (error) {
    console.error(`voice transcription failed for attachment ${job.data.attachmentId}:`, error);
    if (job.retryCount >= job.retryLimit) {
      await deps.db
        .update(attachments)
        .set({ derivedTextStatus: "failed" })
        .where(sql`${attachments.id} = ${job.data.attachmentId}`);
    }
    throw error;
  }
}

/** Registers the pg-boss worker for the voice-transcription queue; see `runVoiceJobAttempt` for the per-attempt policy. */
export function registerVoiceTranscribeWorker(
  boss: PgBoss,
  deps: VoiceTranscribeDeps,
): Promise<string> {
  return boss.work<DerivationJobData, void, { includeMetadata: true }>(
    VOICE_TRANSCRIPTION_QUEUE,
    { includeMetadata: true },
    async ([job]) => {
      if (!job) return;
      await runVoiceJobAttempt(deps, job);
    },
  );
}
