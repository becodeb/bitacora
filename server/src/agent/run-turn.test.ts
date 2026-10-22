import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../db/client.js";
import { agentRuns, changeLog, chatMessages, entries, memories } from "../db/schema.js";
import { createFakeEmbedder } from "../embeddings/test-helpers.js";
import { EMBED_QUEUE } from "../jobs/queues.js";
import { createScriptedJudge } from "../memory/test-helpers.js";
import { createHybridSearch } from "../search/hybrid-search.js";
import { assertDefined } from "../test/assert.js";
import { buildSystemPrompt } from "./prompt.js";
import { MAX_OUTPUT_TOKENS, runAgentTurn } from "./run-turn.js";
import { createScriptedClaudeClient } from "./test-helpers.js";
import { estimateTokensForMessage, estimateTokensForText } from "./token-budget.js";
import { AGENT_TOOLS } from "./tools.js";
import type { ClaudeTurnResult } from "./types.js";

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

async function makeEntry(text: string): Promise<string> {
  const [row] = await db.orm.insert(entries).values({ kind: "text", textBody: text }).returning({
    id: entries.id,
  });
  if (!row) throw new Error("failed to insert test entry");
  createdEntryIds.push(row.id);
  return row.id;
}

function baseDeps(scripts: ClaudeTurnResult[]) {
  const search = createHybridSearch({ db: db.orm, embedder: createFakeEmbedder() });
  const judge = createScriptedJudge([{ action: "add" }]);
  return {
    db: db.orm,
    claudeClient: createScriptedClaudeClient(scripts),
    hybridSearch: search.hybridSearch,
    findHints: search.findHints,
    memory: { db: db.orm, boss, embedder: createFakeEmbedder(), judge },
  };
}

describe("runAgentTurn", () => {
  it("streams text deltas and returns the final answer on end_turn", async () => {
    const entryId = await makeEntry("Hola");
    const deps = baseDeps([
      {
        content: [{ type: "text", text: "Hola, ¿en qué te ayudo?" }],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]);

    const chunks: string[] = [];
    const result = await runAgentTurn(deps, { entryId, onTextDelta: (t) => chunks.push(t) });

    expect(chunks.join("")).toBe("Hola, ¿en qué te ayudo?");
    expect(result.text).toBe("Hola, ¿en qué te ayudo?");
    expect(result.stopReason).toBe("end_turn");

    const runRows = await db.orm
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.turnId, result.turnId));
    expect(runRows).toHaveLength(1);
    expect(runRows[0]?.stopReason).toBe("end_turn");
  });

  it("runs the remember tool, creating a memory and change_log rows, then answers", async () => {
    const entryId = await makeEntry("Estudio Ingeniería en Sistemas en la UTN.");
    const deps = baseDeps([
      {
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "remember",
            input: { content: "Estudia Ingeniería en Sistemas." },
          },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 20, outputTokens: 10 },
      },
      {
        content: [{ type: "text", text: "Listo, lo anoté." }],
        stopReason: "end_turn",
        usage: { inputTokens: 30, outputTokens: 8 },
      },
    ]);

    const toolEvents: string[] = [];
    const result = await runAgentTurn(deps, {
      entryId,
      onToolEvent: (e) => toolEvents.push(e.name),
    });

    expect(result.text).toBe("Listo, lo anoté.");
    expect(toolEvents).toEqual(["remember"]);

    const logRows = await db.orm
      .select()
      .from(changeLog)
      .where(eq(changeLog.actionGroupId, result.turnId));
    expect(logRows).toHaveLength(1);
    expect(logRows[0]?.operation).toBe("insert");

    const [memoryRow] = await db.orm
      .select()
      .from(memories)
      .where(eq(memories.id, assertDefined(logRows[0]).targetId));
    expect(memoryRow?.content).toBe("Estudia Ingeniería en Sistemas.");
    expect(memoryRow?.sourceEntryId).toBe(entryId);
  });

  it("maps a [#n] citation in the final text back to its source entry id", async () => {
    const hintEntryId = await makeEntry("Estudio Ingeniería en Sistemas en la UTN.");
    const addJudge = createScriptedJudge([{ action: "add" }]);
    const fakeEmbedder = createFakeEmbedder();
    const search = createHybridSearch({ db: db.orm, embedder: fakeEmbedder });
    // Prime a live memory whose sourceEntryId is hintEntryId, so findHints can surface it.
    const { rememberFact } = await import("../memory/service.js");
    const { processEmbedJob } = await import("../jobs/embed.js");
    const primed = await rememberFact(
      { db: db.orm, boss, embedder: fakeEmbedder, judge: addJudge },
      {
        content: "Estudia Ingeniería en Sistemas",
        sourceEntryId: hintEntryId,
        turnId: randomUUID(),
      },
    );
    // Write the memory's embedding directly (same effect as the embed
    // worker that `enqueueEmbedJob` scheduled, which does not run in
    // this test), so the vector ranker has something to match against.
    await processEmbedJob(
      { db: db.orm, embedder: fakeEmbedder },
      { targetTable: "memories", targetId: assertDefined(primed.memoryId) },
    );

    const entryId = await makeEntry("qué estudio");
    const deps = {
      db: db.orm,
      claudeClient: createScriptedClaudeClient([
        {
          content: [{ type: "text", text: "Estudiás Ingeniería en Sistemas [#1]." }],
          stopReason: "end_turn" as const,
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      ]),
      hybridSearch: search.hybridSearch,
      findHints: search.findHints,
      memory: { db: db.orm, boss, embedder: createFakeEmbedder(), judge: addJudge },
    };

    const result = await runAgentTurn(deps, { entryId });

    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]?.sourceEntryId).toBe(hintEntryId);
  });

  it("stops without running tools on a refusal", async () => {
    const entryId = await makeEntry("mensaje cualquiera");
    const deps = baseDeps([
      {
        content: [{ type: "text", text: "" }],
        stopReason: "refusal",
        usage: { inputTokens: 5, outputTokens: 1 },
      },
    ]);

    const result = await runAgentTurn(deps, { entryId });
    expect(result.stopReason).toBe("refusal");
  });

  it("stops without running tools on max_tokens", async () => {
    const entryId = await makeEntry("mensaje cualquiera");
    const deps = baseDeps([
      {
        content: [
          { type: "tool_use", id: "toolu_1", name: "remember", input: { content: "truncated" } },
        ],
        stopReason: "max_tokens",
        usage: { inputTokens: 5, outputTokens: 4096 },
      },
    ]);

    const result = await runAgentTurn(deps, { entryId });
    expect(result.stopReason).toBe("max_tokens");

    // The remember tool must never have run on truncated input.
    const memoryRows = await db.orm
      .select()
      .from(memories)
      .where(eq(memories.content, "truncated"));
    expect(memoryRows).toHaveLength(0);
  });

  it("echoes the first iteration's thinking block back verbatim on the second call", async () => {
    const entryId = await makeEntry("mensaje con herramienta");
    const search = createHybridSearch({ db: db.orm, embedder: createFakeEmbedder() });
    const judge = createScriptedJudge([{ action: "add" }]);
    const claudeClient = createScriptedClaudeClient([
      {
        content: [
          {
            type: "thinking",
            thinking: "pensando si usar una herramienta...",
            signature: "sig-abc123",
          },
          { type: "tool_use", id: "toolu_1", name: "search", input: { query: "algo" } },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        content: [{ type: "text", text: "listo." }],
        stopReason: "end_turn",
        usage: { inputTokens: 20, outputTokens: 3 },
      },
    ]);
    const deps = {
      db: db.orm,
      claudeClient,
      hybridSearch: search.hybridSearch,
      findHints: search.findHints,
      memory: { db: db.orm, boss, embedder: createFakeEmbedder(), judge },
    };

    await runAgentTurn(deps, { entryId });

    expect(claudeClient.calls).toHaveLength(2);
    const secondCallMessages = claudeClient.calls[1]?.messages ?? [];
    const assistantMessageWithThinking = secondCallMessages.find((m) =>
      m.content.some((b) => b.type === "thinking"),
    );
    expect(assistantMessageWithThinking).toBeDefined();
    const thinkingBlock = assistantMessageWithThinking?.content.find((b) => b.type === "thinking");
    expect(thinkingBlock).toEqual({
      type: "thinking",
      thinking: "pensando si usar una herramienta...",
      signature: "sig-abc123",
    });
  });

  it("re-checks the token budget before every call: a tool exchange that grows past it stops offering tools", async () => {
    // This test computes its tiny budget from a known-empty history, so
    // start from one: other tests in this suite (and this file's shared
    // test database in general — see `odd/tasks/mvp.md`'s T06 notes on
    // `chat_messages` test cleanup) leave assistant/tool rows behind
    // with no per-entry id to scope a targeted cleanup to.
    await db.orm.delete(chatMessages);

    const messageText = "mensaje con herramienta y presupuesto chico";
    const script: ClaudeTurnResult[] = [
      {
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "remember",
            // A large input, not the tool's small result, is what
            // reliably grows `messages` between iteration 1 and 2 —
            // the fake `search`/`remember` tool results are tiny
            // regardless of input, but this `tool_use` block itself
            // (replayed verbatim into iteration 2's `messages`, like
            // any assistant content block) is exactly as large as its
            // `input`.
            input: { content: "x".repeat(6_000) },
          },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        content: [{ type: "text", text: "listo, con lo que había." }],
        stopReason: "end_turn",
        usage: { inputTokens: 20, outputTokens: 3 },
      },
    ];

    function makeDeps(maxInputTokenBudget?: number) {
      const search = createHybridSearch({ db: db.orm, embedder: createFakeEmbedder() });
      const judge = createScriptedJudge([{ action: "add" }]);
      return {
        db: db.orm,
        claudeClient: createScriptedClaudeClient(script),
        hybridSearch: search.hybridSearch,
        findHints: search.findHints,
        memory: { db: db.orm, boss, embedder: createFakeEmbedder(), judge },
        maxInputTokenBudget,
      };
    }

    // Phase A: run once with an effectively unlimited budget, purely to
    // measure exactly what iteration 1's own request costs in this
    // module's own estimate — reusing `run-turn.ts`'s exported
    // constants/helpers instead of re-deriving its internal arithmetic.
    const measuringEntryId = await makeEntry(messageText);
    const measuringClient = createScriptedClaudeClient(script);
    await runAgentTurn(
      {
        db: db.orm,
        claudeClient: measuringClient,
        hybridSearch: createHybridSearch({ db: db.orm, embedder: createFakeEmbedder() })
          .hybridSearch,
        findHints: createHybridSearch({ db: db.orm, embedder: createFakeEmbedder() }).findHints,
        memory: {
          db: db.orm,
          boss,
          embedder: createFakeEmbedder(),
          judge: createScriptedJudge([{ action: "add" }]),
        },
        maxInputTokenBudget: Number.MAX_SAFE_INTEGER,
      },
      { entryId: measuringEntryId },
    );
    const iteration1Messages = measuringClient.calls[0]?.messages ?? [];
    const iteration1Tokens =
      estimateTokensForText(buildSystemPrompt()) +
      estimateTokensForText(JSON.stringify(AGENT_TOOLS)) +
      iteration1Messages.reduce((sum, m) => sum + estimateTokensForMessage(m), 0) +
      MAX_OUTPUT_TOKENS;
    await db.orm.delete(chatMessages);

    // Phase B: a budget just above what iteration 1 alone measured —
    // comfortably enough for iteration 1 (identical request, same
    // history-less entry text) to pass, but not enough once iteration
    // 1's large `tool_use` input is appended ahead of iteration 2.
    const tinyBudget = iteration1Tokens + 50;
    const entryId = await makeEntry(messageText);
    const deps = makeDeps(tinyBudget);

    const result = await runAgentTurn(deps, { entryId });

    expect(deps.claudeClient.calls).toHaveLength(2);
    expect(deps.claudeClient.calls[0]?.tools.length).toBeGreaterThan(0);
    // Iteration 2, after the large tool_use input grew `messages`,
    // must not offer tools — the loop asks for a final answer instead
    // of growing further.
    expect(deps.claudeClient.calls[1]?.tools).toEqual([]);
    expect(result.hitTokenBudget).toBe(true);
    expect(result.text).toBe("listo, con lo que había.");
  });
});
