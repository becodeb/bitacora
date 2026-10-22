/**
 * Read-only queries for the "What I know about you" screen (T10,
 * `http/me.ts`). Kept separate from `memory/service.ts`, which owns
 * every *mutation* (dedup writes, rule writes, Undo) — this file never
 * writes anything.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { memories, rules, topics } from "../db/schema.js";

export interface TopicOverview {
  id: string;
  name: string;
  description: string | null;
  summary: string | null;
  liveMemoryCount: number;
  /** `memoriesChangedAt` when set, else the topic's own `createdAt` — see `db/schema.ts`'s comment on that column. */
  lastChangeAt: string;
}

function toTopicOverview(row: {
  id: string;
  name: string;
  description: string | null;
  summary: string | null;
  live_memory_count: string | number;
  last_change_at: string | Date;
}): TopicOverview {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    summary: row.summary,
    liveMemoryCount: Number(row.live_memory_count),
    lastChangeAt: new Date(row.last_change_at).toISOString(),
  };
}

/** All topics, most recently active first (see `TopicOverview.lastChangeAt`). */
export async function listTopicsOverview(db: NodePgDatabase): Promise<TopicOverview[]> {
  const result = await db.execute(sql`
    select
      t.id, t.name, t.description, t.summary,
      coalesce(t.memories_changed_at, t.created_at) as last_change_at,
      (select count(*) from memories m where m.topic_id = t.id and m.valid_to is null) as live_memory_count
    from topics t
    order by coalesce(t.memories_changed_at, t.created_at) desc
  `);
  return (
    result.rows as Array<{
      id: string;
      name: string;
      description: string | null;
      summary: string | null;
      live_memory_count: string | number;
      last_change_at: string | Date;
    }>
  ).map(toTopicOverview);
}

/** One topic's overview, or `null` if `topicId` does not exist. */
export async function getTopicOverview(
  db: NodePgDatabase,
  topicId: string,
): Promise<TopicOverview | null> {
  const result = await db.execute(sql`
    select
      t.id, t.name, t.description, t.summary,
      coalesce(t.memories_changed_at, t.created_at) as last_change_at,
      (select count(*) from memories m where m.topic_id = t.id and m.valid_to is null) as live_memory_count
    from topics t
    where t.id = ${topicId}
  `);
  const row = result.rows[0] as
    | {
        id: string;
        name: string;
        description: string | null;
        summary: string | null;
        live_memory_count: string | number;
        last_change_at: string | Date;
      }
    | undefined;
  return row ? toTopicOverview(row) : null;
}

export interface MemorySummary {
  id: string;
  content: string;
  topicId: string | null;
  /** Citation-ready: the raw-log entry this memory was derived from (`GET /v1/entries/:id`). */
  sourceEntryId: string;
  createdAt: string;
  validFrom: string;
}

export interface ListMemoriesParams {
  /** `"none"` lists memories with no topic. */
  topicId: string | "none";
  limit: number;
  offset: number;
}

export interface ListMemoriesResult {
  memories: MemorySummary[];
  total: number;
}

/** Live (currently-valid) memories for one topic, or with no topic at all (`topicId: "none"`), paginated, newest first. */
export async function listLiveMemories(
  db: NodePgDatabase,
  params: ListMemoriesParams,
): Promise<ListMemoriesResult> {
  const topicFilter =
    params.topicId === "none" ? isNull(memories.topicId) : eq(memories.topicId, params.topicId);
  const where = and(isNull(memories.validTo), topicFilter);

  const rows = await db
    .select({
      id: memories.id,
      content: memories.content,
      topicId: memories.topicId,
      sourceEntryId: memories.sourceEntryId,
      createdAt: memories.createdAt,
      validFrom: memories.validFrom,
    })
    .from(memories)
    .where(where)
    .orderBy(desc(memories.validFrom))
    .limit(params.limit)
    .offset(params.offset);

  const [countRow] = await db.select({ count: sql<number>`count(*)` }).from(memories).where(where);

  return {
    memories: rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      validFrom: row.validFrom.toISOString(),
    })),
    total: Number(countRow?.count ?? 0),
  };
}

export interface RuleSummary {
  key: string;
  payload: unknown;
  topicName: string | null;
}

/** Every active rule, with its topic's name (not just id) for direct display. */
export async function listActiveRules(db: NodePgDatabase): Promise<RuleSummary[]> {
  return db
    .select({ key: rules.key, payload: rules.payload, topicName: topics.name })
    .from(rules)
    .leftJoin(topics, eq(rules.topicId, topics.id))
    .where(eq(rules.active, true))
    .orderBy(rules.key);
}

export interface ChangeGroupSummary {
  groupId: string;
  source: "chat_turn" | "consolidation" | "manual_edit";
  createdAt: string;
  /** True only when every row in the group has been undone. */
  undone: boolean;
  /** Short human-readable description, e.g. "1 memory added, 1 memory updated". */
  summary: string;
}

interface ChangeGroupRow {
  action_group_id: string;
  source: "chat_turn" | "consolidation" | "manual_edit";
  created_at: string | Date;
  fully_undone: boolean;
  ops: Array<{ targetTable: string; operation: string }>;
}

const OP_LABELS: Array<{ key: string; singular: string; plural: string }> = [
  { key: "memories:insert", singular: "memory added", plural: "memories added" },
  { key: "memories:update", singular: "memory updated", plural: "memories updated" },
  { key: "rules:insert", singular: "rule added", plural: "rules added" },
  { key: "rules:update", singular: "rule updated", plural: "rules updated" },
  { key: "topics:update", singular: "topic renamed", plural: "topics renamed" },
];

/** Builds the short human-readable `summary` for one change group from its rows' `(targetTable, operation)` pairs. */
export function summarizeChangeGroupOps(
  ops: Array<{ targetTable: string; operation: string }>,
): string {
  const counts = new Map<string, number>();
  for (const op of ops) {
    const key = `${op.targetTable}:${op.operation}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const parts: string[] = [];
  for (const label of OP_LABELS) {
    const n = counts.get(label.key);
    if (n) {
      parts.push(`${n} ${n === 1 ? label.singular : label.plural}`);
    }
  }
  return parts.length > 0 ? parts.join(", ") : "no changes";
}

/** Recent change groups (one per `actionGroupId`), newest first, for `GET /v1/me/changes`'s history-with-Undo list. */
export async function listChangeGroups(
  db: NodePgDatabase,
  limit: number,
): Promise<ChangeGroupSummary[]> {
  const result = await db.execute(sql`
    select
      action_group_id,
      min(source)::text as source,
      max(created_at) as created_at,
      bool_and(undone_at is not null) as fully_undone,
      json_agg(json_build_object('targetTable', target_table, 'operation', operation)) as ops
    from change_log
    group by action_group_id
    order by max(created_at) desc
    limit ${limit}
  `);

  return (result.rows as unknown as ChangeGroupRow[]).map((row) => ({
    groupId: row.action_group_id,
    source: row.source,
    createdAt: new Date(row.created_at).toISOString(),
    undone: row.fully_undone,
    summary: summarizeChangeGroupOps(row.ops),
  }));
}
