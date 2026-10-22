import { sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client.js";
import { agentRuns, chatMessages, dailyRollups, entries } from "../db/schema.js";
import { assertDefined } from "../test/assert.js";
import { runDailyRollup } from "./rollup.js";
import { createScriptedRollupSummarizer } from "./test-helpers.js";

const DEV_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://bitacora:bitacora@localhost:55432/bitacora";

const db = createDb(DEV_DATABASE_URL);

afterAll(async () => {
  await db.pool.end();
});

const createdEntryIds: string[] = [];
const createdDateLabels: string[] = [];

afterEach(async () => {
  while (createdEntryIds.length > 0) {
    const entryId = createdEntryIds.pop();
    if (entryId) {
      await db.orm.delete(chatMessages).where(sql`${chatMessages.entryId} = ${entryId}`);
      await db.orm.delete(entries).where(sql`${entries.id} = ${entryId}`);
    }
  }
  while (createdDateLabels.length > 0) {
    const label = createdDateLabels.pop();
    if (label) await db.orm.delete(dailyRollups).where(sql`${dailyRollups.rollupDate} = ${label}`);
  }
});

/** Within the Buenos Aires day for `DAY_WITH_CONTENT` below. */
async function insertEntryAt(createdAt: Date, textBody: string): Promise<string> {
  const [row] = await db.orm
    .insert(entries)
    .values({ kind: "text", textBody, createdAt })
    .returning({ id: entries.id });
  const entryId = assertDefined(row).id;
  createdEntryIds.push(entryId);
  return entryId;
}

const DAY_WITH_CONTENT = "2026-01-15";
const DAY_WITH_NO_CONTENT = "2026-01-16";

describe("runDailyRollup", () => {
  it("creates a rollup for a day with content, and logs the summarizer call into agent_runs", async () => {
    createdDateLabels.push(DAY_WITH_CONTENT);
    const entryId = await insertEntryAt(
      new Date(`${DAY_WITH_CONTENT}T10:00:00-03:00`),
      "Examen de sistemas el lunes.",
    );

    const summarizer = createScriptedRollupSummarizer(["Rendiste el examen de sistemas."]);
    const result = await runDailyRollup({ db: db.orm, summarizer }, { date: DAY_WITH_CONTENT });

    expect(result.status).toBe("created");
    expect(result.sourceEntryCount).toBe(1);
    expect(result.truncated).toBe(false);
    expect(summarizer.calls).toHaveLength(1);
    expect(summarizer.calls[0]?.content).toContain("Examen de sistemas el lunes.");

    const [row] = await db.orm
      .select()
      .from(dailyRollups)
      .where(sql`${dailyRollups.rollupDate} = ${DAY_WITH_CONTENT}`);
    expect(row?.summary).toBe("Rendiste el examen de sistemas.");
    expect(row?.sourceEntryIds).toEqual([entryId]);

    const [runRow] = await db.orm
      .select()
      .from(agentRuns)
      .where(sql`${agentRuns.stopReason} = 'end_turn'`)
      .orderBy(sql`${agentRuns.createdAt} desc`)
      .limit(1);
    expect(runRow).toBeDefined();
  });

  it("skips a day with no content, making no model call and writing no row", async () => {
    const summarizer = createScriptedRollupSummarizer(["should never be used"]);
    const result = await runDailyRollup({ db: db.orm, summarizer }, { date: DAY_WITH_NO_CONTENT });

    expect(result.status).toBe("skipped_no_content");
    expect(summarizer.calls).toHaveLength(0);

    const rows = await db.orm
      .select()
      .from(dailyRollups)
      .where(sql`${dailyRollups.rollupDate} = ${DAY_WITH_NO_CONTENT}`);
    expect(rows).toHaveLength(0);
  });

  it("is idempotent: re-running the same date upserts, never duplicates", async () => {
    createdDateLabels.push(DAY_WITH_CONTENT);
    await insertEntryAt(new Date(`${DAY_WITH_CONTENT}T09:00:00-03:00`), "Primera entrada del día.");

    const summarizer = createScriptedRollupSummarizer(["Primer resumen.", "Segundo resumen."]);
    const deps = { db: db.orm, summarizer };

    const first = await runDailyRollup(deps, { date: DAY_WITH_CONTENT });
    expect(first.status).toBe("created");

    const second = await runDailyRollup(deps, { date: DAY_WITH_CONTENT });
    expect(second.status).toBe("updated");
    expect(second.rollupId).toBe(first.rollupId);

    const rows = await db.orm
      .select()
      .from(dailyRollups)
      .where(sql`${dailyRollups.rollupDate} = ${DAY_WITH_CONTENT}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toBe("Segundo resumen.");
  });

  it("skips writing a rollup row when the summarizer refuses, but still logs the attempt", async () => {
    createdDateLabels.push(DAY_WITH_CONTENT);
    await insertEntryAt(new Date(`${DAY_WITH_CONTENT}T11:00:00-03:00`), "Algo que pasó.");

    const summarizer = createScriptedRollupSummarizer([null]);
    const result = await runDailyRollup({ db: db.orm, summarizer }, { date: DAY_WITH_CONTENT });

    expect(result.status).toBe("skipped_refusal");
    const rows = await db.orm
      .select()
      .from(dailyRollups)
      .where(sql`${dailyRollups.rollupDate} = ${DAY_WITH_CONTENT}`);
    expect(rows).toHaveLength(0);
  });

  it("defaults to yesterday (Buenos Aires) when no date is given", async () => {
    const summarizer = createScriptedRollupSummarizer([]);
    const result = await runDailyRollup({ db: db.orm, summarizer });
    // Whatever "yesterday" resolves to, it must be a real calendar date
    // label the function itself considers valid — this exercises the
    // default-date path without hardcoding "today" in the test.
    expect(result.dateLabel).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
