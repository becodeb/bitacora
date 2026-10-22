import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgBoss } from "pg-boss";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileAttachmentStorage } from "../storage/attachment-storage.js";
import { createAttachmentEntry, type IngestDeps } from "./entries.js";

/**
 * A `db` whose `transaction()` always fails on the second insert, so the
 * attachment row is never committed — simulating a DB-level failure
 * after the file has already been written to disk, per the "durable
 * first" design in `odd/tasks/mvp.md` task T04.
 */
function createFailingDb(): NodePgDatabase {
  const fakeTx = {
    insert: () => ({
      values: async () => {
        throw new Error("simulated DB failure");
      },
    }),
  };
  return {
    transaction: async (callback: (tx: unknown) => Promise<void>) => callback(fakeTx),
  } as unknown as NodePgDatabase;
}

const neverCalledBoss = {} as unknown as PgBoss;

describe("createAttachmentEntry", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "bitacora-ingestion-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("removes the file it wrote when the DB transaction fails, leaving no orphan", async () => {
    const storage = createFileAttachmentStorage(dataDir);
    const deps: IngestDeps = { db: createFailingDb(), boss: neverCalledBoss, storage };

    let capturedStorageKey: string | undefined;
    const originalWrite = storage.write.bind(storage);
    storage.write = async (attachmentId, mimeType, bytes) => {
      const result = await originalWrite(attachmentId, mimeType, bytes);
      capturedStorageKey = result.storageKey;
      return result;
    };

    await expect(
      createAttachmentEntry(deps, "photo", "image/png", Buffer.from("orphan check"), undefined),
    ).rejects.toThrow("simulated DB failure");

    expect(capturedStorageKey).toBeDefined();
    if (capturedStorageKey) {
      await expect(readFile(storage.resolvePath(capturedStorageKey))).rejects.toThrow();
    }
  });
});
