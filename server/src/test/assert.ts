/**
 * Shared test-only assertion helper: replaces the `!` non-null
 * assertion operator (forbidden by this repo's lint rule,
 * `lint/style/noNonNullAssertion` — a modified/missing value fails
 * loudly here with a readable message, instead of silently passing
 * `undefined` on to whatever reads it next). Not matched by Vitest's
 * `src/**\/*.test.ts` include pattern — same convention as
 * `embeddings/test-helpers.ts`.
 *
 * Belongs to unit (a): the first T06 unit whose tests needed to narrow
 * an optional value (`rememberFact`'s `memoryId`) after an assertion.
 */
export function assertDefined<T>(
  value: T | null | undefined,
  message = "expected value to be defined",
): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}
