/**
 * The photo/voice attachment shapes the composer can stage before
 * sending, and the client-side mime/size allowlist. Mirrors (does not
 * import — the app and server are separate packages) the server's own
 * allowlist in `server/src/ingestion/mime.ts`, so an oversized or
 * unsupported file is rejected locally with a friendly message instead
 * of a round trip to the server's 413/415.
 */

export type AttachmentKind = "photo" | "voice";

export interface StagedAttachment {
  kind: AttachmentKind;
  /** A local `file://` (or `content://` on Android) URI, as returned by `expo-image-picker`, `expo-audio`, or `expo-share-intent`. */
  uri: string;
  mimeType: string;
  fileName: string;
  /** Only set for a `kind: "voice"` attachment, for the composer's recording-review UI. */
  durationMillis?: number;
}

const PHOTO_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const VOICE_MIME_TYPES = new Set([
  "audio/m4a",
  "audio/x-m4a",
  "audio/mp4",
  "audio/mpeg",
  "audio/mp3",
]);

const PHOTO_MAX_BYTES = 15 * 1024 * 1024;
const VOICE_MAX_BYTES = 25 * 1024 * 1024;

export interface AttachmentValidation {
  ok: boolean;
  /** One of the i18n keys under `chat.attachmentError*`, for the caller to translate — kept untranslated here since this module has no i18n context. */
  errorKey?: "unsupportedMime" | "tooLarge";
}

/** Classifies a mime type the same way the server's allowlist does, without importing server code. */
export function classifyAttachmentMime(
  mimeType: string,
): { kind: AttachmentKind; maxBytes: number } | null {
  const normalized = mimeType.toLowerCase();
  if (PHOTO_MIME_TYPES.has(normalized)) {
    return { kind: "photo", maxBytes: PHOTO_MAX_BYTES };
  }
  if (VOICE_MIME_TYPES.has(normalized)) {
    return { kind: "voice", maxBytes: VOICE_MAX_BYTES };
  }
  return null;
}

/** Validates a candidate attachment's mime type and (when known) size against the client-side allowlist above, mirroring the server's own limits so a rejection is caught before any upload starts. */
export function validateAttachment(
  mimeType: string,
  sizeBytes: number | undefined,
): AttachmentValidation {
  const classification = classifyAttachmentMime(mimeType);
  if (!classification) {
    return { ok: false, errorKey: "unsupportedMime" };
  }
  if (typeof sizeBytes === "number" && sizeBytes > classification.maxBytes) {
    return { ok: false, errorKey: "tooLarge" };
  }
  return { ok: true };
}
