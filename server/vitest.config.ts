import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // Creates/migrates a dedicated `*_test` Postgres database and
    // points every test file at it (see `src/test/global-setup.ts`),
    // instead of the shared dev database.
    globalSetup: ["./src/test/global-setup.ts"],
    // Most suites here are integration tests against one real Postgres
    // database (not mocked), several of which commit real rows outside
    // a rolled-back transaction (e.g. `http/*.test.ts`, `agent/*.test.ts`,
    // `memory/*.test.ts`). Running test files in parallel let those
    // suites observe each other's committed-but-not-yet-cleaned-up rows
    // under Postgres's READ COMMITTED isolation, causing intermittent
    // failures unrelated to the code under test (observed in
    // `search/hybrid-search.test.ts`). Serializing file execution is the
    // simplest fix that keeps the suite deterministic; individual pure-
    // unit test files (no DB) are already fast and barely affected by
    // running one at a time instead of across workers.
    fileParallelism: false,
  },
});
