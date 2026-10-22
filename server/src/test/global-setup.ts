/**
 * Vitest global setup (registered in `vitest.config.ts`'s
 * `globalSetup`). Runs once, in Vitest's main process, before any test
 * worker is spawned — so the `process.env.DATABASE_URL` override below
 * is inherited by every worker (Node forks/threads inherit `process.env`
 * at spawn time), and no individual `*.test.ts` file needs to change:
 * every one of them already does `process.env.DATABASE_URL ?? <dev URL
 * literal>`.
 *
 * Belongs to unit (a) — the memory service's own tests were the first
 * in this task to need a real, isolated Postgres database instead of
 * running against whatever `DATABASE_URL` the developer's shell or
 * `.env` happens to point at (the shared dev database, per the parent's
 * review).
 *
 * What it does:
 * 1. Derives a test database URL: `TEST_DATABASE_URL` if set, otherwise
 *    the dev `DATABASE_URL`'s database name with `_test` appended.
 * 2. Creates that database (via a separate admin connection to the dev
 *    database) if it does not already exist.
 * 3. Runs `drizzle-kit migrate` against it.
 * 4. Overwrites `process.env.DATABASE_URL` with the test URL.
 *
 * Idempotent and safe to re-run: step 2 checks `pg_database` first, and
 * `drizzle-kit migrate` only applies migrations not yet recorded in its
 * own journal table. Step 5 (below) truncates the append-only tables
 * that `memory/*.test.ts`, `agent/*.test.ts` and `http/*.test.ts` commit
 * real (non-rolled-back) rows to but have no per-row id to clean up
 * individually (`chat_messages`/`agent_runs`/`change_log` — assistant
 * and tool rows have no `entryId`, and `agent_runs`/`change_log` rows
 * are never deleted by any suite's own `afterEach`), so leftover rows
 * from one `vitest run` invocation cannot pollute the next one's
 * count-sensitive assertions.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const DEFAULT_DEV_DATABASE_URL = "postgresql://bitacora:bitacora@localhost:55432/bitacora";
const SERVER_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function deriveTestDatabaseUrl(devUrl: string): string {
  const url = new URL(devUrl);
  const devDbName = url.pathname.replace(/^\//, "");
  url.pathname = `/${devDbName}_test`;
  return url.toString();
}

function databaseNameFrom(databaseUrl: string): string {
  return new URL(databaseUrl).pathname.replace(/^\//, "");
}

/** `dbName` is always derived from this file's own URL parsing (dev `DATABASE_URL`'s path, or `TEST_DATABASE_URL`'s), never from user/test input — identifiers cannot be bound parameters, so this is not an injection risk. */
async function ensureDatabaseExists(
  testDatabaseUrl: string,
  adminDatabaseUrl: string,
): Promise<void> {
  const dbName = databaseNameFrom(testDatabaseUrl);
  const client = new Client({ connectionString: adminDatabaseUrl });
  await client.connect();
  try {
    const existing = await client.query("select 1 from pg_database where datname = $1", [dbName]);
    if (existing.rowCount === 0) {
      await client.query(`create database "${dbName}"`);
    }
  } finally {
    await client.end();
  }
}

function runMigrations(testDatabaseUrl: string): void {
  execFileSync("node_modules/.bin/drizzle-kit", ["migrate"], {
    cwd: SERVER_ROOT,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
    stdio: "inherit",
  });
}

/** Tables some suites commit real rows to with no per-row id tracked for individual cleanup — see the module comment above. Truncated once per `vitest run`, not per test file. */
const APPEND_ONLY_TABLES_WITHOUT_TEST_CLEANUP = ["chat_messages", "agent_runs", "change_log"];

async function resetAppendOnlyTestTables(testDatabaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: testDatabaseUrl });
  await client.connect();
  try {
    const tableList = APPEND_ONLY_TABLES_WITHOUT_TEST_CLEANUP.map((t) => `"${t}"`).join(", ");
    await client.query(`truncate ${tableList}`);
  } finally {
    await client.end();
  }
}

export default async function setup(): Promise<void> {
  const devDatabaseUrl = process.env.DATABASE_URL ?? DEFAULT_DEV_DATABASE_URL;
  const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? deriveTestDatabaseUrl(devDatabaseUrl);

  // The admin connection must point at an existing database (the dev
  // one) — the test database may not exist yet, which is the whole
  // point of this step.
  await ensureDatabaseExists(testDatabaseUrl, devDatabaseUrl);
  runMigrations(testDatabaseUrl);
  await resetAppendOnlyTestTables(testDatabaseUrl);

  process.env.DATABASE_URL = testDatabaseUrl;
}
