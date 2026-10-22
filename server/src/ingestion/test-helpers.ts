/**
 * Test-only helpers shared by `AppDeps`-building test suites. Not
 * matched by Vitest's `src/**\/*.test.ts` include pattern, so this file
 * is never itself run as a test.
 */
import type { IngestDeps } from "./entries.js";

/**
 * A stub `IngestDeps` for tests that build an `AppDeps` but only
 * exercise routes unrelated to ingestion (e.g. `/health`, `/v1/me`).
 * Every field is deliberately unusable — calling into it is a bug in
 * the test, not a case to support quietly.
 */
export function createStubIngestDeps(): IngestDeps {
  return {
    db: undefined as unknown as IngestDeps["db"],
    boss: undefined as unknown as IngestDeps["boss"],
    storage: undefined as unknown as IngestDeps["storage"],
  };
}
