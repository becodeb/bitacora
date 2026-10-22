/**
 * Tool definitions and dispatcher for the agent turn. Calendar tools
 * come in T12 — `AGENT_TOOLS` and `executeTool` are written so adding
 * one more tool is just one more entry in each, no structural change.
 */
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import { memories, topics } from "../db/schema.js";
import type { MemoryServiceDeps } from "../memory/service.js";
import { rememberFact, undoLast, updateRule } from "../memory/service.js";
import type { createHybridSearch } from "../search/hybrid-search.js";
import type { SearchScope } from "../search/types.js";
import { fetchHitText } from "./content-lookup.js";
import type { RefTracker } from "./refs.js";
import type { AgentToolDefinition } from "./types.js";

export const AGENT_TOOLS: AgentToolDefinition[] = [
  {
    name: "open_topic",
    description:
      "Get the live (currently valid) memories filed under one named topic, e.g. 'University'. Use this when the owner's message relates to a topic you know about.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "The topic's name." } },
      required: ["name"],
    },
  },
  {
    name: "search",
    description:
      "Hybrid search over memories, topics and the raw log for anything matching a query. Use this when the given hints are not enough to answer.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        scopes: {
          type: "array",
          items: { type: "string", enum: ["memories", "topics", "entries"] },
          description: "Defaults to all three scopes if omitted.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "remember",
    description:
      "Save a new atomic fact about the owner. Deduplicated automatically: if it is already known, nothing changes; if it corrects a known fact, the old one is superseded (not lost).",
    input_schema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The fact, as one atomic statement." },
        topic: { type: "string", description: "Optional topic name to file it under." },
        source_ref: {
          type: "string",
          description:
            "Optional ref (e.g. '#2') of the hint/search-result this fact came from. Defaults to the owner's current message.",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "update_rule",
    description:
      "Save or update a structured rule (e.g. an event title format, a reminder lead time) the server applies when running tools, so it costs no context later.",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string" },
        payload: { type: "object", description: "The rule's structured value." },
        topic: { type: "string" },
      },
      required: ["key", "payload"],
    },
  },
  {
    name: "undo",
    description: "Undo the most recent turn's actions (new memories, rule changes).",
    input_schema: {
      type: "object",
      properties: { scope: { type: "string", enum: ["last_turn"] } },
      required: ["scope"],
    },
  },
];

export interface AgentToolsDeps {
  db: NodePgDatabase;
  hybridSearch: ReturnType<typeof createHybridSearch>["hybridSearch"];
  memory: MemoryServiceDeps;
  refTracker: RefTracker;
  turnId: string;
  /** The chat message's own entry — `remember`'s default `sourceEntryId` when no `source_ref` is given or it does not resolve. */
  defaultSourceEntryId: string;
}

export interface ToolExecutionResult {
  /** Sent back to Claude as the `tool_result` content. */
  resultText: string;
  isError: boolean;
  /** Short status for the SSE `tool` event (see `http/chat.ts`) — never includes full content. */
  statusSummary: string;
}

function formatHits(hits: Array<{ ref: string; scope: string; text: string }>): string {
  if (hits.length === 0) return "(no results)";
  return hits.map((h) => `${h.ref} [${h.scope}] ${h.text}`).join("\n");
}

const openTopicInput = z.object({ name: z.string().min(1) });
const searchInput = z.object({
  query: z.string().min(1),
  scopes: z.array(z.enum(["memories", "topics", "entries"])).optional(),
});
const rememberInput = z.object({
  content: z.string().min(1),
  topic: z.string().optional(),
  source_ref: z.string().optional(),
});
const updateRuleInput = z.object({
  key: z.string().min(1),
  payload: z.unknown(),
  topic: z.string().optional(),
});
const undoInput = z.object({ scope: z.literal("last_turn") });

async function runOpenTopic(input: unknown, deps: AgentToolsDeps): Promise<ToolExecutionResult> {
  const parsed = openTopicInput.safeParse(input);
  if (!parsed.success) {
    return invalidInput(parsed.error.message);
  }

  const [topic] = await deps.db
    .select({ id: topics.id, name: topics.name })
    .from(topics)
    .where(sql`lower(${topics.name}) = lower(${parsed.data.name})`);
  if (!topic) {
    return {
      resultText: `No topic named '${parsed.data.name}' exists yet.`,
      isError: false,
      statusSummary: "topic not found",
    };
  }

  const rows = await deps.db
    .select({ id: memories.id, content: memories.content, sourceEntryId: memories.sourceEntryId })
    .from(memories)
    .where(sql`${memories.topicId} = ${topic.id} and ${memories.validTo} is null`)
    .orderBy(memories.createdAt);

  const hits = rows.map((row) => ({
    ref: deps.refTracker.assign(row.sourceEntryId),
    scope: "memory",
    text: row.content,
  }));

  return {
    resultText: formatHits(hits),
    isError: false,
    statusSummary: `opened topic '${topic.name}' (${rows.length} memories)`,
  };
}

async function runSearch(input: unknown, deps: AgentToolsDeps): Promise<ToolExecutionResult> {
  const parsed = searchInput.safeParse(input);
  if (!parsed.success) {
    return invalidInput(parsed.error.message);
  }

  const scopes: SearchScope[] = parsed.data.scopes ?? ["memories", "topics", "entries"];
  const results = await deps.hybridSearch({ query: parsed.data.query, scopes });

  const hits = await Promise.all(
    results.map(async (hit) => ({
      ref: deps.refTracker.assign(hit.sourceEntryId ?? hit.id),
      scope: hit.scope,
      text: await fetchHitText(deps.db, hit),
    })),
  );

  return {
    resultText: formatHits(hits),
    isError: false,
    statusSummary: `search '${parsed.data.query}' (${hits.length} results)`,
  };
}

async function runRemember(input: unknown, deps: AgentToolsDeps): Promise<ToolExecutionResult> {
  const parsed = rememberInput.safeParse(input);
  if (!parsed.success) {
    return invalidInput(parsed.error.message);
  }

  const sourceEntryId =
    (parsed.data.source_ref ? deps.refTracker.resolve(parsed.data.source_ref) : undefined) ??
    deps.defaultSourceEntryId;

  const result = await rememberFact(deps.memory, {
    content: parsed.data.content,
    topicName: parsed.data.topic,
    sourceEntryId,
    turnId: deps.turnId,
  });

  const summary =
    result.action === "noop"
      ? "noop: already known"
      : result.action === "update"
        ? `updated (superseded ${result.supersededId})`
        : "added";

  return {
    resultText: `remember: ${summary}`,
    isError: false,
    statusSummary: `remember: ${summary}`,
  };
}

async function runUpdateRule(input: unknown, deps: AgentToolsDeps): Promise<ToolExecutionResult> {
  const parsed = updateRuleInput.safeParse(input);
  if (!parsed.success) {
    return invalidInput(parsed.error.message);
  }

  const result = await updateRule(deps.memory, {
    key: parsed.data.key,
    payload: parsed.data.payload,
    topicName: parsed.data.topic,
    turnId: deps.turnId,
  });

  return {
    resultText: `update_rule: ${result.action} '${parsed.data.key}'`,
    isError: false,
    statusSummary: `update_rule: ${result.action} '${parsed.data.key}'`,
  };
}

async function runUndo(input: unknown, deps: AgentToolsDeps): Promise<ToolExecutionResult> {
  const parsed = undoInput.safeParse(input);
  if (!parsed.success) {
    return invalidInput(parsed.error.message);
  }

  const result = await undoLast(deps.memory);
  const summary = result
    ? `undid turn ${result.turnId} (${result.revertedCount} changes)`
    : "nothing to undo";

  return { resultText: `undo: ${summary}`, isError: false, statusSummary: `undo: ${summary}` };
}

function invalidInput(message: string): ToolExecutionResult {
  return {
    resultText: JSON.stringify({ INVALID_INPUT: message }),
    isError: true,
    statusSummary: "invalid input",
  };
}

const RUNNERS: Record<
  string,
  (input: unknown, deps: AgentToolsDeps) => Promise<ToolExecutionResult>
> = {
  open_topic: runOpenTopic,
  search: runSearch,
  remember: runRemember,
  update_rule: runUpdateRule,
  undo: runUndo,
};

export async function executeTool(
  name: string,
  input: unknown,
  deps: AgentToolsDeps,
): Promise<ToolExecutionResult> {
  const runner = RUNNERS[name];
  if (!runner) {
    return {
      resultText: JSON.stringify({ UNKNOWN_TOOL: name }),
      isError: true,
      statusSummary: `unknown tool '${name}'`,
    };
  }
  try {
    return await runner(input, deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`tool '${name}' failed:`, error);
    return {
      resultText: JSON.stringify({ TOOL_ERROR: message }),
      isError: true,
      statusSummary: `'${name}' failed`,
    };
  }
}
