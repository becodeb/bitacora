import { createHash } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

/** What a successful write to disk reports back, for the DB row. */
export interface StoredFile {
  /** Path relative to the storage root; what the DB stores in `attachments.storage_key`. */
  storageKey: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * Durable storage for attachment files (photos, voice notes). Writes are
 * fsynced before `write()` resolves, so a row referencing a `storageKey`
 * is only ever inserted after the bytes it points at are safely on disk
 * (see `AppDeps.storage` callers in `http/entries.ts`).
 */
export interface AttachmentStorage {
  /**
   * Writes `bytes` under a key derived from `attachmentId`, fsyncs the
   * file, and returns its storage key, size and sha256. The key is keyed
   * by `attachmentId` (not content) on purpose: two attachments are
   * never forced to share a file, so deleting one attachment's file on
   * a later DB failure can never affect another attachment.
   */
  write(attachmentId: string, mimeType: string, bytes: Buffer): Promise<StoredFile>;
  /**
   * Best-effort delete of a previously written file. Never throws: a
   * failed cleanup (e.g. the file was already gone) must not mask the
   * DB error that triggered it.
   */
  remove(storageKey: string): Promise<void>;
  /** Resolves a stored `storageKey` back to an absolute filesystem path. */
  resolvePath(storageKey: string): string;
}

/**
 * Best-effort file extension for a MIME type, used only to give stored
 * files a human-readable name on disk. Falls back to the MIME subtype
 * when unrecognized, same strategy as `transcription/audio-input.ts`.
 */
const EXTENSIONS_BY_MIME_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
};

function extensionFor(mimeType: string): string {
  return EXTENSIONS_BY_MIME_TYPE[mimeType.toLowerCase()] ?? mimeType.split("/")[1] ?? "bin";
}

/**
 * `AttachmentStorage` backed by the local filesystem, rooted at
 * `dataDir` (the `DATA_DIR` config value). Files land under
 * `attachments/<attachmentId>.<ext>`.
 */
export function createFileAttachmentStorage(dataDir: string): AttachmentStorage {
  function storageKeyFor(attachmentId: string, mimeType: string): string {
    return join("attachments", `${attachmentId}.${extensionFor(mimeType)}`);
  }

  function resolvePath(storageKey: string): string {
    return join(dataDir, storageKey);
  }

  async function write(attachmentId: string, mimeType: string, bytes: Buffer): Promise<StoredFile> {
    const storageKey = storageKeyFor(attachmentId, mimeType);
    const path = resolvePath(storageKey);
    await mkdir(dirname(path), { recursive: true });

    // `wx`: fail instead of silently overwriting if a file already
    // exists at this key — it never should, since the key is derived
    // from a freshly generated attachment id.
    const handle = await open(path, "wx");
    try {
      await handle.write(bytes);
      // fsync before resolving: the caller (http/entries.ts) only inserts
      // the DB row once this promise settles, so a crash right after
      // can never leave a row pointing at data that never reached disk.
      await handle.sync();
    } finally {
      await handle.close();
    }

    return {
      storageKey,
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }

  async function remove(storageKey: string): Promise<void> {
    try {
      await rm(resolvePath(storageKey));
    } catch {
      // Best-effort: an orphaned file left behind here is a cleanup
      // nuisance, not a correctness problem (nothing in the DB ever
      // references it), so a failure to remove it must not throw.
    }
  }

  return { write, remove, resolvePath };
}
