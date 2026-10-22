/**
 * Loads the display text for one hybrid-search hit, by scope. Shared by
 * `tools.ts` (the `search` tool's results) and `run-turn.ts` (the
 * pre-search hints), so both render hits the same way AND both get the
 * same truncation — an entry's OCR/transcript text has no length limit
 * of its own, so without a cap here one long hit could blow past the
 * whole turn's token budget (see `token-budget.ts`) by itself.
 */
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { memories, topics } from "../db/schema.js";
import type { HybridSearchHit } from "../search/types.js";

/** Per-hit character cap (see the module comment above). Chosen to comfortably fit several hits plus the rest of a turn's prompt well inside the token budget, not to fit one hit's full content. */
export const HIT_TEXT_MAX_CHARS = 1_500;
const TRUNCATION_MARKER = " [truncated]";

/**
 * Truncates `text` so the RESULT (marker included) never exceeds
 * `maxChars` — a true ceiling, not a content-only cap the marker then
 * overshoots. Callers that reserve room for a suffix appended after
 * truncation (e.g. `tools.ts`'s omitted-count note) can therefore rely
 * on `maxChars` as an exact budget. `maxChars` below the marker's own
 * length degrades to an empty/partial marker rather than growing past
 * it — there is no shorter faithful truncation to fall back to.
 */
export function truncateText(text: string, maxChars: number = HIT_TEXT_MAX_CHARS): string {
  if (text.length <= maxChars) {
    return text;
  }
  const sliceLength = Math.max(0, maxChars - TRUNCATION_MARKER.length);
  return `${text.slice(0, sliceLength)}${TRUNCATION_MARKER}`.slice(0, maxChars);
}

export async function fetchHitText(db: NodePgDatabase, hit: HybridSearchHit): Promise<string> {
  if (hit.scope === "memories") {
    const [row] = await db
      .select({ content: memories.content })
      .from(memories)
      .where(sql`${memories.id} = ${hit.id}`);
    return truncateText(row?.content ?? "(content unavailable)");
  }
  if (hit.scope === "topics") {
    const [row] = await db
      .select({ name: topics.name })
      .from(topics)
      .where(sql`${topics.id} = ${hit.id}`);
    return truncateText(row?.name ?? "(content unavailable)");
  }
  // entries: text_body + derived_text, same join used by jobs/embed.ts.
  const result = await db.execute(
    sql`select coalesce(text_body, '') || ' ' || coalesce(derived_text, '') as text from entries where id = ${hit.id}`,
  );
  const row = result.rows[0] as { text: string } | undefined;
  return truncateText(row?.text.trim() || "(content unavailable)");
}
