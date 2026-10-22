/** pg-boss queue names for the two kinds of derivation work T04 runs. */
export const VOICE_TRANSCRIPTION_QUEUE = "voice-transcription";
export const PHOTO_OCR_QUEUE = "photo-ocr";

/** pg-boss queue name for T05's embedding work. */
export const EMBED_QUEUE = "embed";

/** pg-boss queue names for T08's nightly jobs, scheduled by `jobs/schedule.ts`. */
export const DAILY_ROLLUP_QUEUE = "daily-rollup";
export const NIGHTLY_CONSOLIDATION_QUEUE = "nightly-consolidation";

/**
 * Payload for the daily rollup queue/admin trigger. `date` is a
 * Buenos-Aires-local `YYYY-MM-DD` label; omitted means "yesterday",
 * computed at run time (see `lib/buenos-aires-date.ts`) — the scheduled
 * firing never bakes a date into the schedule's own stored payload,
 * since that would always roll up the same day.
 */
export interface DailyRollupJobData {
  date?: string;
}

/** The nightly consolidation job takes no parameters: it always acts on "now". */
export type NightlyConsolidationJobData = Record<string, never>;

/** Payload shared by both derivation queues: enough to look up everything else from the DB. */
export interface DerivationJobData {
  entryId: string;
  attachmentId: string;
}

/** The three tables T05 embeds. Each has an `embedding vector(1024)` column (see `db/schema.ts`). */
export type EmbeddableTable = "entries" | "memories" | "topics";

/** Payload for the embed queue: enough to look up the row's text and write its embedding back. */
export interface EmbedJobData {
  targetTable: EmbeddableTable;
  targetId: string;
}
