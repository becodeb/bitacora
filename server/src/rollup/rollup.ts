/**
 * T08's daily rollup: gathers one Buenos-Aires-local day's entries and
 * chat text, asks the summarizer (`claude-rollup.ts` in production) for
 * a short Rioplatense Spanish diary summary, and upserts `daily_rollups`
 * (unique per date — see `db/schema.ts`). A day with no content gets no
 * row and no model call at all, matching `odd/tasks/mvp.md`'s T08 spec.
 */
import { randomUUID } from "node:crypto";
import { and, eq, gte, lt } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { estimateCostUsd } from "../agent/pricing.js";
import { estimateTokensForText } from "../agent/token-budget.js";
import type { AgentContentBlock } from "../agent/types.js";
import { agentRuns, chatMessages, dailyRollups, entries } from "../db/schema.js";
import { DAILY_ROLLUP_LOCK_KEY } from "../jobs/lock-keys.js";
import { runWithAdvisoryLock } from "../lib/advisory-lock.js";
import {
  buenosAiresDayRangeUtc,
  isValidDateLabel,
  yesterdayDateLabel,
} from "../lib/buenos-aires-date.js";
import type { RollupSummarizer } from "./types.js";

/**
 * Upper bound on the day's content handed to the summarizer, in the
 * same conservative char-based estimate `agent/token-budget.ts` uses for
 * the chat agent's own budget — reused here rather than reimplemented,
 * per T08's instructions. Generous for a diary summary (most days are
 * far smaller) but bounds the rare very-busy day.
 */
const ROLLUP_MAX_CONTENT_TOKENS = 15_000;
const TRUNCATION_MARKER =
  "\n[... contenido truncado: se muestra una selección parcial de un día con mucho contenido ...]\n";

export interface RollupDeps {
  db: NodePgDatabase;
  /** Used only to take the run-level advisory lock below (see `lib/advisory-lock.ts`) — never for ordinary queries, which go through `db`. */
  pool: Pool;
  summarizer: RollupSummarizer;
}

export interface RunDailyRollupParams {
  /** Buenos-Aires-local `YYYY-MM-DD`. Defaults to yesterday — the nightly schedule's own use (see `jobs/daily-rollup-job.ts`); the admin trigger (`http/admin-jobs.ts`) passes an explicit date for backfill. */
  date?: string;
}

export type RunDailyRollupStatus =
  | "created"
  | "updated"
  | "skipped_no_content"
  | "skipped_refusal"
  | "skipped_error"
  | "already_running";

export interface RunDailyRollupResult {
  dateLabel: string;
  status: RunDailyRollupStatus;
  rollupId?: string;
  sourceEntryCount: number;
  truncated: boolean;
}

interface TimedItem {
  createdAt: Date;
  /** Present for an item that cites a specific raw-log entry (an owner-authored entry, or a chat message tied to one); absent for e.g. an assistant-only message. */
  sourceEntryId?: string;
  text: string;
}

function entryText(row: { textBody: string | null; derivedText: string | null }): string {
  return [row.textBody, row.derivedText]
    .filter((part): part is string => Boolean(part && part.length > 0))
    .join(" ")
    .trim();
}

function chatMessageText(content: unknown): string {
  const blocks = content as AgentContentBlock[];
  return blocks
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join(" ")
    .trim();
}

/**
 * Gathers the day's entries (`text_body`/`derived_text`, per `kind`) and
 * chat messages (user + assistant text only — `role: "tool"` rows, the
 * tool-result halves of an agent turn, are deliberately excluded: they
 * are not something the owner said or was told, just plumbing). Returns
 * `null` when there is nothing at all, so the caller can skip the day
 * without any model call.
 */
async function gatherDayContent(
  db: NodePgDatabase,
  dateLabel: string,
): Promise<{ sourceEntryIds: string[]; content: string; truncated: boolean } | null> {
  const { start, end } = buenosAiresDayRangeUtc(dateLabel);

  const entryRows = await db
    .select({
      id: entries.id,
      kind: entries.kind,
      textBody: entries.textBody,
      derivedText: entries.derivedText,
      createdAt: entries.createdAt,
    })
    .from(entries)
    .where(and(gte(entries.createdAt, start), lt(entries.createdAt, end)));

  const messageRows = await db
    .select({
      role: chatMessages.role,
      content: chatMessages.content,
      entryId: chatMessages.entryId,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(and(gte(chatMessages.createdAt, start), lt(chatMessages.createdAt, end)));

  const items: TimedItem[] = [];
  const sourceEntryIdSet = new Set<string>();

  for (const row of entryRows) {
    const text = entryText(row);
    if (text.length === 0) continue;
    sourceEntryIdSet.add(row.id);
    items.push({ createdAt: row.createdAt, sourceEntryId: row.id, text: `[${row.kind}] ${text}` });
  }

  for (const row of messageRows) {
    if (row.role !== "user" && row.role !== "assistant") continue;
    const text = chatMessageText(row.content);
    if (text.length === 0) continue;
    if (row.entryId) sourceEntryIdSet.add(row.entryId);
    items.push({
      createdAt: row.createdAt,
      sourceEntryId: row.entryId ?? undefined,
      text: `[${row.role === "user" ? "dueño" : "bitacora"}] ${text}`,
    });
  }

  if (items.length === 0) {
    return null;
  }

  items.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  let tokens = 0;
  const kept: string[] = [];
  let truncated = false;
  for (const item of items) {
    const itemTokens = estimateTokensForText(item.text);
    if (tokens + itemTokens > ROLLUP_MAX_CONTENT_TOKENS) {
      truncated = true;
      break;
    }
    tokens += itemTokens;
    kept.push(item.text);
  }

  const content = truncated ? kept.join("\n") + TRUNCATION_MARKER : kept.join("\n");
  return { sourceEntryIds: [...sourceEntryIdSet], content, truncated };
}

/** Maps a summarizer `outcome` to the `agent_runs.stopReason` it is logged under — `"error"` covers both a thrown API call and an unusable response, so it is never confused with a genuine `"end_turn"` completion (see `types.ts`'s own doc comment on `RollupSummarizeResult.outcome`). */
function stopReasonFor(outcome: "ok" | "refusal" | "error"): string {
  return outcome === "ok" ? "end_turn" : outcome;
}

async function runDailyRollupUnlocked(
  deps: RollupDeps,
  dateLabel: string,
): Promise<RunDailyRollupResult> {
  const gathered = await gatherDayContent(deps.db, dateLabel);
  if (!gathered) {
    return { dateLabel, status: "skipped_no_content", sourceEntryCount: 0, truncated: false };
  }

  const [existing] = await deps.db
    .select({ id: dailyRollups.id })
    .from(dailyRollups)
    .where(eq(dailyRollups.rollupDate, dateLabel));

  // Doubles as this run's `agent_runs.turnId` — matching `agent/run-turn.ts`'s
  // own convention of using one id for both the model-call log and the
  // (here: none, the rollup writes no change_log rows) mutation group.
  const runId = randomUUID();
  const startedAt = Date.now();
  const result = await deps.summarizer.summarize({ dateLabel, content: gathered.content });
  const latencyMillis = Date.now() - startedAt;

  await deps.db.insert(agentRuns).values({
    turnId: runId,
    requestJson: result.requestJson,
    stopReason: stopReasonFor(result.outcome),
    usage: result.usage,
    estimatedCostUsd: estimateCostUsd(result.usage).toFixed(6),
    latencyMillis,
  });

  if (result.outcome !== "ok" || !result.summary) {
    return {
      dateLabel,
      status: result.outcome === "refusal" ? "skipped_refusal" : "skipped_error",
      sourceEntryCount: gathered.sourceEntryIds.length,
      truncated: gathered.truncated,
    };
  }

  await deps.db
    .insert(dailyRollups)
    .values({
      rollupDate: dateLabel,
      summary: result.summary,
      sourceEntryIds: gathered.sourceEntryIds,
    })
    .onConflictDoUpdate({
      target: dailyRollups.rollupDate,
      set: {
        summary: result.summary,
        sourceEntryIds: gathered.sourceEntryIds,
        updatedAt: new Date(),
      },
    });

  const [row] = await deps.db
    .select({ id: dailyRollups.id })
    .from(dailyRollups)
    .where(eq(dailyRollups.rollupDate, dateLabel));

  return {
    dateLabel,
    status: existing ? "updated" : "created",
    rollupId: row?.id,
    sourceEntryCount: gathered.sourceEntryIds.length,
    truncated: gathered.truncated,
  };
}

/**
 * Runs (or re-runs) the daily rollup for one Buenos-Aires-local date.
 * Idempotent: re-running the same date with the same underlying content
 * upserts the existing row (`daily_rollups.rollup_date` is unique) and
 * does not create a duplicate. Logs the summarizer call into
 * `agent_runs` even on a skipped-by-refusal or skipped-by-error day, so
 * the cost/attempt is still visible — but never on a skipped-no-content
 * day, which makes no model call at all.
 *
 * Guarded by a run-level Postgres advisory lock (`DAILY_ROLLUP_LOCK_KEY`
 * — see `lib/advisory-lock.ts`): if the 04:00 schedule fires while an
 * admin backfill (or another concurrent trigger) is already running
 * this job, the second caller returns `"already_running"` immediately
 * rather than doing the (cheap, but non-zero) model call twice.
 */
export async function runDailyRollup(
  deps: RollupDeps,
  params: RunDailyRollupParams = {},
): Promise<RunDailyRollupResult> {
  const dateLabel = params.date ?? yesterdayDateLabel();
  if (!isValidDateLabel(dateLabel)) {
    throw new Error(`invalid date for daily rollup: ${dateLabel}`);
  }

  const locked = await runWithAdvisoryLock(deps.pool, DAILY_ROLLUP_LOCK_KEY, () =>
    runDailyRollupUnlocked(deps, dateLabel),
  );
  if (!locked.ran) {
    return { dateLabel, status: "already_running", sourceEntryCount: 0, truncated: false };
  }
  return locked.result;
}
