/** pg-boss queue names for the two kinds of derivation work T04 runs. */
export const VOICE_TRANSCRIPTION_QUEUE = "voice-transcription";
export const PHOTO_OCR_QUEUE = "photo-ocr";

/** Payload shared by both derivation queues: enough to look up everything else from the DB. */
export interface DerivationJobData {
  entryId: string;
  attachmentId: string;
}
