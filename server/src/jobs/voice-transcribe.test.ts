import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client.js";
import { attachments, entries } from "../db/schema.js";
import type { AttachmentStorage } from "../storage/attachment-storage.js";
import type { Transcriber } from "../transcription/types.js";
import { runVoiceJobAttempt, type VoiceTranscribeDeps } from "./voice-transcribe.js";

/** T05's embed job is enqueued fire-and-forget once derivedText is written; these tests only assert transcription's own outcome, so a bare stub is enough. */
const fakeBoss = { send: async () => undefined } as unknown as PgBoss;

// Mirrors compose.dev.yml's credentials and the host port chosen there,
// same convention as db/schema.test.ts.
const DEV_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://bitacora:bitacora@localhost:55432/bitacora";

const db = createDb(DEV_DATABASE_URL);

afterAll(async () => {
  await db.pool.end();
});

/** Never actually read in these tests: the fake transcriber ignores the path it is given. */
const fakeStorage: AttachmentStorage = {
  write: () => {
    throw new Error("not used in this test");
  },
  remove: async () => {},
  resolvePath: (storageKey) => storageKey,
};

async function insertVoiceFixture(): Promise<{ entryId: string; attachmentId: string }> {
  const [entry] = await db.orm
    .insert(entries)
    .values({ kind: "voice" })
    .returning({ id: entries.id });
  if (!entry) throw new Error("insert did not return a row");

  const [attachment] = await db.orm
    .insert(attachments)
    .values({
      entryId: entry.id,
      storageKey: "attachments/fixture.m4a",
      mimeType: "audio/m4a",
      sizeBytes: 1,
      sha256: "f".repeat(64),
    })
    .returning({ id: attachments.id });
  if (!attachment) throw new Error("insert did not return a row");

  return { entryId: entry.id, attachmentId: attachment.id };
}

async function cleanup(entryId: string): Promise<void> {
  // Cascades to the attachment (see attachments.entryId's onDelete: "cascade").
  await db.orm.delete(entries).where(sql`${entries.id} = ${entryId}`);
}

describe("processVoiceJob (via runVoiceJobAttempt)", () => {
  const createdEntryIds: string[] = [];

  afterEach(async () => {
    while (createdEntryIds.length > 0) {
      const entryId = createdEntryIds.pop();
      if (entryId) await cleanup(entryId);
    }
  });

  it("writes the joined transcript into derivedText and marks the attachment done", async () => {
    const { entryId, attachmentId } = await insertVoiceFixture();
    createdEntryIds.push(entryId);

    const fakeTranscriber: Transcriber = {
      transcribe: async () => ({
        provider: "groq",
        model: "whisper-large-v3-turbo",
        language: "es",
        durationMs: 2000,
        segments: [
          { startMs: 0, endMs: 1000, speaker: null, text: "Hola" },
          { startMs: 1000, endMs: 2000, speaker: null, text: "mundo." },
        ],
      }),
    };

    const deps: VoiceTranscribeDeps = {
      db: db.orm,
      storage: fakeStorage,
      transcriber: fakeTranscriber,
      boss: fakeBoss,
    };
    await runVoiceJobAttempt(deps, {
      data: { entryId, attachmentId },
      retryCount: 0,
      retryLimit: 3,
    });

    const [entry] = await db.orm.select().from(entries).where(sql`${entries.id} = ${entryId}`);
    const [attachment] = await db.orm
      .select()
      .from(attachments)
      .where(sql`${attachments.id} = ${attachmentId}`);

    expect(entry?.derivedText).toBe("Hola mundo.");
    expect(attachment?.derivedTextStatus).toBe("done");
  });

  it("never overwrites a derivedText that is already set", async () => {
    const { entryId, attachmentId } = await insertVoiceFixture();
    createdEntryIds.push(entryId);
    await db.orm
      .update(entries)
      .set({ derivedText: "original" })
      .where(sql`${entries.id} = ${entryId}`);

    const fakeTranscriber: Transcriber = {
      transcribe: async () => ({
        provider: "groq",
        model: "whisper-large-v3-turbo",
        language: "es",
        durationMs: 1000,
        segments: [{ startMs: 0, endMs: 1000, speaker: null, text: "overwrite attempt" }],
      }),
    };

    const deps: VoiceTranscribeDeps = {
      db: db.orm,
      storage: fakeStorage,
      transcriber: fakeTranscriber,
      boss: fakeBoss,
    };
    await runVoiceJobAttempt(deps, {
      data: { entryId, attachmentId },
      retryCount: 0,
      retryLimit: 3,
    });

    const [entry] = await db.orm.select().from(entries).where(sql`${entries.id} = ${entryId}`);
    expect(entry?.derivedText).toBe("original");
  });

  it("leaves the attachment pending and rethrows while retries remain", async () => {
    const { entryId, attachmentId } = await insertVoiceFixture();
    createdEntryIds.push(entryId);

    const failingTranscriber: Transcriber = {
      transcribe: async () => {
        throw new Error("simulated provider failure");
      },
    };

    const deps: VoiceTranscribeDeps = {
      db: db.orm,
      storage: fakeStorage,
      transcriber: failingTranscriber,
      boss: fakeBoss,
    };

    await expect(
      runVoiceJobAttempt(deps, { data: { entryId, attachmentId }, retryCount: 0, retryLimit: 3 }),
    ).rejects.toThrow("simulated provider failure");

    const [attachment] = await db.orm
      .select()
      .from(attachments)
      .where(sql`${attachments.id} = ${attachmentId}`);
    expect(attachment?.derivedTextStatus).toBe("pending");
  });

  it("marks the attachment failed once retries are exhausted", async () => {
    const { entryId, attachmentId } = await insertVoiceFixture();
    createdEntryIds.push(entryId);

    const failingTranscriber: Transcriber = {
      transcribe: async () => {
        throw new Error("simulated provider failure");
      },
    };

    const deps: VoiceTranscribeDeps = {
      db: db.orm,
      storage: fakeStorage,
      transcriber: failingTranscriber,
      boss: fakeBoss,
    };

    await expect(
      runVoiceJobAttempt(deps, { data: { entryId, attachmentId }, retryCount: 3, retryLimit: 3 }),
    ).rejects.toThrow("simulated provider failure");

    const [attachment] = await db.orm
      .select()
      .from(attachments)
      .where(sql`${attachments.id} = ${attachmentId}`);
    expect(attachment?.derivedTextStatus).toBe("failed");
  });

  it("throws when the attachment no longer exists", async () => {
    const deps: VoiceTranscribeDeps = {
      db: db.orm,
      storage: fakeStorage,
      transcriber: {
        transcribe: async () => {
          throw new Error("should not be called");
        },
      },
      boss: fakeBoss,
    };

    await expect(
      runVoiceJobAttempt(deps, {
        data: { entryId: randomUUID(), attachmentId: randomUUID() },
        retryCount: 0,
        retryLimit: 3,
      }),
    ).rejects.toThrow();
  });
});
