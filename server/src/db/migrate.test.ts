import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { runMigrations } from "./migrate.js";

// The global setup (`src/test/global-setup.ts`) already points
// `DATABASE_URL` at a dedicated, migrated `*_test` database (via
// `drizzle-kit migrate`) before this file runs. Re-running the runtime
// migrator here is exactly the scenario it must handle correctly in
// production too: a container restart on a schema that is already
// up to date.
const TEST_DATABASE_URL = process.env.DATABASE_URL;
if (!TEST_DATABASE_URL) {
  throw new Error("DATABASE_URL must be set by the Vitest global setup before this file runs");
}

const db = createDb(TEST_DATABASE_URL);

afterAll(async () => {
  await db.pool.end();
});

describe("runMigrations", () => {
  it("resolves the migrations folder and is idempotent against an already-migrated database", async () => {
    // Already migrated by global setup; this must be a no-op, not an
    // error, since the real server calls this on every boot.
    await expect(runMigrations(db.orm)).resolves.toBeUndefined();
  });

  it("leaves the schema queryable after running (the expected tables exist)", async () => {
    const result = await db.orm.execute(
      sql`select to_regclass('public.entries') as entries, to_regclass('public.memories') as memories`,
    );
    const row = result.rows[0] as { entries: string | null; memories: string | null };
    expect(row.entries).toBe("entries");
    expect(row.memories).toBe("memories");
  });
});
