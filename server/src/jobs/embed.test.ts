import { sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../db/client.js";
import { entries, memories, topics } from "../db/schema.js";
import { createFakeEmbedder } from "../embeddings/test-helpers.js";
import type { Embedder } from "../embeddings/types.js";
import { type EmbedDeps, processEmbedJob } from "./embed.js";

const DEV_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://bitacora:bitacora@localhost:55432/bitacora";

const db = createDb(DEV_DATABASE_URL);

afterAll(async () => {
  await db.pool.end();
});

const createdEntryIds: string[] = [];
const createdTopicIds: string[] = [];

afterEach(async () => {
  while (createdEntryIds.length > 0) {
    const entryId = createdEntryIds.pop();
    if (entryId) {
      // Memories `restrict` their source entry (see `db/schema.ts`), so
      // any memory pointing at this entry must go first.
      await db.orm.delete(memories).where(sql`${memories.sourceEntryId} = ${entryId}`);
      await db.orm.delete(entries).where(sql`${entries.id} = ${entryId}`);
    }
  }
  while (createdTopicIds.length > 0) {
    const topicId = createdTopicIds.pop();
    if (topicId) await db.orm.delete(topics).where(sql`${topics.id} = ${topicId}`);
  }
});

describe("processEmbedJob: entries", () => {
  it("writes a 1024-dimension embedding built from text_body + derived_text", async () => {
    const [entry] = await db.orm
      .insert(entries)
      .values({ kind: "text", textBody: "Examen de sistemas el lunes." })
      .returning({ id: entries.id });
    if (!entry) throw new Error("insert did not return a row");
    createdEntryIds.push(entry.id);

    const deps: EmbedDeps = { db: db.orm, embedder: createFakeEmbedder() };
    await processEmbedJob(deps, { targetTable: "entries", targetId: entry.id });

    const [row] = await db.orm.select().from(entries).where(sql`${entries.id} = ${entry.id}`);
    expect(row?.embedding).not.toBeNull();
    expect(row?.embedding).toHaveLength(1024);
  });

  it("never overwrites an entry's embedding once set", async () => {
    const [entry] = await db.orm
      .insert(entries)
      .values({ kind: "text", textBody: "Original text." })
      .returning({ id: entries.id });
    if (!entry) throw new Error("insert did not return a row");
    createdEntryIds.push(entry.id);

    const deps: EmbedDeps = { db: db.orm, embedder: createFakeEmbedder() };
    await processEmbedJob(deps, { targetTable: "entries", targetId: entry.id });
    const [first] = await db.orm.select().from(entries).where(sql`${entries.id} = ${entry.id}`);

    // A second attempt must be a no-op even if the row's text changed in the meantime.
    await db.orm
      .update(entries)
      .set({ derivedText: "A transcript that arrived later." })
      .where(sql`${entries.id} = ${entry.id}`);
    await processEmbedJob(deps, { targetTable: "entries", targetId: entry.id });

    const [second] = await db.orm.select().from(entries).where(sql`${entries.id} = ${entry.id}`);
    expect(second?.embedding).toEqual(first?.embedding);
  });

  it("skips embedding (and never calls the embedder) when there is no text yet", async () => {
    const [entry] = await db.orm
      .insert(entries)
      .values({ kind: "photo" })
      .returning({ id: entries.id });
    if (!entry) throw new Error("insert did not return a row");
    createdEntryIds.push(entry.id);

    const embed = vi.fn();
    const deps: EmbedDeps = { db: db.orm, embedder: { embed } };
    await processEmbedJob(deps, { targetTable: "entries", targetId: entry.id });

    expect(embed).not.toHaveBeenCalled();
    const [row] = await db.orm.select().from(entries).where(sql`${entries.id} = ${entry.id}`);
    expect(row?.embedding).toBeNull();
  });

  it("throws when the entry no longer exists", async () => {
    const deps: EmbedDeps = { db: db.orm, embedder: createFakeEmbedder() };

    await expect(
      processEmbedJob(deps, {
        targetTable: "entries",
        targetId: "00000000-0000-0000-0000-000000000000",
      }),
    ).rejects.toThrow();
  });
});

describe("processEmbedJob: memories", () => {
  it("writes an embedding built from content, and never overwrites it", async () => {
    const [entry] = await db.orm
      .insert(entries)
      .values({ kind: "text", textBody: "The owner studies Sistemas." })
      .returning({ id: entries.id });
    if (!entry) throw new Error("insert did not return a row");
    createdEntryIds.push(entry.id);

    const [memory] = await db.orm
      .insert(memories)
      .values({ content: "The owner studies Sistemas.", sourceEntryId: entry.id })
      .returning({ id: memories.id });
    if (!memory) throw new Error("insert did not return a row");

    const deps: EmbedDeps = { db: db.orm, embedder: createFakeEmbedder() };
    await processEmbedJob(deps, { targetTable: "memories", targetId: memory.id });

    const [row] = await db.orm.select().from(memories).where(sql`${memories.id} = ${memory.id}`);
    expect(row?.embedding).toHaveLength(1024);
  });
});

describe("processEmbedJob: topics", () => {
  it("writes an embedding built from name + description + summary", async () => {
    const [topic] = await db.orm
      .insert(topics)
      .values({ name: "University", description: "Coursework and exams" })
      .returning({ id: topics.id });
    if (!topic) throw new Error("insert did not return a row");
    createdTopicIds.push(topic.id);

    const deps: EmbedDeps = { db: db.orm, embedder: createFakeEmbedder() };
    await processEmbedJob(deps, { targetTable: "topics", targetId: topic.id });

    const [row] = await db.orm.select().from(topics).where(sql`${topics.id} = ${topic.id}`);
    expect(row?.embedding).toHaveLength(1024);
  });

  it("re-embeds when called again, unlike entries/memories", async () => {
    const [topic] = await db.orm
      .insert(topics)
      .values({ name: "Work" })
      .returning({ id: topics.id });
    if (!topic) throw new Error("insert did not return a row");
    createdTopicIds.push(topic.id);

    const deps: EmbedDeps = { db: db.orm, embedder: createFakeEmbedder() };
    await processEmbedJob(deps, { targetTable: "topics", targetId: topic.id });
    const [first] = await db.orm.select().from(topics).where(sql`${topics.id} = ${topic.id}`);

    await db.orm
      .update(topics)
      .set({ description: "A rewritten description" })
      .where(sql`${topics.id} = ${topic.id}`);
    await processEmbedJob(deps, { targetTable: "topics", targetId: topic.id });

    const [second] = await db.orm.select().from(topics).where(sql`${topics.id} = ${topic.id}`);
    expect(second?.embedding).not.toEqual(first?.embedding);
  });
});

describe("processEmbedJob: embedder failure", () => {
  it("propagates the error and writes nothing", async () => {
    const [entry] = await db.orm
      .insert(entries)
      .values({ kind: "text", textBody: "Will fail to embed." })
      .returning({ id: entries.id });
    if (!entry) throw new Error("insert did not return a row");
    createdEntryIds.push(entry.id);

    const failingEmbedder: Embedder = {
      embed: async () => {
        throw new Error("simulated Voyage failure");
      },
    };
    const deps: EmbedDeps = { db: db.orm, embedder: failingEmbedder };

    await expect(
      processEmbedJob(deps, { targetTable: "entries", targetId: entry.id }),
    ).rejects.toThrow("simulated Voyage failure");

    const [row] = await db.orm.select().from(entries).where(sql`${entries.id} = ${entry.id}`);
    expect(row?.embedding).toBeNull();
  });
});
