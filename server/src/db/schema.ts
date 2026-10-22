import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

/**
 * Dimensionality of every embedding column in this schema. Voyage AI's
 * default embedding model (see `odd/tasks/mvp.md`, "Embeddings") returns
 * 1024-dimensional vectors; keep this in sync if that model ever changes.
 */
const EMBEDDING_DIMENSIONS = 1024;

/**
 * Postgres `tsvector`, used for generated full-text-search columns.
 * Drizzle has no built-in column type for it, so it is declared as a
 * minimal custom type: the database computes and stores its value, the
 * application never reads or writes it directly.
 */
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const entryKind = pgEnum("entry_kind", ["text", "photo", "voice"]);

export const attachmentDerivedTextStatus = pgEnum("attachment_derived_text_status", [
  "pending",
  "done",
  "failed",
  // The derivation engine for this attachment's kind is not wired up yet
  // (e.g. OCR, chosen in T07). Distinct from "failed": nothing went
  // wrong and retrying will not help, so pg-boss must not retry it.
  "not_available",
]);

export const chatMessageRole = pgEnum("chat_message_role", ["user", "assistant", "tool"]);

export const changeLogOperation = pgEnum("change_log_operation", ["insert", "update", "delete"]);

/**
 * What caused a `change_log` group: an agent turn's own tool call
 * (`memory/service.ts`'s `rememberFact`/`updateRule`), the nightly
 * consolidation job (T08, `consolidation/consolidation.ts`), or an
 * owner-made correction from the "What I know about you" screen (T10,
 * `http/me.ts`). Lets `GET /v1/me/changes` tell the three apart without
 * guessing from a group's row shapes.
 */
export const changeLogSource = pgEnum("change_log_source", [
  "chat_turn",
  "consolidation",
  "manual_edit",
]);

/**
 * Named groups of memories ("University", "Work", "Juan", ...). Names are
 * unique case-insensitively via `topicsNameUniqueIdx` below, so "Juan" and
 * "juan" collide.
 */
export const topics = pgTable(
  "topics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    summary: text("summary"),
    // Bumped to `now()` whenever a live memory belonging to this topic is
    // written (see `memory/service.ts`'s `bumpTopicMemoriesChanged` and
    // `consolidation/consolidation.ts`). Compared against
    // `summaryGeneratedAt` by the nightly consolidation job (T08) to
    // decide which topics' summaries are stale. `null` means "no memory
    // has ever been written for this topic through that bump" — in
    // practice, a topic with zero live memories (nothing to summarize
    // yet), since every memory write that sets a topic also bumps this
    // column in the same transaction. Such a topic is not treated as
    // stale (see `consolidation/consolidation.ts`'s `findStaleTopics`).
    memoriesChangedAt: timestamp("memories_changed_at", { withTimezone: true }),
    // Set by the nightly consolidation job each time it regenerates
    // `summary`. `null` until the first regeneration.
    summaryGeneratedAt: timestamp("summary_generated_at", { withTimezone: true }),
    // Nullable: populated asynchronously once embeddings are wired up (T05).
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`to_tsvector('spanish', coalesce(name, '') || ' ' || coalesce(description, '') || ' ' || coalesce(summary, ''))`,
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("topics_name_lower_unique_idx").on(sql`lower(${table.name})`),
    index("topics_name_trgm_idx").using("gin", sql`${table.name} gin_trgm_ops`),
    index("topics_search_vector_idx").using("gin", table.searchVector),
    index("topics_embedding_hnsw_idx").using("hnsw", sql`${table.embedding} vector_cosine_ops`),
  ],
);

/**
 * The immutable raw log: everything the owner sends. Rows are never
 * updated in place for their own authored content — a correction creates
 * new memories, it does not rewrite the entry. `derivedText` is the one
 * documented exception (see its own comment below).
 */
export const entries = pgTable(
  "entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: entryKind("kind").notNull(),
    // The owner's own authored text: the full text for a "text" entry, or
    // an optional caption for a "photo"/"voice" entry. Set once, at
    // ingestion time, and never mutated afterwards.
    textBody: text("text_body"),
    // OCR text ("photo") or transcript ("voice"), filled in by the T04
    // async derivation job. Starts `null` and is written exactly once,
    // when the job completes — never overwritten afterwards, so the
    // owner's own `textBody` (the caption) is never clobbered by a
    // transcript that arrives later. `null` forever for "text" entries,
    // which have no attachment to derive anything from.
    derivedText: text("derived_text"),
    // Free-form provenance (e.g. share-target app, client app version).
    source: jsonb("source"),
    // Any other derived/structured metadata that does not deserve its own
    // column yet (e.g. detected language, OCR engine confidence).
    metadata: jsonb("metadata"),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`to_tsvector('spanish', coalesce(text_body, '') || ' ' || coalesce(derived_text, ''))`,
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("entries_kind_idx").on(table.kind),
    index("entries_text_body_trgm_idx").using("gin", sql`${table.textBody} gin_trgm_ops`),
    index("entries_derived_text_trgm_idx").using("gin", sql`${table.derivedText} gin_trgm_ops`),
    index("entries_search_vector_idx").using("gin", table.searchVector),
    index("entries_embedding_hnsw_idx").using("hnsw", sql`${table.embedding} vector_cosine_ops`),
  ],
);

/**
 * Files linked to an entry (the photo or voice recording itself). An
 * entry's `textBody` already holds the derived text once ready;
 * `derivedTextStatus` tracks that async OCR/transcription step.
 */
export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Attachments have no meaning without their entry: deleting the entry
    // deletes its attachments too.
    entryId: uuid("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    derivedTextStatus: attachmentDerivedTextStatus("derived_text_status")
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("attachments_entry_id_idx").on(table.entryId)],
);

/**
 * Atomic facts extracted from entries. Memories are never edited in
 * place: a correction inserts a new memory whose `supersedesId` points at
 * the old one, and the write path sets the old memory's `validTo` in the
 * same transaction. `validTo IS NULL` means "currently valid".
 */
export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    content: text("content").notNull(),
    topicId: uuid("topic_id").references(() => topics.id, { onDelete: "set null" }),
    // `restrict`, not `cascade`: the raw log is immutable and must not
    // disappear as a side effect of deleting the memories derived from it.
    // Deleting an entry that still has memories pointing at it fails
    // loudly instead of silently losing provenance.
    sourceEntryId: uuid("source_entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "restrict" }),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    supersedesId: uuid("supersedes_id").references((): AnyPgColumn => memories.id, {
      onDelete: "set null",
    }),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`to_tsvector('spanish', coalesce(content, ''))`,
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("memories_topic_id_idx").on(table.topicId),
    index("memories_source_entry_id_idx").on(table.sourceEntryId),
    // Partial index: the dedup/write path (T06) only ever looks at
    // currently-valid memories, which is also the common case.
    index("memories_valid_idx").on(table.validTo).where(sql`valid_to is null`),
    index("memories_content_trgm_idx").using("gin", sql`${table.content} gin_trgm_ops`),
    index("memories_search_vector_idx").using("gin", table.searchVector),
    index("memories_embedding_hnsw_idx").using("hnsw", sql`${table.embedding} vector_cosine_ops`),
  ],
);

/**
 * Structured templates the server applies when a tool runs (e.g. an event
 * title format, a reminder lead time), so they cost no LLM context.
 */
export const rules = pgTable(
  "rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    topicId: uuid("topic_id").references(() => topics.id, { onDelete: "set null" }),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("rules_key_unique_idx").on(table.key),
    index("rules_topic_id_idx").on(table.topicId),
  ],
);

/**
 * Append-only log of every mutation the server makes, used to implement
 * Undo. `actionGroupId` groups every row written by a single logical
 * action (e.g. "scheduled 4 exams") so Undo reverts them together.
 */
export const changeLog = pgTable(
  "change_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actionGroupId: uuid("action_group_id").notNull(),
    targetTable: text("target_table").notNull(),
    targetId: uuid("target_id").notNull(),
    operation: changeLogOperation("operation").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    // Every row in one `actionGroupId` group is always written by the
    // same caller in the same transaction set, so this is uniform
    // within a group — see `changeLogSource`'s own comment.
    source: changeLogSource("source").notNull().default("manual_edit"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
  },
  (table) => [
    index("change_log_action_group_id_idx").on(table.actionGroupId),
    index("change_log_target_idx").on(table.targetTable, table.targetId),
  ],
);

/**
 * The chat transcript shown in the app. `content` is jsonb so tool calls
 * and tool results can be stored structurally, not just plain text.
 */
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    role: chatMessageRole("role").notNull(),
    content: jsonb("content").notNull(),
    entryId: uuid("entry_id").references(() => entries.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("chat_messages_entry_id_idx").on(table.entryId)],
);

/**
 * Per-model-call audit log for the agent turn (T06). One row per Claude
 * API request made while handling a turn — a single turn can make
 * several, one per tool-loop iteration (see `agent/run-turn.ts`). This
 * is what makes acceptance criterion 4 ("nothing about the owner enters
 * a prompt unless related") auditable: `requestJson` holds exactly what
 * was sent.
 */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Groups every model call made while handling one turn, and doubles
    // as `changeLog.actionGroupId` for that turn's mutations (see
    // `memory/service.ts`), so a run and the change it caused are
    // linked by the same id.
    turnId: uuid("turn_id").notNull(),
    // The exact request sent: system text, the message list (roles and
    // content, not reserializing SDK-internal fields), and the tool
    // names offered. Never includes the API key.
    requestJson: jsonb("request_json").notNull(),
    stopReason: text("stop_reason"),
    // { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens }
    usage: jsonb("usage"),
    // Estimated from `usage` and the pricing in `agent/pricing.ts`; null
    // when usage itself is unavailable (e.g. the call errored).
    estimatedCostUsd: text("estimated_cost_usd"),
    latencyMillis: integer("latency_millis").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("agent_runs_turn_id_idx").on(table.turnId)],
);

/**
 * One row per calendar date, holding the diary summary built by the
 * nightly consolidation job (T08).
 */
export const dailyRollups = pgTable(
  "daily_rollups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rollupDate: date("rollup_date").notNull(),
    summary: text("summary").notNull(),
    // The entries (raw log) this rollup's summary was built from, so the
    // diary can cite its sources. Empty for a rollup generated before
    // this column existed (none, in practice: days with no content never
    // get a row at all — see `rollup/rollup.ts`).
    sourceEntryIds: uuid("source_entry_ids").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("daily_rollups_rollup_date_unique_idx").on(table.rollupDate)],
);
