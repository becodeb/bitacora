import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createStubAgentDeps } from "../agent/test-helpers.js";
import { checkDb } from "../db/client.js";
import { createStubIngestDeps } from "../ingestion/test-helpers.js";
import { createApp } from "./app.js";
import { createStubAdminJobsDeps } from "./test-helpers.js";

// Mirrors compose.dev.yml's credentials and the host port chosen there.
// Override with DATABASE_URL for a dev DB running elsewhere.
const DEV_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://bitacora:bitacora@localhost:55432/bitacora";

describe("GET /health", () => {
  it("returns 503 when the injected DB check fails", async () => {
    const app = createApp({
      appToken: "irrelevant-for-this-test",
      checkDb: async () => false,
      ingest: createStubIngestDeps(),
      agent: createStubAgentDeps(),
      adminJobs: createStubAdminJobsDeps(),
    });

    const res = await app.request("/health");

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ ok: false, db: "down" });
  });

  it("returns 503 within a bounded time when the DB check hangs", async () => {
    const app = createApp({
      appToken: "irrelevant-for-this-test",
      checkDb: () =>
        new Promise<boolean>(() => {
          // Never resolves or rejects: simulates a stuck check without
          // touching the network or a real database.
        }),
      ingest: createStubIngestDeps(),
      agent: createStubAgentDeps(),
      adminJobs: createStubAdminJobsDeps(),
    });

    const startedAt = Date.now();
    const res = await app.request("/health");
    const elapsedMillis = Date.now() - startedAt;

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ ok: false, db: "down" });
    expect(elapsedMillis).toBeLessThan(3_000);
  });

  describe("against the real dev database", () => {
    const pool = new Pool({ connectionString: DEV_DATABASE_URL });

    afterAll(async () => {
      await pool.end();
    });

    it("returns 200 when the database answers", async () => {
      const app = createApp({
        appToken: "irrelevant-for-this-test",
        checkDb: () => checkDb(pool),
        ingest: createStubIngestDeps(),
        agent: createStubAgentDeps(),
        adminJobs: createStubAdminJobsDeps(),
      });

      const res = await app.request("/health");

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true, db: "up" });
    });
  });
});
