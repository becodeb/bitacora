/**
 * Test-only helpers for HTTP-layer tests. Not matched by Vitest's
 * `src/**\/*.test.ts` include pattern — same convention as
 * `embeddings/test-helpers.ts`.
 */
import type { AdminJobsDeps } from "./admin-jobs.js";

/**
 * A stub `AdminJobsDeps` for tests that build an `AppDeps` but only
 * exercise routes unrelated to the nightly jobs (e.g. `/health`,
 * `/v1/me`, `/v1/entries`, `/v1/chat`) — same role as
 * `agent/test-helpers.ts`'s `createStubAgentDeps`. Every field is
 * deliberately unusable; calling into it is a bug in the test, not a
 * case to support quietly.
 */
export function createStubAdminJobsDeps(): AdminJobsDeps {
  return {
    rollup: undefined as unknown as AdminJobsDeps["rollup"],
    consolidation: undefined as unknown as AdminJobsDeps["consolidation"],
  };
}
