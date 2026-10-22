import { sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createStubAgentDeps } from "../agent/test-helpers.js";
import type { ConsolidationDeps } from "../consolidation/consolidation.js";
import {
  createScriptedConsolidationJudge,
  createScriptedTopicSummarizer,
} from "../consolidation/test-helpers.js";
import { createDb } from "../db/client.js";
import { dailyRollups, entries } from "../db/schema.js";
import { createStubIngestDeps } from "../ingestion/test-helpers.js";
import { EMBED_QUEUE } from "../jobs/queues.js";
import type { RollupDeps } from "../rollup/rollup.js";
import { createScriptedRollupSummarizer } from "../rollup/test-helpers.js";
import { createApp } from "./app.js";

const DEV_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://bitacora:bitacora@localhost:55432/bitacora";
const APP_TOKEN = "admin-jobs-test-token-0123456789";
const authHeaders = { Authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/json" };

const db = createDb(DEV_DATABASE_URL);
const boss = new PgBoss(DEV_DATABASE_URL);

beforeAll(async () => {
  await boss.start();
  await boss.createQueue(EMBED_QUEUE);
});

afterAll(async () => {
  await boss.stop({ timeout: 2_000 });
  await db.pool.end();
});

const DATE_LABEL = "2026-02-10";

afterEach(async () => {
  await db.orm.delete(dailyRollups).where(sql`${dailyRollups.rollupDate} = ${DATE_LABEL}`);
  await db.orm.delete(entries).where(sql`${entries.textBody} = 'admin trigger test entry'`);
});

function buildApp(rollupSummaries: Array<string | null>) {
  const rollup: RollupDeps = {
    db: db.orm,
    summarizer: createScriptedRollupSummarizer(rollupSummaries),
  };
  const consolidation: ConsolidationDeps = {
    db: db.orm,
    boss,
    judge: createScriptedConsolidationJudge([]),
    topicSummarizer: createScriptedTopicSummarizer([]),
  };
  return createApp({
    appToken: APP_TOKEN,
    checkDb: async () => true,
    ingest: createStubIngestDeps(),
    agent: createStubAgentDeps(),
    adminJobs: { rollup, consolidation },
  });
}

describe("POST /v1/admin/jobs/:name/run", () => {
  it("runs the daily rollup for a given backfill date", async () => {
    await db.orm.insert(entries).values({
      kind: "text",
      textBody: "admin trigger test entry",
      createdAt: new Date(`${DATE_LABEL}T10:00:00-03:00`),
    });

    const app = buildApp(["Resumen del día vía admin trigger."]);
    const res = await app.request("/v1/admin/jobs/daily-rollup/run", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ date: DATE_LABEL }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      result: { status: string; dateLabel: string };
    };
    expect(body.ok).toBe(true);
    expect(body.result.status).toBe("created");
    expect(body.result.dateLabel).toBe(DATE_LABEL);
  });

  it("rejects an invalid date", async () => {
    const app = buildApp([]);
    const res = await app.request("/v1/admin/jobs/daily-rollup/run", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ date: "not-a-date" }),
    });
    expect(res.status).toBe(400);
  });

  it("runs the nightly consolidation job on demand", async () => {
    const app = buildApp([]);
    const res = await app.request("/v1/admin/jobs/nightly-consolidation/run", {
      method: "POST",
      headers: authHeaders,
      body: "{}",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; result: { runId: string } };
    expect(body.ok).toBe(true);
    expect(typeof body.result.runId).toBe("string");
  });

  it("404s for an unknown job name", async () => {
    const app = buildApp([]);
    const res = await app.request("/v1/admin/jobs/not-a-real-job/run", {
      method: "POST",
      headers: authHeaders,
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("requires auth, like every other /v1 route", async () => {
    const app = buildApp([]);
    const res = await app.request("/v1/admin/jobs/daily-rollup/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });
});
