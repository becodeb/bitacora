import { sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createStubAgentDeps } from "../agent/test-helpers.js";
import {
  type ConsolidationDeps,
  DEFAULT_RECENT_MEMORY_GUARD_MINUTES,
} from "../consolidation/consolidation.js";
import {
  createScriptedConsolidationJudge,
  createScriptedTopicSummarizer,
} from "../consolidation/test-helpers.js";
import { createDb } from "../db/client.js";
import { dailyRollups, entries, memories } from "../db/schema.js";
import { createStubIngestDeps } from "../ingestion/test-helpers.js";
import { EMBED_QUEUE } from "../jobs/queues.js";
import type { RollupDeps } from "../rollup/rollup.js";
import { createScriptedRollupSummarizer } from "../rollup/test-helpers.js";
import { assertDefined } from "../test/assert.js";
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

function buildApp(rollupScripts: Parameters<typeof createScriptedRollupSummarizer>[0]) {
  const rollup: RollupDeps = {
    db: db.orm,
    pool: db.pool,
    summarizer: createScriptedRollupSummarizer(rollupScripts),
  };
  const consolidation: ConsolidationDeps = {
    db: db.orm,
    pool: db.pool,
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

    const app = buildApp([{ summary: "Resumen del día vía admin trigger." }]);
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

  it("returns 409 for the second of two concurrent nightly-consolidation triggers", async () => {
    // A real candidate pair, old enough to clear the recent-memory
    // guard, so the blocking judge below is actually invoked — with an
    // empty candidate set the run would finish too fast (and without
    // ever awaiting the gate) to reliably exercise the lock.
    const [entryARow] = await db.orm
      .insert(entries)
      .values({ kind: "text", textBody: "admin lock test entry A" })
      .returning({ id: entries.id });
    const [entryBRow] = await db.orm
      .insert(entries)
      .values({ kind: "text", textBody: "admin lock test entry B" })
      .returning({ id: entries.id });
    const entryA = assertDefined(entryARow).id;
    const entryB = assertDefined(entryBRow).id;
    const oldEnough = new Date(Date.now() - (DEFAULT_RECENT_MEMORY_GUARD_MINUTES + 60) * 60 * 1000);
    const content = "El dueño probó el lock de administración.";
    await db.orm.insert(memories).values({ content, sourceEntryId: entryA, createdAt: oldEnough });
    await db.orm.insert(memories).values({ content, sourceEntryId: entryB, createdAt: oldEnough });

    let releaseFirstCall: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirstCall = resolve;
    });
    let callCount = 0;
    const blockingJudge: ConsolidationDeps["judge"] = {
      async decide(candidate) {
        callCount += 1;
        if (callCount === 1) await gate;
        return {
          decision: { action: "keep_both" },
          usage: { inputTokens: 1, outputTokens: 1 },
          requestJson: { candidate },
          outcome: "ok",
        };
      },
    };
    const consolidation: ConsolidationDeps = {
      db: db.orm,
      pool: db.pool,
      boss,
      judge: blockingJudge,
      topicSummarizer: createScriptedTopicSummarizer([]),
    };
    const rollup: RollupDeps = {
      db: db.orm,
      pool: db.pool,
      summarizer: createScriptedRollupSummarizer([]),
    };
    const app = createApp({
      appToken: APP_TOKEN,
      checkDb: async () => true,
      ingest: createStubIngestDeps(),
      agent: createStubAgentDeps(),
      adminJobs: { rollup, consolidation },
    });

    try {
      const firstRequest = app.request("/v1/admin/jobs/nightly-consolidation/run", {
        method: "POST",
        headers: authHeaders,
        body: "{}",
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const secondRequest = app.request("/v1/admin/jobs/nightly-consolidation/run", {
        method: "POST",
        headers: authHeaders,
        body: "{}",
      });

      releaseFirstCall();
      const [firstRes, secondRes] = await Promise.all([firstRequest, secondRequest]);
      const statuses = [firstRes.status, secondRes.status].sort();
      expect(statuses).toEqual([200, 409]);
      expect(callCount).toBe(1);
    } finally {
      await db.orm.delete(memories).where(sql`${memories.content} = ${content}`);
      await db.orm
        .delete(entries)
        .where(sql`${entries.textBody} in ('admin lock test entry A', 'admin lock test entry B')`);
    }
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
