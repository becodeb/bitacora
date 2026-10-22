import { sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client.js";
import { attachments, entries } from "../db/schema.js";
import { createPlaceholderOcr } from "../ocr/placeholder.js";
import type { OcrPort } from "../ocr/types.js";
import type { AttachmentStorage } from "../storage/attachment-storage.js";
import { type PhotoOcrDeps, runPhotoJobAttempt } from "./photo-ocr.js";

/** T05's embed job is enqueued fire-and-forget once derivedText is written; these tests only assert OCR's own outcome, so a bare stub is enough. */
const fakeBoss = { send: async () => undefined } as unknown as PgBoss;

const DEV_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://bitacora:bitacora@localhost:55432/bitacora";

const db = createDb(DEV_DATABASE_URL);

afterAll(async () => {
  await db.pool.end();
});

const fakeStorage: AttachmentStorage = {
  write: () => {
    throw new Error("not used in this test");
  },
  remove: async () => {},
  resolvePath: (storageKey) => storageKey,
};

async function insertPhotoFixture(): Promise<{ entryId: string; attachmentId: string }> {
  const [entry] = await db.orm
    .insert(entries)
    .values({ kind: "photo" })
    .returning({ id: entries.id });
  if (!entry) throw new Error("insert did not return a row");

  const [attachment] = await db.orm
    .insert(attachments)
    .values({
      entryId: entry.id,
      storageKey: "attachments/fixture.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1,
      sha256: "e".repeat(64),
    })
    .returning({ id: attachments.id });
  if (!attachment) throw new Error("insert did not return a row");

  return { entryId: entry.id, attachmentId: attachment.id };
}

async function cleanup(entryId: string): Promise<void> {
  await db.orm.delete(entries).where(sql`${entries.id} = ${entryId}`);
}

describe("processPhotoJob (via runPhotoJobAttempt)", () => {
  const createdEntryIds: string[] = [];

  afterEach(async () => {
    while (createdEntryIds.length > 0) {
      const entryId = createdEntryIds.pop();
      if (entryId) await cleanup(entryId);
    }
  });

  it("marks the attachment not_available and leaves derivedText null with the placeholder OCR", async () => {
    const { entryId, attachmentId } = await insertPhotoFixture();
    createdEntryIds.push(entryId);

    const deps: PhotoOcrDeps = {
      db: db.orm,
      storage: fakeStorage,
      ocr: createPlaceholderOcr(),
      boss: fakeBoss,
    };
    await runPhotoJobAttempt(deps, {
      data: { entryId, attachmentId },
      retryCount: 0,
      retryLimit: 3,
    });

    const [entry] = await db.orm.select().from(entries).where(sql`${entries.id} = ${entryId}`);
    const [attachment] = await db.orm
      .select()
      .from(attachments)
      .where(sql`${attachments.id} = ${attachmentId}`);

    expect(entry?.derivedText).toBeNull();
    expect(attachment?.derivedTextStatus).toBe("not_available");
  });

  it("does not retry or mark failed when the engine is simply not available", async () => {
    const { entryId, attachmentId } = await insertPhotoFixture();
    createdEntryIds.push(entryId);

    // retryCount === retryLimit would mark "failed" on a thrown error, but
    // not_available is not an error, so it must still resolve "not_available".
    const deps: PhotoOcrDeps = {
      db: db.orm,
      storage: fakeStorage,
      ocr: createPlaceholderOcr(),
      boss: fakeBoss,
    };
    await runPhotoJobAttempt(deps, {
      data: { entryId, attachmentId },
      retryCount: 3,
      retryLimit: 3,
    });

    const [attachment] = await db.orm
      .select()
      .from(attachments)
      .where(sql`${attachments.id} = ${attachmentId}`);
    expect(attachment?.derivedTextStatus).toBe("not_available");
  });

  it("writes recognized text and marks done when the engine succeeds", async () => {
    const { entryId, attachmentId } = await insertPhotoFixture();
    createdEntryIds.push(entryId);

    const doneOcr: OcrPort = {
      recognize: async () => ({ status: "done", text: "Sistemas: exam on Monday." }),
    };

    const deps: PhotoOcrDeps = { db: db.orm, storage: fakeStorage, ocr: doneOcr, boss: fakeBoss };
    await runPhotoJobAttempt(deps, {
      data: { entryId, attachmentId },
      retryCount: 0,
      retryLimit: 3,
    });

    const [entry] = await db.orm.select().from(entries).where(sql`${entries.id} = ${entryId}`);
    const [attachment] = await db.orm
      .select()
      .from(attachments)
      .where(sql`${attachments.id} = ${attachmentId}`);

    expect(entry?.derivedText).toBe("Sistemas: exam on Monday.");
    expect(attachment?.derivedTextStatus).toBe("done");
  });

  it("marks the attachment failed once retries are exhausted on a thrown error", async () => {
    const { entryId, attachmentId } = await insertPhotoFixture();
    createdEntryIds.push(entryId);

    const failingOcr: OcrPort = {
      recognize: async () => {
        throw new Error("simulated engine crash");
      },
    };

    const deps: PhotoOcrDeps = {
      db: db.orm,
      storage: fakeStorage,
      ocr: failingOcr,
      boss: fakeBoss,
    };

    await expect(
      runPhotoJobAttempt(deps, { data: { entryId, attachmentId }, retryCount: 3, retryLimit: 3 }),
    ).rejects.toThrow("simulated engine crash");

    const [attachment] = await db.orm
      .select()
      .from(attachments)
      .where(sql`${attachments.id} = ${attachmentId}`);
    expect(attachment?.derivedTextStatus).toBe("failed");
  });
});
