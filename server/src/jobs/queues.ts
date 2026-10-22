/** pg-boss queue names for the two kinds of derivation work T04 runs. */
export const VOICE_TRANSCRIPTION_QUEUE = "voice-transcription";
export const PHOTO_OCR_QUEUE = "photo-ocr";

/** pg-boss queue name for T05's embedding work. */
export const EMBED_QUEUE = "embed";

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
