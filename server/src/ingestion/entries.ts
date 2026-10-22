import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { fromDrizzle, type PgBoss } from "pg-boss";
import { attachments, entries } from "../db/schema.js";
import {
  type DerivationJobData,
  PHOTO_OCR_QUEUE,
  VOICE_TRANSCRIPTION_QUEUE,
} from "../jobs/queues.js";
import type { AttachmentStorage } from "../storage/attachment-storage.js";
import type { AttachmentKind } from "./mime.js";

export interface IngestDeps {
  db: NodePgDatabase;
  boss: PgBoss;
  storage: AttachmentStorage;
}

export interface CreatedEntry {
  entryId: string;
  kind: "text" | AttachmentKind;
  attachment?: { id: string; derivedTextStatus: "pending" };
}

/** Stores a `kind: "text"` entry. No attachment, no derivation job — the text is already final. */
export async function createTextEntry(deps: IngestDeps, text: string): Promise<CreatedEntry> {
  const [row] = await deps.db.insert(entries).values({ kind: "text", textBody: text }).returning({
    id: entries.id,
  });

  if (!row) {
    throw new Error("insert did not return a row");
  }

  return { entryId: row.id, kind: "text" };
}

/**
 * Stores a photo or voice entry: writes the file durably first (see
 * `AttachmentStorage.write`), then inserts the entry and attachment
 * rows and enqueues the derivation job, all in one transaction — using
 * pg-boss's `fromDrizzle` adapter so the job row commits atomically
 * with the entry/attachment rows it refers to. A mid-transaction
 * failure removes the file that was already written, so no row is ever
 * left pointing at bytes that do not exist, and no orphan file is ever
 * left behind either.
 */
export async function createAttachmentEntry(
  deps: IngestDeps,
  kind: AttachmentKind,
  mimeType: string,
  bytes: Buffer,
  caption: string | undefined,
): Promise<CreatedEntry> {
  const entryId = randomUUID();
  const attachmentId = randomUUID();

  const stored = await deps.storage.write(attachmentId, mimeType, bytes);

  try {
    await deps.db.transaction(async (tx) => {
      await tx.insert(entries).values({ id: entryId, kind, textBody: caption ?? null });
      await tx.insert(attachments).values({
        id: attachmentId,
        entryId,
        storageKey: stored.storageKey,
        mimeType,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
      });

      const queueName = kind === "voice" ? VOICE_TRANSCRIPTION_QUEUE : PHOTO_OCR_QUEUE;
      const jobData: DerivationJobData = { entryId, attachmentId };
      // biome-ignore lint/suspicious/noExplicitAny: fromDrizzle's TransactionLike is a minimal structural interface; `tx` satisfies it but TS cannot always see that through the transaction callback's inferred type.
      await deps.boss.send(queueName, jobData, { db: fromDrizzle(tx as any, sql) });
    });
  } catch (error) {
    await deps.storage.remove(stored.storageKey);
    throw error;
  }

  return {
    entryId,
    kind,
    attachment: { id: attachmentId, derivedTextStatus: "pending" },
  };
}

export interface EntryView {
  id: string;
  kind: "text" | AttachmentKind;
  textBody: string | null;
  derivedText: string | null;
  createdAt: Date;
  attachments: Array<{
    id: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    derivedTextStatus: "pending" | "done" | "failed" | "not_available";
    createdAt: Date;
  }>;
}

/** Looks up one entry and its attachments, for `GET /v1/entries/:id`. `null` when no such entry exists. */
export async function getEntryById(deps: IngestDeps, entryId: string): Promise<EntryView | null> {
  const [entry] = await deps.db.select().from(entries).where(sql`${entries.id} = ${entryId}`);

  if (!entry) {
    return null;
  }

  const attachmentRows = await deps.db
    .select()
    .from(attachments)
    .where(sql`${attachments.entryId} = ${entryId}`);

  return {
    id: entry.id,
    kind: entry.kind,
    textBody: entry.textBody,
    derivedText: entry.derivedText,
    createdAt: entry.createdAt,
    attachments: attachmentRows.map((row) => ({
      id: row.id,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      derivedTextStatus: row.derivedTextStatus,
      createdAt: row.createdAt,
    })),
  };
}
