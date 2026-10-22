import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileAttachmentStorage } from "./attachment-storage.js";

describe("createFileAttachmentStorage", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "bitacora-attachment-storage-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("writes the file, fsyncs it, and reports its size and sha256", async () => {
    const storage = createFileAttachmentStorage(dataDir);
    const bytes = Buffer.from("hello bitacora");

    const stored = await storage.write("attachment-1", "image/png", bytes);

    expect(stored.sizeBytes).toBe(bytes.byteLength);
    expect(stored.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));

    const onDisk = await readFile(storage.resolvePath(stored.storageKey));
    expect(onDisk.equals(bytes)).toBe(true);
  });

  it("keys the storage path by attachment id and mime extension", async () => {
    const storage = createFileAttachmentStorage(dataDir);

    const photo = await storage.write("attachment-2", "image/jpeg", Buffer.from("a"));
    const voice = await storage.write("attachment-3", "audio/m4a", Buffer.from("b"));

    expect(photo.storageKey).toBe(join("attachments", "attachment-2.jpg"));
    expect(voice.storageKey).toBe(join("attachments", "attachment-3.m4a"));
  });

  it("removes a previously written file", async () => {
    const storage = createFileAttachmentStorage(dataDir);
    const stored = await storage.write("attachment-4", "image/png", Buffer.from("x"));

    await storage.remove(stored.storageKey);

    await expect(readFile(storage.resolvePath(stored.storageKey))).rejects.toThrow();
  });

  it("does not throw when removing a file that does not exist", async () => {
    const storage = createFileAttachmentStorage(dataDir);

    await expect(storage.remove(join("attachments", "never-written.png"))).resolves.toBeUndefined();
  });

  it("fails rather than silently overwriting an existing file at the same key", async () => {
    const storage = createFileAttachmentStorage(dataDir);
    await storage.write("attachment-5", "image/png", Buffer.from("first"));

    await expect(
      storage.write("attachment-5", "image/png", Buffer.from("second")),
    ).rejects.toThrow();
  });
});
