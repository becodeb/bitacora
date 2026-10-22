import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createStubAgentDeps } from "../agent/test-helpers.js";
import { createDb } from "../db/client.js";
import { entries, memories, rules, topics } from "../db/schema.js";
import { createFakeEmbedder } from "../embeddings/test-helpers.js";
import { createStubIngestDeps } from "../ingestion/test-helpers.js";
import { EMBED_QUEUE } from "../jobs/queues.js";
import { rememberFact } from "../memory/service.js";
import { createScriptedJudge } from "../memory/test-helpers.js";
import { assertDefined } from "../test/assert.js";
import { createApp } from "./app.js";
import { createStubAdminJobsDeps } from "./test-helpers.js";

const DEV_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://bitacora:bitacora@localhost:55432/bitacora";
const APP_TOKEN = "me-test-token-0123456789";
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

const createdEntryIds: string[] = [];
const createdTopicIds: string[] = [];
const createdRuleIds: string[] = [];

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
  while (createdRuleIds.length > 0) {
    const ruleId = createdRuleIds.pop();
    if (ruleId) await db.orm.delete(rules).where(eq(rules.id, ruleId));
  }
});

function buildApp() {
  const agent = { ...createStubAgentDeps(), memory: { db: db.orm, boss } };
  return createApp({
    appToken: APP_TOKEN,
    checkDb: async () => true,
    ingest: createStubIngestDeps(),
    // biome-ignore lint/suspicious/noExplicitAny: a partial AgentTurnDeps is enough — only `memory` (db, boss) is exercised by /v1/me, same structural-typing trade-off as the other stub-based test files.
    agent: agent as any,
    adminJobs: createStubAdminJobsDeps(),
  });
}

async function makeEntry(text: string): Promise<string> {
  const [row] = await db.orm.insert(entries).values({ kind: "text", textBody: text }).returning({
    id: entries.id,
  });
  if (!row) throw new Error("failed to insert test entry");
  createdEntryIds.push(row.id);
  return row.id;
}

async function makeMemory(
  content: string,
  topicName?: string,
): Promise<{ memoryId: string; topicId: string | null; sourceEntryId: string }> {
  const sourceEntryId = await makeEntry(`entry for: ${content}`);
  const judge = createScriptedJudge([{ action: "add" }]);
  const result = await rememberFact(
    { db: db.orm, boss, embedder: createFakeEmbedder(), judge },
    { content, topicName, sourceEntryId, turnId: randomUUID() },
  );
  if (result.topicId) createdTopicIds.push(result.topicId);
  return {
    memoryId: assertDefined(result.memoryId),
    topicId: result.topicId ?? null,
    sourceEntryId,
  };
}

describe("GET /v1/me/*", () => {
  it("rejects every /v1/me sub-route without a bearer token", async () => {
    const app = buildApp();
    const paths = [
      "/v1/me/topics",
      "/v1/me/memories?topicId=none",
      "/v1/me/rules",
      "/v1/me/changes",
    ];
    for (const path of paths) {
      const res = await app.request(path);
      expect(res.status).toBe(401);
    }
  });

  it("GET /v1/me/topics lists topics sorted by recent activity, with live memory counts", async () => {
    const app = buildApp();
    const topicName = `Topics Test ${randomUUID()}`;
    const created = await makeMemory("a fact about a topic", topicName);

    const res = await app.request("/v1/me/topics", { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      topics: Array<{ id: string; name: string; liveMemoryCount: number; lastChangeAt: string }>;
    };
    expect(body.ok).toBe(true);
    const found = body.topics.find((t) => t.id === created.topicId);
    expect(found).toBeDefined();
    expect(found?.liveMemoryCount).toBeGreaterThanOrEqual(1);
    expect(typeof found?.lastChangeAt).toBe("string");
  });

  it("GET /v1/me/topics/:id returns the topic plus its live memories, paginated", async () => {
    const app = buildApp();
    const created = await makeMemory("a citable fact", `Topic Detail ${randomUUID()}`);

    const res = await app.request(`/v1/me/topics/${created.topicId}?limit=5&offset=0`, {
      headers: authHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      topic: { id: string };
      memories: Array<{ id: string; content: string; sourceEntryId: string }>;
      total: number;
    };
    expect(body.topic.id).toBe(created.topicId);
    const memoryEntry = body.memories.find((m) => m.id === created.memoryId);
    expect(memoryEntry?.content).toBe("a citable fact");
    expect(memoryEntry?.sourceEntryId).toBe(created.sourceEntryId);
    expect(body.total).toBeGreaterThanOrEqual(1);
  });

  it("404s for an unknown topic id", async () => {
    const app = buildApp();
    const res = await app.request(`/v1/me/topics/${randomUUID()}`, { headers: authHeaders });
    expect(res.status).toBe(404);
  });

  it("GET /v1/me/memories?topicId=none lists memories with no topic", async () => {
    const app = buildApp();
    const created = await makeMemory("a fact with no topic");

    const res = await app.request("/v1/me/memories?topicId=none", { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; memories: Array<{ id: string }> };
    expect(body.memories.some((m) => m.id === created.memoryId)).toBe(true);
  });
});

describe("PATCH/DELETE /v1/me/memories/:id", () => {
  it("corrects a memory's content by superseding it, and the correction is undoable", async () => {
    const app = buildApp();
    const created = await makeMemory("original content");

    const patchRes = await app.request(`/v1/me/memories/${created.memoryId}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ content: "corrected content" }),
    });
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as {
      ok: boolean;
      groupId: string;
      memoryId: string;
      supersededId: string;
    };
    expect(patchBody.supersededId).toBe(created.memoryId);

    const [oldRow] = await db.orm.select().from(memories).where(eq(memories.id, created.memoryId));
    expect(oldRow?.validTo).not.toBeNull();
    const [newRow] = await db.orm
      .select()
      .from(memories)
      .where(eq(memories.id, patchBody.memoryId));
    expect(newRow?.content).toBe("corrected content");

    const undoRes = await app.request(`/v1/me/changes/${patchBody.groupId}/undo`, {
      method: "POST",
      headers: authHeaders,
    });
    expect(undoRes.status).toBe(200);
    const undoBody = (await undoRes.json()) as { reverted: number };
    expect(undoBody.reverted).toBeGreaterThan(0);

    const [restoredOld] = await db.orm
      .select()
      .from(memories)
      .where(eq(memories.id, created.memoryId));
    expect(restoredOld?.validTo).toBeNull();
    const [deletedNew] = await db.orm
      .select()
      .from(memories)
      .where(eq(memories.id, patchBody.memoryId));
    expect(deletedNew).toBeUndefined();
  });

  it("404s correcting an unknown memory", async () => {
    const app = buildApp();
    const res = await app.request(`/v1/me/memories/${randomUUID()}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("400s a body that is neither { content } nor { topicId }", async () => {
    const app = buildApp();
    const created = await makeMemory("fact");
    const res = await app.request(`/v1/me/memories/${created.memoryId}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("moves a memory to another topic via { topicId }", async () => {
    const app = buildApp();
    const created = await makeMemory("movable fact", `Source Topic ${randomUUID()}`);
    const destination = await makeMemory("other fact", `Destination Topic ${randomUUID()}`);

    const res = await app.request(`/v1/me/memories/${created.memoryId}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ topicId: destination.topicId }),
    });
    expect(res.status).toBe(200);

    const [row] = await db.orm.select().from(memories).where(eq(memories.id, created.memoryId));
    expect(row?.topicId).toBe(destination.topicId);
    expect(row?.content).toBe("movable fact");
  });

  it("deletes (invalidates) a memory, and the deletion is undoable", async () => {
    const app = buildApp();
    const created = await makeMemory("fact to delete via http");

    const deleteRes = await app.request(`/v1/me/memories/${created.memoryId}`, {
      method: "DELETE",
      headers: authHeaders,
    });
    expect(deleteRes.status).toBe(200);
    const deleteBody = (await deleteRes.json()) as { groupId: string };

    const [invalidRow] = await db.orm
      .select()
      .from(memories)
      .where(eq(memories.id, created.memoryId));
    expect(invalidRow?.validTo).not.toBeNull();

    const undoRes = await app.request(`/v1/me/changes/${deleteBody.groupId}/undo`, {
      method: "POST",
      headers: authHeaders,
    });
    expect(undoRes.status).toBe(200);

    const [restoredRow] = await db.orm
      .select()
      .from(memories)
      .where(eq(memories.id, created.memoryId));
    expect(restoredRow?.validTo).toBeNull();
  });

  it("404s deleting an unknown memory", async () => {
    const app = buildApp();
    const res = await app.request(`/v1/me/memories/${randomUUID()}`, {
      method: "DELETE",
      headers: authHeaders,
    });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /v1/me/topics/:id", () => {
  it("renames a topic", async () => {
    const app = buildApp();
    const created = await makeMemory("fact", `Rename Via Http ${randomUUID()}`);

    const res = await app.request(`/v1/me/topics/${created.topicId}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ name: "Renamed Via Http" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { topic: { name: string } };
    expect(body.topic.name).toBe("Renamed Via Http");
  });

  it("409s when the new name conflicts case-insensitively with another topic", async () => {
    const app = buildApp();
    const unique = randomUUID();
    const topicA = await makeMemory("fact a", `Http Conflict A ${unique}`);
    const topicB = await makeMemory("fact b", `Http Conflict B ${unique}`);

    const res = await app.request(`/v1/me/topics/${topicB.topicId}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ name: `http conflict a ${unique}` }),
    });
    expect(res.status).toBe(409);
    void topicA;
  });

  it("400s an empty body", async () => {
    const app = buildApp();
    const created = await makeMemory("fact", `Empty Body ${randomUUID()}`);
    const res = await app.request(`/v1/me/topics/${created.topicId}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("rules", () => {
  it("upserts a rule via PUT, then deactivates it via DELETE, both undoable", async () => {
    const app = buildApp();
    const key = `http-test-rule-${randomUUID()}`;

    const putRes = await app.request(`/v1/me/rules/${key}`, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({ payload: { leadMinutes: 10 } }),
    });
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as { ruleId: string; action: string };
    expect(putBody.action).toBe("insert");
    createdRuleIds.push(putBody.ruleId);

    const listRes = await app.request("/v1/me/rules", { headers: authHeaders });
    const listBody = (await listRes.json()) as { rules: Array<{ key: string; payload: unknown }> };
    expect(listBody.rules.some((r) => r.key === key)).toBe(true);

    const deleteRes = await app.request(`/v1/me/rules/${key}`, {
      method: "DELETE",
      headers: authHeaders,
    });
    expect(deleteRes.status).toBe(200);
    const deleteBody = (await deleteRes.json()) as { groupId: string };

    const [deactivated] = await db.orm.select().from(rules).where(eq(rules.id, putBody.ruleId));
    expect(deactivated?.active).toBe(false);

    await app.request(`/v1/me/changes/${deleteBody.groupId}/undo`, {
      method: "POST",
      headers: authHeaders,
    });
    const [reactivated] = await db.orm.select().from(rules).where(eq(rules.id, putBody.ruleId));
    expect(reactivated?.active).toBe(true);
  });

  it("404s deactivating an unknown rule key", async () => {
    const app = buildApp();
    const res = await app.request("/v1/me/rules/does-not-exist", {
      method: "DELETE",
      headers: authHeaders,
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/me/changes", () => {
  it("groups a chat-turn write and a manual edit under distinct, correctly-kinded groups", async () => {
    const app = buildApp();
    const created = await makeMemory("fact for change history");

    const patchRes = await app.request(`/v1/me/memories/${created.memoryId}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ content: "edited fact for change history" }),
    });
    const patchBody = (await patchRes.json()) as { groupId: string };

    const res = await app.request("/v1/me/changes?limit=50", { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      changes: Array<{ groupId: string; source: string; summary: string; undone: boolean }>;
    };

    const manualGroup = body.changes.find((g) => g.groupId === patchBody.groupId);
    expect(manualGroup?.source).toBe("manual_edit");
    expect(manualGroup?.summary.length).toBeGreaterThan(0);

    const chatGroup = body.changes.find((g) => g.source === "chat_turn");
    expect(chatGroup).toBeDefined();
  });
});
