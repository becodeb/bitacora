import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc, eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createScriptedClaudeClient } from "../agent/test-helpers.js";
import type { ClaudeTurnResult } from "../agent/types.js";
import { createDb } from "../db/client.js";
import { chatMessages, entries, memories } from "../db/schema.js";
import { createFakeEmbedder } from "../embeddings/test-helpers.js";
import type { IngestDeps } from "../ingestion/entries.js";
import { EMBED_QUEUE, PHOTO_OCR_QUEUE, VOICE_TRANSCRIPTION_QUEUE } from "../jobs/queues.js";
import { createScriptedJudge } from "../memory/test-helpers.js";
import { createHybridSearch } from "../search/hybrid-search.js";
import { createFileAttachmentStorage } from "../storage/attachment-storage.js";
import { assertDefined } from "../test/assert.js";
import { createApp } from "./app.js";
import { createStubAdminJobsDeps } from "./test-helpers.js";

const DEV_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://bitacora:bitacora@localhost:55432/bitacora";
const APP_TOKEN = "chat-test-token-0123456789";

const db = createDb(DEV_DATABASE_URL);
const boss = new PgBoss(DEV_DATABASE_URL);

let dataDir: string;
let ingest: IngestDeps;
const createdEntryIds: string[] = [];

beforeAll(async () => {
  await boss.start();
  await boss.createQueue(VOICE_TRANSCRIPTION_QUEUE);
  await boss.createQueue(PHOTO_OCR_QUEUE);
  await boss.createQueue(EMBED_QUEUE);
  dataDir = await mkdtemp(join(tmpdir(), "bitacora-chat-http-"));
  ingest = { db: db.orm, boss, storage: createFileAttachmentStorage(dataDir) };
});

afterAll(async () => {
  await boss.stop({ timeout: 2_000 });
  await db.pool.end();
  await rm(dataDir, { recursive: true, force: true });
});

afterEach(async () => {
  while (createdEntryIds.length > 0) {
    const entryId = createdEntryIds.pop();
    if (entryId) {
      await db.orm.delete(chatMessages).where(eq(chatMessages.entryId, entryId));
      await db.orm.delete(memories).where(eq(memories.sourceEntryId, entryId));
      await db.orm.delete(entries).where(eq(entries.id, entryId));
    }
  }
});

function buildApp(scripts: ClaudeTurnResult[]) {
  const search = createHybridSearch({ db: db.orm, embedder: createFakeEmbedder() });
  const judge = createScriptedJudge([{ action: "add" }]);
  const agent = {
    db: db.orm,
    claudeClient: createScriptedClaudeClient(scripts),
    hybridSearch: search.hybridSearch,
    findHints: search.findHints,
    memory: { db: db.orm, boss, embedder: createFakeEmbedder(), judge },
  };
  return createApp({
    appToken: APP_TOKEN,
    checkDb: async () => true,
    ingest,
    agent,
    adminJobs: createStubAdminJobsDeps(),
  });
}

const authHeaders = { Authorization: `Bearer ${APP_TOKEN}` };

/** Parses `event: x\ndata: y\n\n`-shaped SSE text into `{event, data}` pairs. */
function parseSse(text: string): Array<{ event: string; data: string }> {
  return text
    .trim()
    .split("\n\n")
    .filter((block) => block.length > 0)
    .map((block) => {
      const eventLine = block.split("\n").find((l) => l.startsWith("event: "));
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
      return {
        event: eventLine?.slice("event: ".length) ?? "",
        data: dataLine?.slice("data: ".length) ?? "",
      };
    });
}

describe("POST /v1/chat", () => {
  it("rejects a request with no bearer token", async () => {
    const app = buildApp([]);
    const res = await app.request("/v1/chat", {
      method: "POST",
      body: JSON.stringify({ text: "hola" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(401);
  });

  it("streams text deltas and a done event for a plain text turn", async () => {
    const app = buildApp([
      {
        content: [{ type: "text", text: "Hola, ¿en qué te ayudo?" }],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]);

    const res = await app.request("/v1/chat", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ text: "hola" }),
    });

    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    const textEvents = events.filter((e) => e.event === "text");
    expect(textEvents.map((e) => e.data).join("")).toBe("Hola, ¿en qué te ayudo?");
    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent).toBeDefined();
    expect(JSON.parse(assertDefined(doneEvent).data).stopReason).toBe("end_turn");

    const [entryRow] = await db.orm.select().from(entries).where(eq(entries.textBody, "hola"));
    expect(entryRow).toBeDefined();
    if (entryRow) createdEntryIds.push(entryRow.id);
  });

  it("runs the remember tool and the memory is undoable via POST /v1/chat/undo", async () => {
    const app = buildApp([
      {
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "remember",
            input: { content: "El owner vive en Montevideo." },
          },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        content: [{ type: "text", text: "Listo, lo anoté." }],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]);

    const res = await app.request("/v1/chat", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ text: "vivo en Montevideo" }),
    });
    const events = parseSse(await res.text());
    const toolEvent = events.find((e) => e.event === "tool");
    expect(toolEvent).toBeDefined();
    expect(JSON.parse(assertDefined(toolEvent).data).name).toBe("remember");

    const [entryRow] = await db.orm
      .select()
      .from(entries)
      .where(eq(entries.textBody, "vivo en Montevideo"));
    if (entryRow) createdEntryIds.push(entryRow.id);

    const [memoryRow] = await db.orm
      .select()
      .from(memories)
      .where(eq(memories.content, "El owner vive en Montevideo."));
    expect(memoryRow).toBeDefined();

    const undoRes = await app.request("/v1/chat/undo", { method: "POST", headers: authHeaders });
    expect(undoRes.status).toBe(200);
    const undoBody = (await undoRes.json()) as { reverted: number };
    expect(undoBody.reverted).toBeGreaterThan(0);

    const [memoryAfterUndo] = await db.orm
      .select()
      .from(memories)
      .where(eq(memories.content, "El owner vive en Montevideo."));
    expect(memoryAfterUndo).toBeUndefined();
  });

  it("rejects an unauthorized undo", async () => {
    const app = buildApp([]);
    const res = await app.request("/v1/chat/undo", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("GET /v1/chat/history returns recent messages", async () => {
    const app = buildApp([
      {
        content: [{ type: "text", text: "hola de nuevo" }],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    const chatRes = await app.request("/v1/chat", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ text: "historial de prueba" }),
    });
    await chatRes.text();
    const [entryRow] = await db.orm
      .select()
      .from(entries)
      .where(eq(entries.textBody, "historial de prueba"));
    if (entryRow) createdEntryIds.push(entryRow.id);

    const historyRes = await app.request("/v1/chat/history?limit=5", { headers: authHeaders });
    expect(historyRes.status).toBe(200);
    const body = (await historyRes.json()) as { ok: boolean; messages: unknown[] };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.length).toBeGreaterThan(0);
  });

  it("handles a refusal without crashing", async () => {
    const app = buildApp([
      {
        content: [{ type: "text", text: "" }],
        stopReason: "refusal",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    const res = await app.request("/v1/chat", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ text: "mensaje cualquiera" }),
    });
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent).toBeDefined();
    expect(JSON.parse(assertDefined(doneEvent).data).stopReason).toBe("refusal");

    const [entryRow] = await db.orm
      .select()
      .from(entries)
      .where(eq(entries.textBody, "mensaje cualquiera"));
    if (entryRow) createdEntryIds.push(entryRow.id);
  });

  it("rejects an empty JSON body", async () => {
    const app = buildApp([]);
    const res = await app.request("/v1/chat", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("404s on a chat turn for an entryId that does not exist", async () => {
    const app = buildApp([]);
    const res = await app.request("/v1/chat", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ entryId: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(res.status).toBe(404);
  });

  it("never leaks a raw exception message over SSE on an internal error", async () => {
    const sensitiveDetail = "postgresql://bitacora:s3cr3t-password@internal-host:5432/bitacora";
    const search = createHybridSearch({ db: db.orm, embedder: createFakeEmbedder() });
    const judge = createScriptedJudge([{ action: "add" }]);
    const agent = {
      db: db.orm,
      claudeClient: {
        async runTurn(): Promise<never> {
          throw new Error(`connection failed: ${sensitiveDetail}`);
        },
      },
      hybridSearch: search.hybridSearch,
      findHints: search.findHints,
      memory: { db: db.orm, boss, embedder: createFakeEmbedder(), judge },
    };
    const app = createApp({
      appToken: APP_TOKEN,
      checkDb: async () => true,
      ingest,
      agent,
      adminJobs: createStubAdminJobsDeps(),
    });

    const res = await app.request("/v1/chat", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ text: "mensaje que dispara un error interno" }),
    });

    const [entryRow] = await db.orm
      .select()
      .from(entries)
      .where(eq(entries.textBody, "mensaje que dispara un error interno"));
    if (entryRow) createdEntryIds.push(entryRow.id);

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(sensitiveDetail);
    expect(text).not.toContain("s3cr3t-password");

    const events = parseSse(text);
    const errorEvent = events.find((e) => e.event === "error");
    expect(errorEvent).toBeDefined();
    const body = JSON.parse(assertDefined(errorEvent).data) as { code: string; message: string };
    expect(body.code).toBe("internal_error");
    expect(body.message).not.toContain(sensitiveDetail);
  });

  it("serializes two concurrent turns: chat_messages persist in order, never interleaved", async () => {
    // A clean slate so this test's own rows are the only ones ordered
    // below (chat_messages assistant/tool rows have no entryId to
    // scope a targeted cleanup to — see `odd/tasks/mvp.md`'s T06 notes).
    await db.orm.delete(chatMessages);

    function delay(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // One claudeClient shared by both concurrent requests (both go
    // through the same app/router, hence the same mutex instance) —
    // it echoes back whichever letter (A/B) is in the owner's own
    // message, and deliberately answers "A" slower: without the
    // mutex, B's writes would very likely land in between A's two
    // writes (A-user, B-user, B-assistant, A-assistant).
    const sharedClaudeClient = {
      async runTurn(
        request: { messages: Array<{ content: Array<{ type: string; text?: string }> }> },
        onTextDelta: (text: string) => void,
      ): Promise<ClaudeTurnResult> {
        // The last message's content is [contextBlock, messageText] (see
        // `agent/run-turn.ts`'s `apiUserMessage`) — the owner's own text
        // is the LAST text block, not the first (which is the volatile
        // topics/hints/date context block).
        const lastMessage = request.messages.at(-1);
        const userText = lastMessage?.content.filter((b) => b.type === "text").at(-1)?.text ?? "";
        const letter = userText.endsWith("A") ? "A" : "B";
        await delay(letter === "A" ? 30 : 1);
        const replyText = `respuesta concurrente ${letter}`;
        onTextDelta(replyText);
        return {
          content: [{ type: "text", text: replyText }],
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };

    function buildAgentDeps() {
      const search = createHybridSearch({ db: db.orm, embedder: createFakeEmbedder() });
      const judge = createScriptedJudge([{ action: "add" }]);
      return {
        db: db.orm,
        claudeClient: sharedClaudeClient,
        hybridSearch: search.hybridSearch,
        findHints: search.findHints,
        memory: { db: db.orm, boss, embedder: createFakeEmbedder(), judge },
      };
    }

    const appA = createApp({
      appToken: APP_TOKEN,
      checkDb: async () => true,
      ingest,
      agent: buildAgentDeps(),
      adminJobs: createStubAdminJobsDeps(),
    });

    const requestA = appA.request("/v1/chat", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ text: "mensaje concurrente A" }),
    });
    const requestB = appA.request("/v1/chat", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ text: "mensaje concurrente B" }),
    });

    const [resA, resB] = await Promise.all([requestA, requestB]);
    await Promise.all([resA.text(), resB.text()]);

    for (const text of ["mensaje concurrente A", "mensaje concurrente B"]) {
      const [entryRow] = await db.orm.select().from(entries).where(eq(entries.textBody, text));
      if (entryRow) createdEntryIds.push(entryRow.id);
    }

    const rows = await db.orm.select().from(chatMessages).orderBy(asc(chatMessages.createdAt));
    expect(rows).toHaveLength(4);

    const labels = rows.map((row) => {
      const block = (row.content as Array<{ type: string; text?: string }>).find(
        (b) => b.type === "text",
      );
      return block?.text?.endsWith("A") ? "A" : "B";
    });
    // Exactly one of the two contiguous orderings — never interleaved.
    expect(labels).toEqual(labels[0] === "A" ? ["A", "A", "B", "B"] : ["B", "B", "A", "A"]);
  });
});
