import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../db/client.js";
import { agentRuns, changeLog, entries, memories, topics } from "../db/schema.js";
import { createFakeEmbedder } from "../embeddings/test-helpers.js";
import { EMBED_QUEUE } from "../jobs/queues.js";
import { rememberFact, undoTurn } from "../memory/service.js";
import { createScriptedJudge } from "../memory/test-helpers.js";
import { assertDefined } from "../test/assert.js";
import {
  type ConsolidationDeps,
  DEFAULT_RECENT_MEMORY_GUARD_MINUTES,
  type RunNightlyConsolidationResult,
  runNightlyConsolidation,
} from "./consolidation.js";
import { createScriptedConsolidationJudge, createScriptedTopicSummarizer } from "./test-helpers.js";

const DEV_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://bitacora:bitacora@localhost:55432/bitacora";

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

const createdEntryIds: string[] = [];
const createdTopicIds: string[] = [];
const createdActionGroupIds: string[] = [];

afterEach(async () => {
  while (createdActionGroupIds.length > 0) {
    const groupId = createdActionGroupIds.pop();
    if (groupId) await db.orm.delete(changeLog).where(sql`${changeLog.actionGroupId} = ${groupId}`);
  }
  while (createdEntryIds.length > 0) {
    const entryId = createdEntryIds.pop();
    if (entryId) {
      await db.orm.delete(memories).where(sql`${memories.sourceEntryId} = ${entryId}`);
      await db.orm.delete(entries).where(sql`${entries.id} = ${entryId}`);
    }
  }
  while (createdTopicIds.length > 0) {
    const topicId = createdTopicIds.pop();
    if (topicId) await db.orm.delete(topics).where(sql`${topics.id} = ${topicId}`);
  }
});

async function makeEntry(): Promise<string> {
  const [row] = await db.orm
    .insert(entries)
    .values({ kind: "text", textBody: "raw log entry" })
    .returning({ id: entries.id });
  const entryId = assertDefined(row).id;
  createdEntryIds.push(entryId);
  return entryId;
}

/** Old enough to clear `DEFAULT_RECENT_MEMORY_GUARD_MINUTES` by a wide margin. */
const OLD_ENOUGH = new Date(Date.now() - (DEFAULT_RECENT_MEMORY_GUARD_MINUTES + 60) * 60 * 1000);

async function makeOldMemory(
  content: string,
  sourceEntryId: string,
  topicId?: string,
): Promise<string> {
  const [row] = await db.orm
    .insert(memories)
    .values({ content, sourceEntryId, topicId: topicId ?? null, createdAt: OLD_ENOUGH })
    .returning({ id: memories.id });
  return assertDefined(row).id;
}

function baseDeps(
  judge: ConsolidationDeps["judge"],
  topicSummarizer: ConsolidationDeps["topicSummarizer"],
): ConsolidationDeps {
  return { db: db.orm, pool: db.pool, boss, judge, topicSummarizer };
}

/** Narrows a run result to its `"completed"` shape, failing loudly (not silently) if the run was instead skipped as `already_running`. */
function assertCompleted(
  result: RunNightlyConsolidationResult,
): Extract<RunNightlyConsolidationResult, { status: "completed" }> {
  if (result.status !== "completed") {
    throw new Error(`expected a completed run, got status "${result.status}"`);
  }
  return result;
}

describe("runNightlyConsolidation: merge duplicates", () => {
  it("merges a near-identical pair, logs change_log under the run id, and undoes cleanly", async () => {
    const entryA = await makeEntry();
    const entryB = await makeEntry();
    const content = "El dueño estudia Ingeniería en Sistemas en la UTN.";
    const idA = await makeOldMemory(content, entryA);
    const idB = await makeOldMemory(content, entryB);

    const judge = createScriptedConsolidationJudge([
      { action: "merge", mergedContent: "Estudia Ingeniería en Sistemas en la UTN." },
    ]);
    const topicSummarizer = createScriptedTopicSummarizer([]);
    const result = assertCompleted(await runNightlyConsolidation(baseDeps(judge, topicSummarizer)));
    createdActionGroupIds.push(result.runId);

    expect(result.mergeDuplicates.candidatePairCount).toBeGreaterThanOrEqual(1);
    expect(result.mergeDuplicates.outcomes.merged).toBe(1);
    expect(judge.calls).toHaveLength(result.mergeDuplicates.candidatePairCount);

    const [rowA] = await db.orm.select().from(memories).where(sql`${memories.id} = ${idA}`);
    const [rowB] = await db.orm.select().from(memories).where(sql`${memories.id} = ${idB}`);
    expect(rowA?.validTo).not.toBeNull();
    expect(rowB?.validTo).not.toBeNull();

    const [merged] = await db.orm
      .select()
      .from(memories)
      .where(sql`${memories.content} = 'Estudia Ingeniería en Sistemas en la UTN.'`);
    expect(merged?.validTo).toBeNull();

    const logRows = await db.orm
      .select()
      .from(changeLog)
      .where(sql`${changeLog.actionGroupId} = ${result.runId}`);
    expect(logRows).toHaveLength(3); // 1 insert (merged) + 2 updates (A, B invalidated)

    const mergedId = assertDefined(merged).id;
    const undoResult = await undoTurn({ db: db.orm }, result.runId);
    expect(undoResult.revertedCount).toBe(3);

    const [afterUndoA] = await db.orm.select().from(memories).where(sql`${memories.id} = ${idA}`);
    const [afterUndoB] = await db.orm.select().from(memories).where(sql`${memories.id} = ${idB}`);
    const afterUndoMerged = await db.orm
      .select()
      .from(memories)
      .where(sql`${memories.id} = ${mergedId}`);
    expect(afterUndoA?.validTo).toBeNull();
    expect(afterUndoB?.validTo).toBeNull();
    expect(afterUndoMerged).toHaveLength(0);
  });

  it("keep_both leaves both memories untouched and writes no change_log rows", async () => {
    const entryA = await makeEntry();
    const entryB = await makeEntry();
    const content = "El dueño trabaja en una panadería los fines de semana.";
    const idA = await makeOldMemory(content, entryA);
    const idB = await makeOldMemory(content, entryB);

    const judge = createScriptedConsolidationJudge([{ action: "keep_both" }]);
    const topicSummarizer = createScriptedTopicSummarizer([]);
    const result = assertCompleted(await runNightlyConsolidation(baseDeps(judge, topicSummarizer)));

    expect(result.mergeDuplicates.outcomes.kept_both).toBeGreaterThanOrEqual(1);

    const [rowA] = await db.orm.select().from(memories).where(sql`${memories.id} = ${idA}`);
    const [rowB] = await db.orm.select().from(memories).where(sql`${memories.id} = ${idB}`);
    expect(rowA?.content).toBe(content);
    expect(rowA?.validTo).toBeNull();
    expect(rowB?.content).toBe(content);
    expect(rowB?.validTo).toBeNull();

    const logRows = await db.orm
      .select()
      .from(changeLog)
      .where(sql`${changeLog.actionGroupId} = ${result.runId}`);
    expect(logRows).toHaveLength(0);
  });

  it("a_supersedes_b invalidates only B", async () => {
    const entryA = await makeEntry();
    const entryB = await makeEntry();
    const content = "El dueño vive en Nordelta desde marzo.";
    const idA = await makeOldMemory(content, entryA);
    const idB = await makeOldMemory(content, entryB);

    const judge = createScriptedConsolidationJudge([{ action: "a_supersedes_b" }]);
    const topicSummarizer = createScriptedTopicSummarizer([]);
    const result = assertCompleted(await runNightlyConsolidation(baseDeps(judge, topicSummarizer)));
    createdActionGroupIds.push(result.runId);

    expect(result.mergeDuplicates.outcomes.a_supersedes_b).toBeGreaterThanOrEqual(1);
    // The candidate query's own "A"/"B" (ordered by id, not insertion
    // order) decide which of `idA`/`idB` is superseded — read back from
    // what the judge was actually asked, rather than assuming either
    // order.
    const candidate = assertDefined(judge.calls.find((c) => c.idA === idA || c.idB === idA));
    const [survivorId, supersededId] = candidate.idA === idA ? [idA, idB] : [idB, idA];
    const [survivor] = await db.orm
      .select()
      .from(memories)
      .where(sql`${memories.id} = ${survivorId}`);
    const [superseded] = await db.orm
      .select()
      .from(memories)
      .where(sql`${memories.id} = ${supersededId}`);
    expect(survivor?.validTo).toBeNull();
    expect(superseded?.validTo).not.toBeNull();
  });

  it("never touches memories created within the recent-memory guard window", async () => {
    const entryA = await makeEntry();
    const entryB = await makeEntry();
    const content = "El dueño adoptó un gato ayer.";
    const [rowA] = await db.orm
      .insert(memories)
      .values({ content, sourceEntryId: entryA }) // createdAt defaults to now()
      .returning({ id: memories.id });
    const [rowB] = await db.orm
      .insert(memories)
      .values({ content, sourceEntryId: entryB })
      .returning({ id: memories.id });
    const idA = assertDefined(rowA).id;
    const idB = assertDefined(rowB).id;

    // Scripted to merge if ever called — the assertion is that it is
    // never called at all, not that it declines.
    const judge = createScriptedConsolidationJudge([
      { action: "merge", mergedContent: "should never be written" },
    ]);
    const topicSummarizer = createScriptedTopicSummarizer([]);
    await runNightlyConsolidation(baseDeps(judge, topicSummarizer));

    expect(judge.calls.filter((c) => c.idA === idA || c.idB === idA)).toHaveLength(0);
    const [afterA] = await db.orm.select().from(memories).where(sql`${memories.id} = ${idA}`);
    const [afterB] = await db.orm.select().from(memories).where(sql`${memories.id} = ${idB}`);
    expect(afterA?.validTo).toBeNull();
    expect(afterB?.validTo).toBeNull();
  });

  it("logs stopReason 'error' (never 'tool_use') when the judge call errors, and leaves memories untouched", async () => {
    const entryA = await makeEntry();
    const entryB = await makeEntry();
    const content = "El dueño cambió de trabajo en abril.";
    const idA = await makeOldMemory(content, entryA);
    const idB = await makeOldMemory(content, entryB);

    // Scripted to fall back to keep_both via an "error" outcome — this
    // is the case a real `createClaudeConsolidationJudge` call hits when
    // the API call itself throws. `outcomes` must be aligned 1:1 with
    // however many candidate pairs this specific pair actually produces
    // (just this one, since there is only one pair in the DB at this
    // point in the suite's run).
    const judge = createScriptedConsolidationJudge([{ action: "keep_both" }], {
      outcomes: ["error"],
    });
    const topicSummarizer = createScriptedTopicSummarizer([]);
    const result = assertCompleted(await runNightlyConsolidation(baseDeps(judge, topicSummarizer)));

    expect(result.mergeDuplicates.outcomes.kept_both).toBeGreaterThanOrEqual(1);
    const [rowA] = await db.orm.select().from(memories).where(sql`${memories.id} = ${idA}`);
    const [rowB] = await db.orm.select().from(memories).where(sql`${memories.id} = ${idB}`);
    expect(rowA?.validTo).toBeNull();
    expect(rowB?.validTo).toBeNull();

    const errorRuns = await db.orm
      .select()
      .from(agentRuns)
      .where(sql`${agentRuns.turnId} = ${result.runId}`);
    expect(errorRuns.some((row) => row.stopReason === "error")).toBe(true);
  });

  it("guards concurrent runs with an advisory lock: exactly one merges, the other reports already_running", async () => {
    const entryA = await makeEntry();
    const entryB = await makeEntry();
    const content = "El dueño se mudó a un depto nuevo en julio.";
    const idA = await makeOldMemory(content, entryA);
    const idB = await makeOldMemory(content, entryB);

    let releaseFirstJudgeCall: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirstJudgeCall = resolve;
    });

    let judgeCallCount = 0;
    const blockingDeps: ConsolidationDeps = {
      db: db.orm,
      pool: db.pool,
      boss,
      judge: {
        async decide(candidate) {
          judgeCallCount += 1;
          if (judgeCallCount === 1) await gate;
          return {
            decision: { action: "merge", mergedContent: "Se mudó a un depto nuevo en julio." },
            usage: { inputTokens: 1, outputTokens: 1 },
            requestJson: { candidate },
            outcome: "ok",
          };
        },
      },
      topicSummarizer: createScriptedTopicSummarizer([]),
    };

    const firstRun = runNightlyConsolidation(blockingDeps);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const secondRun = runNightlyConsolidation(blockingDeps);

    releaseFirstJudgeCall();
    const [first, second] = await Promise.all([firstRun, secondRun]);

    expect(judgeCallCount).toBe(1);
    const completedResults = [first, second].filter(
      (r): r is Extract<RunNightlyConsolidationResult, { status: "completed" }> =>
        r.status === "completed",
    );
    const skippedResults = [first, second].filter((r) => r.status === "already_running");
    expect(completedResults).toHaveLength(1);
    expect(skippedResults).toHaveLength(1);
    expect(completedResults[0]?.mergeDuplicates.outcomes.merged).toBe(1);
    createdActionGroupIds.push(assertDefined(completedResults[0]).runId);

    const mergedRows = await db.orm
      .select()
      .from(memories)
      .where(sql`${memories.content} = 'Se mudó a un depto nuevo en julio.'`);
    expect(mergedRows).toHaveLength(1);

    const [rowA] = await db.orm.select().from(memories).where(sql`${memories.id} = ${idA}`);
    const [rowB] = await db.orm.select().from(memories).where(sql`${memories.id} = ${idB}`);
    expect(rowA?.validTo).not.toBeNull();
    expect(rowB?.validTo).not.toBeNull();
  });
});

describe("runNightlyConsolidation: topic summaries", () => {
  it("refreshes a topic's summary only when its live memories changed since the last refresh", async () => {
    const entryId = await makeEntry();
    const memoryJudge = createScriptedJudge([{ action: "add" }]);
    const topicName = `consolidation-test-topic-${randomUUID()}`;

    const rememberResult = await rememberFact(
      { db: db.orm, boss, embedder: createFakeEmbedder(), judge: memoryJudge },
      { content: "Vive en Nordelta.", topicName, sourceEntryId: entryId, turnId: randomUUID() },
    );
    const topicId = assertDefined(rememberResult.topicId);
    createdTopicIds.push(topicId);

    const noPairsJudge = createScriptedConsolidationJudge([]);

    const firstSummarizer = createScriptedTopicSummarizer([
      { summary: "Resumen inicial del tema." },
    ]);
    const firstResult = assertCompleted(
      await runNightlyConsolidation(baseDeps(noPairsJudge, firstSummarizer)),
    );
    expect(firstResult.topicSummaries.refreshedTopicCount).toBe(1);
    expect(firstSummarizer.calls).toHaveLength(1);
    expect(firstSummarizer.calls[0]?.topicName).toBe(topicName);

    const [afterFirst] = await db.orm.select().from(topics).where(sql`${topics.id} = ${topicId}`);
    expect(afterFirst?.summary).toBe("Resumen inicial del tema.");
    expect(afterFirst?.summaryGeneratedAt).not.toBeNull();

    // No new memory was written for this topic since the refresh above,
    // so a second run must not call the summarizer again.
    const secondSummarizer = createScriptedTopicSummarizer([{ summary: "should never be used" }]);
    const secondResult = assertCompleted(
      await runNightlyConsolidation(baseDeps(noPairsJudge, secondSummarizer)),
    );
    expect(secondResult.topicSummaries.staleTopicCount).toBe(0);
    expect(secondSummarizer.calls).toHaveLength(0);

    const [afterSecond] = await db.orm.select().from(topics).where(sql`${topics.id} = ${topicId}`);
    expect(afterSecond?.summary).toBe("Resumen inicial del tema.");
  });

  it("logs stopReason 'error' when the topic summarizer call errors, and leaves the old summary in place", async () => {
    const entryId = await makeEntry();
    const memoryJudge = createScriptedJudge([{ action: "add" }]);
    const topicName = `consolidation-test-topic-error-${randomUUID()}`;

    const rememberResult = await rememberFact(
      { db: db.orm, boss, embedder: createFakeEmbedder(), judge: memoryJudge },
      { content: "Tiene un perro.", topicName, sourceEntryId: entryId, turnId: randomUUID() },
    );
    const topicId = assertDefined(rememberResult.topicId);
    createdTopicIds.push(topicId);

    const noPairsJudge = createScriptedConsolidationJudge([]);
    const erroringSummarizer = createScriptedTopicSummarizer([{ outcome: "error" }]);
    const result = assertCompleted(
      await runNightlyConsolidation(baseDeps(noPairsJudge, erroringSummarizer)),
    );
    expect(result.topicSummaries.refreshedTopicCount).toBe(0);

    const [afterError] = await db.orm.select().from(topics).where(sql`${topics.id} = ${topicId}`);
    expect(afterError?.summary).toBeNull();
    expect(afterError?.summaryGeneratedAt).toBeNull();

    const runRows = await db.orm
      .select()
      .from(agentRuns)
      .where(sql`${agentRuns.turnId} = ${result.runId}`);
    expect(runRows.some((row) => row.stopReason === "error")).toBe(true);
  });
});
