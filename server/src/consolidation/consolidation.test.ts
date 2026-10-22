import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../db/client.js";
import { changeLog, entries, memories, topics } from "../db/schema.js";
import { createFakeEmbedder } from "../embeddings/test-helpers.js";
import { EMBED_QUEUE } from "../jobs/queues.js";
import { rememberFact, undoTurn } from "../memory/service.js";
import { createScriptedJudge } from "../memory/test-helpers.js";
import { assertDefined } from "../test/assert.js";
import {
  type ConsolidationDeps,
  DEFAULT_RECENT_MEMORY_GUARD_MINUTES,
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
  return { db: db.orm, boss, judge, topicSummarizer };
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
    const result = await runNightlyConsolidation(baseDeps(judge, topicSummarizer));
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
    const result = await runNightlyConsolidation(baseDeps(judge, topicSummarizer));

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
    const result = await runNightlyConsolidation(baseDeps(judge, topicSummarizer));
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

    const firstSummarizer = createScriptedTopicSummarizer(["Resumen inicial del tema."]);
    const firstResult = await runNightlyConsolidation(baseDeps(noPairsJudge, firstSummarizer));
    expect(firstResult.topicSummaries.refreshedTopicCount).toBe(1);
    expect(firstSummarizer.calls).toHaveLength(1);
    expect(firstSummarizer.calls[0]?.topicName).toBe(topicName);

    const [afterFirst] = await db.orm.select().from(topics).where(sql`${topics.id} = ${topicId}`);
    expect(afterFirst?.summary).toBe("Resumen inicial del tema.");
    expect(afterFirst?.summaryGeneratedAt).not.toBeNull();

    // No new memory was written for this topic since the refresh above,
    // so a second run must not call the summarizer again.
    const secondSummarizer = createScriptedTopicSummarizer(["should never be used"]);
    const secondResult = await runNightlyConsolidation(baseDeps(noPairsJudge, secondSummarizer));
    expect(secondResult.topicSummaries.staleTopicCount).toBe(0);
    expect(secondSummarizer.calls).toHaveLength(0);

    const [afterSecond] = await db.orm.select().from(topics).where(sql`${topics.id} = ${topicId}`);
    expect(afterSecond?.summary).toBe("Resumen inicial del tema.");
  });
});
