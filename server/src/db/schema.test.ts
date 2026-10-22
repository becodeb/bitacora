import { sql, TransactionRollbackError } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import {
  attachments,
  changeLog,
  chatMessages,
  dailyRollups,
  entries,
  memories,
  rules,
  topics,
} from "./schema.js";

// Mirrors compose.dev.yml's credentials and the host port chosen there.
// Override with DATABASE_URL for a dev DB running elsewhere.
const DEV_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://bitacora:bitacora@localhost:55432/bitacora";

const db = createDb(DEV_DATABASE_URL);

afterAll(async () => {
  await db.pool.end();
});

/**
 * Runs `fn` inside a transaction that is always rolled back, so the test
 * never leaves rows behind for other tests (or other test runs) to trip
 * over. `tx.rollback()` issues `ROLLBACK` to the database, then throws a
 * `TransactionRollbackError` to unwind the transaction callback; that
 * throw is expected here and swallowed, since it signals a successful,
 * deliberate rollback rather than a test failure.
 */
async function withRollback(fn: (tx: typeof db.orm) => Promise<void>): Promise<void> {
  try {
    await db.orm.transaction(async (tx) => {
      await fn(tx as unknown as typeof db.orm);
      tx.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) {
      throw error;
    }
  }
}

describe("migrations", () => {
  it("enable the vector and pg_trgm extensions", async () => {
    const result = await db.pool.query<{ extname: string }>(
      "select extname from pg_extension where extname in ('vector', 'pg_trgm') order by extname",
    );

    expect(result.rows.map((row) => row.extname)).toEqual(["pg_trgm", "vector"]);
  });
});

describe("core tables", () => {
  it("inserts a topic, an entry and an attachment, and links them", async () => {
    await withRollback(async (tx) => {
      const [topic] = await tx
        .insert(topics)
        .values({ name: "University", description: "Coursework and exams" })
        .returning();
      if (!topic) throw new Error("insert did not return a row");

      const [entry] = await tx
        .insert(entries)
        .values({
          kind: "photo",
          textBody: "Sistemas: exam on Monday. Mecánica: exam on Tuesday.",
        })
        .returning();
      if (!entry) throw new Error("insert did not return a row");

      const [attachment] = await tx
        .insert(attachments)
        .values({
          entryId: entry.id,
          storageKey: "entries/1/photo.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 1024,
          sha256: "a".repeat(64),
        })
        .returning();
      if (!attachment) throw new Error("insert did not return a row");

      const [memory] = await tx
        .insert(memories)
        .values({
          content: "The owner studies Sistemas.",
          topicId: topic.id,
          sourceEntryId: entry.id,
        })
        .returning();

      expect(attachment.entryId).toBe(entry.id);
      expect(attachment.derivedTextStatus).toBe("pending");
      expect(memory?.topicId).toBe(topic.id);
      expect(memory?.sourceEntryId).toBe(entry.id);
      expect(memory?.validTo).toBeNull();
    });
  });

  it("enforces case-insensitive uniqueness on topic names", async () => {
    await withRollback(async (tx) => {
      await tx.insert(topics).values({ name: "Work" });

      await expect(tx.insert(topics).values({ name: "work" })).rejects.toThrow();
    });
  });

  it("restricts deleting an entry that a memory still points at", async () => {
    await withRollback(async (tx) => {
      const [entry] = await tx
        .insert(entries)
        .values({ kind: "text", textBody: "Buy milk." })
        .returning();
      if (!entry) throw new Error("insert did not return a row");

      await tx.insert(memories).values({
        content: "Buy milk.",
        sourceEntryId: entry.id,
      });

      await expect(tx.delete(entries).where(sql`${entries.id} = ${entry.id}`)).rejects.toThrow();
    });
  });

  it("cascades deleting an entry to its attachments", async () => {
    await withRollback(async (tx) => {
      const [entry] = await tx
        .insert(entries)
        .values({ kind: "photo", textBody: "A screenshot." })
        .returning();
      if (!entry) throw new Error("insert did not return a row");

      const [attachment] = await tx
        .insert(attachments)
        .values({
          entryId: entry.id,
          storageKey: "entries/2/photo.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 2048,
          sha256: "b".repeat(64),
        })
        .returning();
      if (!attachment) throw new Error("insert did not return a row");

      await tx.delete(entries).where(sql`${entries.id} = ${entry.id}`);

      const remaining = await tx
        .select()
        .from(attachments)
        .where(sql`${attachments.id} = ${attachment.id}`);

      expect(remaining).toHaveLength(0);
    });
  });

  it("round-trips a rule, a change-log row, a chat message and a daily rollup", async () => {
    await withRollback(async (tx) => {
      const [topic] = await tx.insert(topics).values({ name: "Reminders" }).returning();
      if (!topic) throw new Error("insert did not return a row");

      const [rule] = await tx
        .insert(rules)
        .values({
          key: "calendar-event-title-format",
          kind: "calendar-format",
          payload: { template: "{{subject}} — {{title}}" },
          topicId: topic.id,
        })
        .returning();
      expect(rule?.active).toBe(true);

      const [entry] = await tx
        .insert(entries)
        .values({ kind: "text", textBody: "Remind me about the exam." })
        .returning();
      if (!entry) throw new Error("insert did not return a row");

      const [logRow] = await tx
        .insert(changeLog)
        .values({
          actionGroupId: crypto.randomUUID(),
          targetTable: "entries",
          targetId: entry.id,
          operation: "insert",
          after: { kind: "text" },
        })
        .returning();
      expect(logRow?.undoneAt).toBeNull();

      const [message] = await tx
        .insert(chatMessages)
        .values({ role: "user", content: { text: "Remind me about the exam." }, entryId: entry.id })
        .returning();
      expect(message?.role).toBe("user");

      const [rollup] = await tx
        .insert(dailyRollups)
        .values({ rollupDate: "2026-10-22", summary: "Logged one reminder." })
        .returning();
      expect(rollup?.rollupDate).toBe("2026-10-22");
    });
  });
});

describe("memory supersede chain", () => {
  it("links a new memory to the one it supersedes and closes the old one's validity window", async () => {
    await withRollback(async (tx) => {
      const [entry] = await tx
        .insert(entries)
        .values({ kind: "text", textBody: "That photo was from Análisis." })
        .returning();
      if (!entry) throw new Error("insert did not return a row");

      const [original] = await tx
        .insert(memories)
        .values({ content: "The photo was from Mecánica.", sourceEntryId: entry.id })
        .returning();
      if (!original) throw new Error("insert did not return a row");

      const [correction] = await tx
        .insert(memories)
        .values({
          content: "The photo was from Análisis.",
          sourceEntryId: entry.id,
          supersedesId: original.id,
        })
        .returning();
      if (!correction) throw new Error("insert did not return a row");

      const [closedOriginal] = await tx
        .update(memories)
        .set({ validTo: new Date() })
        .where(sql`${memories.id} = ${original.id}`)
        .returning();

      expect(correction.supersedesId).toBe(original.id);
      expect(closedOriginal?.validTo).not.toBeNull();
      expect(correction.validTo).toBeNull();
    });
  });
});

describe("Spanish full-text search", () => {
  it("matches the singular query form against plural text via Spanish stemming", async () => {
    await withRollback(async (tx) => {
      await tx.insert(entries).values({ kind: "text", textBody: "Tengo varios gatos en casa." });

      const matches = await tx.execute(
        sql`select 1 from ${entries} where ${entries.searchVector} @@ to_tsquery('spanish', 'gato')`,
      );

      expect(matches.rows.length).toBeGreaterThan(0);
    });
  });

  it("does not match an unrelated query", async () => {
    await withRollback(async (tx) => {
      await tx.insert(entries).values({ kind: "text", textBody: "Tengo varios gatos en casa." });

      const matches = await tx.execute(
        sql`select 1 from ${entries} where ${entries.searchVector} @@ to_tsquery('spanish', 'perro')`,
      );

      expect(matches.rows.length).toBe(0);
    });
  });
});

describe("trigram similarity", () => {
  it("finds a close match for a misspelled query", async () => {
    await withRollback(async (tx) => {
      await tx.insert(entries).values({ kind: "text", textBody: "Examen de sistemas el lunes." });

      const matches = await tx.execute(
        sql`select 1 from ${entries} where ${entries.textBody} % 'exmen de sistemas'`,
      );

      expect(matches.rows.length).toBeGreaterThan(0);
    });
  });
});
