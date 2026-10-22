import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../db/client.js";
import { changeLog, entries, memories, rules, topics } from "../db/schema.js";
import { createFakeEmbedder } from "../embeddings/test-helpers.js";
import { EMBED_QUEUE } from "../jobs/queues.js";
import { rememberFact, undoLast, undoTurn, updateRule } from "./service.js";
import { createScriptedJudge } from "./test-helpers.js";

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
const createdRuleIds: string[] = [];
const createdTopicIds: string[] = [];

afterEach(async () => {
  while (createdEntryIds.length > 0) {
    const entryId = createdEntryIds.pop();
    if (entryId) {
      await db.orm.delete(memories).where(eq(memories.sourceEntryId, entryId));
      await db.orm.delete(entries).where(eq(entries.id, entryId));
    }
  }
  while (createdRuleIds.length > 0) {
    const ruleId = createdRuleIds.pop();
    if (ruleId) await db.orm.delete(rules).where(eq(rules.id, ruleId));
  }
  while (createdTopicIds.length > 0) {
    const topicId = createdTopicIds.pop();
    if (topicId) await db.orm.delete(topics).where(eq(topics.id, topicId));
  }
});

async function makeEntry(text: string): Promise<string> {
  const [row] = await db.orm.insert(entries).values({ kind: "text", textBody: text }).returning({
    id: entries.id,
  });
  if (!row) throw new Error("failed to insert test entry");
  createdEntryIds.push(row.id);
  return row.id;
}

function deps(judge: ReturnType<typeof createScriptedJudge>) {
  return { db: db.orm, boss, embedder: createFakeEmbedder(), judge };
}

describe("rememberFact", () => {
  it("adds a new memory, creates its topic, and logs the insert", async () => {
    const sourceEntryId = await makeEntry("Estudio Ingeniería en Sistemas en la UTN.");
    const turnId = randomUUID();
    const judge = createScriptedJudge([{ action: "add" }]);

    const result = await rememberFact(deps(judge), {
      content: "El owner estudia Ingeniería en Sistemas.",
      topicName: "University",
      sourceEntryId,
      turnId,
    });

    expect(result.action).toBe("add");
    expect(result.memoryId).toBeDefined();
    expect(result.topicId).toBeDefined();
    if (result.topicId) createdTopicIds.push(result.topicId);

    const [memoryRow] = await db.orm
      .select()
      .from(memories)
      .where(eq(memories.id, result.memoryId!));
    expect(memoryRow?.content).toBe("El owner estudia Ingeniería en Sistemas.");
    expect(memoryRow?.validTo).toBeNull();

    const logRows = await db.orm
      .select()
      .from(changeLog)
      .where(eq(changeLog.actionGroupId, turnId));
    expect(logRows).toHaveLength(1);
    expect(logRows[0]?.operation).toBe("insert");
    expect(logRows[0]?.targetTable).toBe("memories");
  });

  it("reuses an existing topic case-insensitively instead of creating a duplicate", async () => {
    const sourceEntryId = await makeEntry("texto");
    const judge = createScriptedJudge([{ action: "add" }, { action: "add" }]);

    const first = await rememberFact(deps(judge), {
      content: "fact one",
      topicName: "Trabajo",
      sourceEntryId,
      turnId: randomUUID(),
    });
    const second = await rememberFact(deps(judge), {
      content: "fact two",
      topicName: "trabajo",
      sourceEntryId,
      turnId: randomUUID(),
    });

    expect(second.topicId).toBe(first.topicId);
    if (first.topicId) createdTopicIds.push(first.topicId);
  });

  it("update supersedes the chosen candidate and logs both rows", async () => {
    const sourceEntryId = await makeEntry("texto");
    const addJudge = createScriptedJudge([{ action: "add" }]);
    const first = await rememberFact(deps(addJudge), {
      content: "El owner vive en Montevideo.",
      sourceEntryId,
      turnId: randomUUID(),
    });
    expect(first.memoryId).toBeDefined();

    const updateTurnId = randomUUID();
    const updateJudge = createScriptedJudge([{ action: "update", supersedesId: first.memoryId! }]);
    const second = await rememberFact(deps(updateJudge), {
      content: "El owner vive en Buenos Aires.",
      sourceEntryId,
      turnId: updateTurnId,
    });

    expect(second.action).toBe("update");
    expect(second.supersededId).toBe(first.memoryId);

    const [oldRow] = await db.orm.select().from(memories).where(eq(memories.id, first.memoryId!));
    expect(oldRow?.validTo).not.toBeNull();

    const [newRow] = await db.orm.select().from(memories).where(eq(memories.id, second.memoryId!));
    expect(newRow?.supersedesId).toBe(first.memoryId);

    const logRows = await db.orm
      .select()
      .from(changeLog)
      .where(eq(changeLog.actionGroupId, updateTurnId));
    expect(logRows).toHaveLength(2);
  });

  it("noop writes nothing and logs nothing", async () => {
    const sourceEntryId = await makeEntry("texto");
    const turnId = randomUUID();
    const judge = createScriptedJudge([{ action: "noop" }]);

    const result = await rememberFact(deps(judge), {
      content: "fact already known",
      sourceEntryId,
      turnId,
    });

    expect(result.action).toBe("noop");
    expect(result.memoryId).toBeUndefined();

    const logRows = await db.orm
      .select()
      .from(changeLog)
      .where(eq(changeLog.actionGroupId, turnId));
    expect(logRows).toHaveLength(0);
  });
});

describe("updateRule", () => {
  it("inserts a new rule and logs before: null", async () => {
    const turnId = randomUUID();
    const key = `test-rule-${randomUUID()}`;

    const result = await updateRule(
      { db: db.orm, boss },
      { key, payload: { leadMinutes: 30 }, turnId },
    );
    createdRuleIds.push(result.ruleId);

    expect(result.action).toBe("insert");
    const logRows = await db.orm
      .select()
      .from(changeLog)
      .where(eq(changeLog.actionGroupId, turnId));
    expect(logRows).toHaveLength(1);
    expect(logRows[0]?.before).toBeNull();
  });

  it("updates an existing rule and logs its before/after payload", async () => {
    const key = `test-rule-${randomUUID()}`;
    const first = await updateRule(
      { db: db.orm, boss },
      { key, payload: { leadMinutes: 30 }, turnId: randomUUID() },
    );
    createdRuleIds.push(first.ruleId);

    const turnId = randomUUID();
    const second = await updateRule(
      { db: db.orm, boss },
      { key, payload: { leadMinutes: 60 }, turnId },
    );

    expect(second.action).toBe("update");
    expect(second.ruleId).toBe(first.ruleId);
    const logRows = await db.orm
      .select()
      .from(changeLog)
      .where(eq(changeLog.actionGroupId, turnId));
    expect(logRows[0]?.before).toEqual({
      payload: { leadMinutes: 30 },
      topicId: null,
      active: true,
    });
  });
});

describe("undoTurn / undoLast", () => {
  it("reverts an add by deleting the new memory", async () => {
    const sourceEntryId = await makeEntry("texto");
    const turnId = randomUUID();
    const judge = createScriptedJudge([{ action: "add" }]);
    const result = await rememberFact(deps(judge), {
      content: "fact to undo",
      sourceEntryId,
      turnId,
    });

    const undone = await undoTurn({ db: db.orm }, turnId);
    expect(undone.revertedCount).toBe(1);

    const [row] = await db.orm.select().from(memories).where(eq(memories.id, result.memoryId!));
    expect(row).toBeUndefined();
  });

  it("reverts an update by restoring the superseded memory and deleting the new one", async () => {
    const sourceEntryId = await makeEntry("texto");
    const addJudge = createScriptedJudge([{ action: "add" }]);
    const first = await rememberFact(deps(addJudge), {
      content: "original fact",
      sourceEntryId,
      turnId: randomUUID(),
    });

    const updateTurnId = randomUUID();
    const updateJudge = createScriptedJudge([{ action: "update", supersedesId: first.memoryId! }]);
    const second = await rememberFact(deps(updateJudge), {
      content: "corrected fact",
      sourceEntryId,
      turnId: updateTurnId,
    });

    const undone = await undoTurn({ db: db.orm }, updateTurnId);
    expect(undone.revertedCount).toBe(2);

    const [oldRow] = await db.orm.select().from(memories).where(eq(memories.id, first.memoryId!));
    expect(oldRow?.validTo).toBeNull();

    const [newRow] = await db.orm.select().from(memories).where(eq(memories.id, second.memoryId!));
    expect(newRow).toBeUndefined();
  });

  it("is idempotent: undoing the same turn twice reverts nothing the second time", async () => {
    const sourceEntryId = await makeEntry("texto");
    const turnId = randomUUID();
    const judge = createScriptedJudge([{ action: "add" }]);
    await rememberFact(deps(judge), { content: "idempotent fact", sourceEntryId, turnId });

    await undoTurn({ db: db.orm }, turnId);
    const second = await undoTurn({ db: db.orm }, turnId);
    expect(second.revertedCount).toBe(0);
  });

  it("undoLast reverts the most recently created turn", async () => {
    const sourceEntryId = await makeEntry("texto");
    const judge = createScriptedJudge([{ action: "add" }]);
    const turnId = randomUUID();
    const result = await rememberFact(deps(judge), {
      content: "most recent fact",
      sourceEntryId,
      turnId,
    });

    const undone = await undoLast({ db: db.orm });
    expect(undone?.turnId).toBe(turnId);

    const [row] = await db.orm.select().from(memories).where(eq(memories.id, result.memoryId!));
    expect(row).toBeUndefined();
  });

  it("reverts a rule insert by deleting it, and a rule update by restoring its payload", async () => {
    const key = `test-rule-${randomUUID()}`;
    const insertTurnId = randomUUID();
    const inserted = await updateRule(
      { db: db.orm, boss },
      { key, payload: { leadMinutes: 15 }, turnId: insertTurnId },
    );

    const updateTurnId = randomUUID();
    await updateRule(
      { db: db.orm, boss },
      { key, payload: { leadMinutes: 45 }, turnId: updateTurnId },
    );

    await undoTurn({ db: db.orm }, updateTurnId);
    const [afterUpdateUndo] = await db.orm
      .select()
      .from(rules)
      .where(eq(rules.id, inserted.ruleId));
    expect(afterUpdateUndo?.payload).toEqual({ leadMinutes: 15 });

    await undoTurn({ db: db.orm }, insertTurnId);
    const [afterInsertUndo] = await db.orm
      .select()
      .from(rules)
      .where(eq(rules.id, inserted.ruleId));
    expect(afterInsertUndo).toBeUndefined();
  });
});
