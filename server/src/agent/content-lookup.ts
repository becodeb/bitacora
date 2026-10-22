/**
 * Loads the display text for one hybrid-search hit, by scope. Shared by
 * `tools.ts` (the `search` tool's results) and `run-turn.ts` (the
 * pre-search hints), so both render hits the same way.
 */
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { memories, topics } from "../db/schema.js";
import type { HybridSearchHit } from "../search/types.js";

export async function fetchHitText(db: NodePgDatabase, hit: HybridSearchHit): Promise<string> {
  if (hit.scope === "memories") {
    const [row] = await db
      .select({ content: memories.content })
      .from(memories)
      .where(sql`${memories.id} = ${hit.id}`);
    return row?.content ?? "(content unavailable)";
  }
  if (hit.scope === "topics") {
    const [row] = await db
      .select({ name: topics.name })
      .from(topics)
      .where(sql`${topics.id} = ${hit.id}`);
    return row?.name ?? "(content unavailable)";
  }
  // entries: text_body + derived_text, same join used by jobs/embed.ts.
  const result = await db.execute(
    sql`select coalesce(text_body, '') || ' ' || coalesce(derived_text, '') as text from entries where id = ${hit.id}`,
  );
  const row = result.rows[0] as { text: string } | undefined;
  return row?.text.trim() || "(content unavailable)";
}
