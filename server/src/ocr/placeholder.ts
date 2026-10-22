import type { OcrPort } from "./types.js";

/**
 * Stands in for the real OCR engine until T07 picks one. Every photo's
 * derivation job resolves `not_available` through this, instead of
 * either blocking ingestion on an engine that does not exist yet, or
 * inventing OCR text no engine actually produced.
 */
export function createPlaceholderOcr(): OcrPort {
  return {
    async recognize() {
      return {
        status: "not_available",
        reason: "OCR engine not selected yet (see odd/tasks/mvp.md, task T07).",
      };
    },
  };
}
