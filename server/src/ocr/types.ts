/**
 * The OCR port. The engine itself is chosen later in T07 (see
 * `odd/tasks/mvp.md`); this interface lets the ingestion pipeline (T04)
 * wire a photo's derivation job today against a placeholder, without
 * inventing a fake OCR result to stand in for a real engine.
 */

export interface OcrInput {
  /** Absolute filesystem path to the photo, as `AttachmentStorage.resolvePath` returns it. */
  filePath: string;
  mimeType: string;
}

/**
 * Either the engine recognized text, or none is available yet. This is
 * not the same as failure: a missing engine is an expected, permanent
 * state for every photo until T07 ships, and must never be retried by
 * pg-boss the way a transient failure would be.
 */
export type OcrOutcome =
  | { status: "done"; text: string; confidence?: number }
  | { status: "not_available"; reason: string };

export interface OcrPort {
  recognize(input: OcrInput): Promise<OcrOutcome>;
}
