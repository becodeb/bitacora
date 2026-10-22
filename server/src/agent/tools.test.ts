import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../db/client.js";
import { entries, memories, topics } from "../db/schema.js";
import { createFakeEmbedder } from "../embeddings/test-helpers.js";
import { EMBED_QUEUE } from "../jobs/queues.js";
import { createScriptedJudge } from "../memory/test-helpers.js";
import { createHybridSearch } from "../search/hybrid-search.js";
import { RefTracker } from "./refs.js";
import { executeTool, OPEN_TOPIC_ROW_LIMIT, TOOL_RESULT_HARD_CAP_CHARS } from "./tools.js";

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

afterEach(async () => {
  while (createdEntryIds.length > 0) {
    const entryId = createdEntryIds.pop();
    if (entryId) {
      await db.orm.delete(memories).where(eq(memories.sourceEntryId, entryId));
      await db.orm.delete(entries).where(eq(entries.id, entryId));
    }
  }
  while (createdTopicIds.length > 0) {
    const topicId = createdTopicIds.pop();
    if (topicId) await db.orm.delete(topics).where(eq(topics.id, topicId));
  }
});

function baseDeps() {
  const search = createHybridSearch({ db: db.orm, embedder: createFakeEmbedder() });
  const judge = createScriptedJudge([{ action: "add" }]);
  return {
    db: db.orm,
    hybridSearch: search.hybridSearch,
    memory: { db: db.orm, boss, embedder: createFakeEmbedder(), judge },
    refTracker: new RefTracker(),
    turnId: randomUUID(),
    defaultSourceEntryId: randomUUID(),
  };
}

async function makeTopicWithMemories(
  count: number,
): Promise<{ topicId: string; topicName: string }> {
  const topicName = `test-topic-${randomUUID()}`;
  const [topicRow] = await db.orm
    .insert(topics)
    .values({ name: topicName })
    .returning({ id: topics.id });
  if (!topicRow) throw new Error("failed to insert test topic");
  createdTopicIds.push(topicRow.id);

  for (let i = 0; i < count; i++) {
    const [entryRow] = await db.orm
      .insert(entries)
      .values({ kind: "text", textBody: `entry ${i}` })
      .returning({ id: entries.id });
    if (!entryRow) throw new Error("failed to insert test entry");
    createdEntryIds.push(entryRow.id);
    await db.orm.insert(memories).values({
      content: `memory number ${i}`.padEnd(200, " filler content to make it bigger"),
      topicId: topicRow.id,
      sourceEntryId: entryRow.id,
    });
  }

  return { topicId: topicRow.id, topicName };
}

describe("executeTool: open_topic", () => {
  it("caps results to the most recent OPEN_TOPIC_ROW_LIMIT memories and reports how many were omitted", async () => {
    const extra = 10;
    const { topicName } = await makeTopicWithMemories(OPEN_TOPIC_ROW_LIMIT + extra);
    const deps = baseDeps();

    const result = await executeTool("open_topic", { name: topicName }, deps);

    expect(result.isError).toBe(false);
    expect(result.statusSummary).toContain(`${extra} omitted`);
    expect(result.resultText).toContain(`+${extra} older memories omitted`);
  });

  it("reports no omission when the topic has fewer memories than the cap", async () => {
    const { topicName } = await makeTopicWithMemories(3);
    const deps = baseDeps();

    const result = await executeTool("open_topic", { name: topicName }, deps);

    expect(result.resultText).not.toContain("omitted");
  });
});

describe("executeTool: hard result cap", () => {
  it("never returns a resultText longer than TOOL_RESULT_HARD_CAP_CHARS, regardless of which tool ran", async () => {
    // Enough memories, each long enough after per-hit truncation, to
    // exceed the hard cap once formatted together.
    const { topicName } = await makeTopicWithMemories(OPEN_TOPIC_ROW_LIMIT);
    const deps = baseDeps();

    const result = await executeTool("open_topic", { name: topicName }, deps);

    expect(result.resultText.length).toBeLessThanOrEqual(TOOL_RESULT_HARD_CAP_CHARS);
  });
});

describe("executeTool: unknown tool", () => {
  it("returns an error result instead of throwing", async () => {
    const deps = baseDeps();
    const result = await executeTool("not_a_real_tool", {}, deps);
    expect(result.isError).toBe(true);
  });
});
