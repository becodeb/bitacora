/**
 * Append-only persistence for the chat transcript (`chat_messages`),
 * and loading recent history back into `AgentMessage[]` for the next
 * turn's request. Each role/content pair below is its own row —
 * written as the turn progresses, not batched at the end — so a crash
 * mid-turn still leaves a correctly-replayable partial transcript.
 *
 * **Decision: `thinking`/`redacted_thinking` blocks are kept, not
 * stripped, across turns.** Anthropic requires replaying earlier
 * `thinking` blocks byte-for-byte (`signature` intact) when a model
 * with preserved thinking re-reads them; a modified or dropped-then-
 * reinstated block, or one replayed with a different `system`/`tools`
 * prefix than it was produced with, fails with a 400. This is judged
 * safe here because every condition that guidance calls out is already
 * true of this agent's history path:
 * - Rows are stored as the API returned them (`persistChatMessage`
 *   writes `AgentContentBlock[]` straight from `claude-client.ts`'s
 *   `fromAnthropicContent`, no reserialization through a different
 *   shape) and read back the same way — a jsonb round trip changes
 *   whitespace/key order, never the string values this check compares.
 * - `token-budget.ts`'s `fitHistoryToBudget` only ever drops whole
 *   exchanges from the FRONT (oldest first) — a contiguous run, never
 *   the middle — which is exactly the one trimming shape Anthropic's
 *   own guidance accepts as compatible with preserved thinking.
 * - The system prompt (`prompt.ts`'s `buildSystemPrompt`) and the tool
 *   list (`tools.ts`'s `AGENT_TOOLS`) are both static for this agent —
 *   neither changes between turns — so the prefix a kept block was
 *   produced against never silently changes underneath it.
 * If any of those three stop holding (e.g. a per-turn system-prompt
 * reminder, or a tool list that changes when calendar tools land in
 * T12), re-derive this decision rather than assuming it still applies:
 * the alternative is to strip `thinking`/`redacted_thinking` from
 * `chat_messages` rows older than the current turn when loading history
 * (not when storing — storage stays byte-for-byte either way).
 * `claude-haiku-5-5` is not on the preserved-thinking-enforced model
 * list as of 2026-10-22, so none of this is enforced today either way;
 * it is written for when/if that changes.
 */
import { desc, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { chatMessages } from "../db/schema.js";
import type { AgentContentBlock, AgentMessage, AgentRole } from "./types.js";

/** How many most-recent `chat_messages` rows are loaded as history, before the token budget (`token-budget.ts`) trims further. A hard cap so a very long-lived conversation never queries unbounded rows. */
const HISTORY_ROW_LIMIT = 50;

export async function persistChatMessage(
  db: NodePgDatabase,
  message: { role: AgentRole | "tool"; content: AgentContentBlock[]; entryId?: string },
): Promise<void> {
  await db.insert(chatMessages).values({
    role: message.role,
    content: message.content,
    entryId: message.entryId ?? null,
  });
}

/**
 * Loads the most recent `HISTORY_ROW_LIMIT` messages, oldest first, as
 * `AgentMessage[]`. A `role: "tool"` row (the tool-result half of a
 * loop iteration) is folded into `role: "user"` for the API request —
 * Anthropic's `tool_result` blocks are sent as part of a `user` turn —
 * while still being stored with its own distinct role for the chat UI
 * (T10) to render differently from a plain user message.
 */
export async function loadRecentHistory(
  db: NodePgDatabase,
  limit: number = HISTORY_ROW_LIMIT,
): Promise<AgentMessage[]> {
  const rows = await db
    .select({ role: chatMessages.role, content: chatMessages.content })
    .from(chatMessages)
    .orderBy(desc(chatMessages.createdAt))
    .limit(limit);

  return rows.reverse().map((row) => ({
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content as AgentContentBlock[],
  }));
}

/**
 * Full chat history rows for `GET /v1/chat/history`: unlike
 * `loadRecentHistory` (which folds `"tool"` into `"user"` for the API
 * request shape), this keeps `id`/`createdAt`/the original role, for
 * the chat UI (T10) to render.
 */
export async function listChatHistory(db: NodePgDatabase, limit: number = HISTORY_ROW_LIMIT) {
  const rows = await db
    .select({
      id: chatMessages.id,
      role: chatMessages.role,
      content: chatMessages.content,
      entryId: chatMessages.entryId,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .orderBy(desc(chatMessages.createdAt))
    .limit(limit);
  return rows.reverse();
}

/** Just enough of `entries`/`attachments` to resolve a chat message's full text — see `resolveMessageText`. */
export interface EntryTextState {
  textBody: string | null;
  derivedText: string | null;
  derivationStatus: "none" | "pending" | "done" | "failed" | "not_available";
}

async function loadEntryTextState(
  db: NodePgDatabase,
  entryId: string,
): Promise<EntryTextState | null> {
  const result = await db.execute(sql`
    select
      e.text_body as "textBody",
      e.derived_text as "derivedText",
      a.derived_text_status as "attachmentStatus"
    from entries e
    left join attachments a on a.entry_id = e.id
    where e.id = ${entryId}
  `);
  const row = result.rows[0] as
    | { textBody: string | null; derivedText: string | null; attachmentStatus: string | null }
    | undefined;
  if (!row) return null;

  return {
    textBody: row.textBody,
    derivedText: row.derivedText,
    derivationStatus: (row.attachmentStatus as EntryTextState["derivationStatus"] | null) ?? "none",
  };
}

const DEFAULT_DERIVATION_WAIT_MILLIS = 60_000;
const POLL_INTERVAL_MILLIS = 1_000;

export interface ResolvedMessageText {
  text: string;
  /** True when a photo/voice entry's OCR/transcript was still pending after the bounded wait. */
  derivationPending: boolean;
}

/**
 * Resolves the full text for a chat turn's entry: for a `kind: "text"`
 * entry this is immediate (no attachment to derive anything from); for
 * a photo/voice entry, polls up to `maxWaitMillis` (default 60s) for
 * its OCR/transcript to finish, then proceeds with whatever is
 * available — never blocks the turn indefinitely on a slow or stuck
 * derivation job.
 */
export async function resolveMessageText(
  db: NodePgDatabase,
  entryId: string,
  maxWaitMillis: number = DEFAULT_DERIVATION_WAIT_MILLIS,
): Promise<ResolvedMessageText> {
  const deadline = Date.now() + maxWaitMillis;

  for (;;) {
    const state = await loadEntryTextState(db, entryId);
    if (!state) {
      return { text: "", derivationPending: false };
    }

    const stillPending = state.derivationStatus === "pending" && state.derivedText === null;
    if (!stillPending || Date.now() >= deadline) {
      const text = [state.textBody, state.derivedText]
        .filter((part) => part && part.length > 0)
        .join(" ");
      return { text, derivationPending: stillPending };
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MILLIS));
  }
}
