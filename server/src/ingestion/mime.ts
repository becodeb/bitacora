/**
 * The attachment kinds accepted by `POST /v1/entries`, and the mime/size
 * allowlist enforced for each. Anything outside this allowlist is
 * rejected with a 4xx before a single byte is written to disk.
 */
export type AttachmentKind = "photo" | "voice";

/**
 * Images: the mime types `entries.kind: "photo"` accepts.
 */
const PHOTO_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * Audio: the mime types `entries.kind: "voice"` accepts. Matches what
 * `transcription/audio-input.ts` and the Groq adapter
 * (`transcription/groq.ts`) recognize — this server records voice notes
 * as `.m4a` per `odd/tasks/mvp.md`, but a few other containers Groq's
 * Whisper endpoint documents support are accepted too, since the app
 * (or a future input path) is not the only source of voice attachments.
 */
const VOICE_MIME_TYPES = new Set([
  "audio/m4a",
  "audio/x-m4a",
  "audio/mp4",
  "audio/mpeg",
  "audio/mp3",
  "audio/ogg",
  "audio/webm",
  "audio/wav",
  "audio/x-wav",
  "audio/flac",
]);

const PHOTO_MAX_BYTES = 15 * 1024 * 1024; // 15 MiB: generous for a phone screenshot/photo.
const VOICE_MAX_BYTES = 25 * 1024 * 1024; // 25 MiB: Groq's documented free-tier file size cap.

export interface MimeAllowlistResult {
  kind: AttachmentKind;
  maxBytes: number;
}

/**
 * Classifies `mimeType` into an attachment kind and its size cap, or
 * `null` when the mime type is not in either allowlist — callers must
 * reject the upload with a 4xx in that case rather than guessing.
 */
export function classifyAttachmentMime(mimeType: string): MimeAllowlistResult | null {
  const normalized = mimeType.toLowerCase();

  if (PHOTO_MIME_TYPES.has(normalized)) {
    return { kind: "photo", maxBytes: PHOTO_MAX_BYTES };
  }

  if (VOICE_MIME_TYPES.has(normalized)) {
    return { kind: "voice", maxBytes: VOICE_MAX_BYTES };
  }

  return null;
}
