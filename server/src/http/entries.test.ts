import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createStubAgentDeps } from "../agent/test-helpers.js";
import { createDb } from "../db/client.js";
import { attachments, entries } from "../db/schema.js";
import type { IngestDeps } from "../ingestion/entries.js";
import { MAX_REQUEST_BODY_BYTES } from "../ingestion/mime.js";
import { runVoiceJobAttempt } from "../jobs/voice-transcribe.js";
import { createFileAttachmentStorage } from "../storage/attachment-storage.js";
import type { Transcriber } from "../transcription/types.js";
import { createApp } from "./app.js";
import { createStubAdminJobsDeps } from "./test-helpers.js";

const DEV_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://bitacora:bitacora@localhost:55432/bitacora";
const APP_TOKEN = "entries-test-token-0123456789";
const VOICE_QUEUE = "voice-transcription";
const PHOTO_QUEUE = "photo-ocr";
const EMBED_QUEUE = "embed";

const db = createDb(DEV_DATABASE_URL);
const boss = new PgBoss(DEV_DATABASE_URL);

let dataDir: string;
let ingest: IngestDeps;
const createdEntryIds: string[] = [];

beforeAll(async () => {
  await boss.start();
  await boss.createQueue(VOICE_QUEUE);
  await boss.createQueue(PHOTO_QUEUE);
  await boss.createQueue(EMBED_QUEUE);
  dataDir = await mkdtemp(join(tmpdir(), "bitacora-entries-http-"));
  ingest = { db: db.orm, boss, storage: createFileAttachmentStorage(dataDir) };
});

afterAll(async () => {
  await boss.stop({ timeout: 2_000 });
  await db.pool.end();
  await rm(dataDir, { recursive: true, force: true });
});

afterEach(async () => {
  while (createdEntryIds.length > 0) {
    const entryId = createdEntryIds.pop();
    if (entryId) {
      await db.orm.delete(entries).where(sql`${entries.id} = ${entryId}`);
    }
  }
});

function buildApp() {
  return createApp({
    appToken: APP_TOKEN,
    checkDb: async () => true,
    ingest,
    agent: createStubAgentDeps(),
    adminJobs: createStubAdminJobsDeps(),
  });
}

const authHeaders = { Authorization: `Bearer ${APP_TOKEN}` };

/** `Response.json()` types as `unknown`; every response here is this server's own JSON, read back loosely for assertions. */
// biome-ignore lint/suspicious/noExplicitAny: test-only response shape, intentionally untyped.
async function asJson(res: Response): Promise<any> {
  return res.json();
}

describe("POST /v1/entries", () => {
  it("rejects a request with no Authorization header", async () => {
    const app = buildApp();
    const res = await app.request("/v1/entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "no auth" }),
    });

    expect(res.status).toBe(401);
  });

  it("stores a JSON text entry", async () => {
    const app = buildApp();
    const res = await app.request("/v1/entries", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ text: "Buy milk." }),
    });

    expect(res.status).toBe(201);
    const body = await asJson(res);
    expect(body).toMatchObject({ ok: true, kind: "text", status: "stored" });
    createdEntryIds.push(body.id);

    const getRes = await app.request(`/v1/entries/${body.id}`, { headers: authHeaders });
    expect(getRes.status).toBe(200);
    const getBody = await asJson(getRes);
    expect(getBody.entry.textBody).toBe("Buy milk.");
    expect(getBody.entry.attachments).toEqual([]);
  });

  it("stores a multipart text entry via the 'text' field", async () => {
    const app = buildApp();
    const form = new FormData();
    form.set("text", "Remind me about the exam.");

    const res = await app.request("/v1/entries", {
      method: "POST",
      headers: authHeaders,
      body: form,
    });

    expect(res.status).toBe(201);
    const body = await asJson(res);
    expect(body.kind).toBe("text");
    createdEntryIds.push(body.id);
  });

  it("rejects a JSON body with no text field", async () => {
    const app = buildApp();
    const res = await app.request("/v1/entries", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ oops: true }),
    });

    expect(res.status).toBe(400);
  });

  it("stores a photo upload with its caption, computes the right sha256, and enqueues an OCR job", async () => {
    const app = buildApp();
    const bytes = Buffer.from("fake-jpeg-bytes");
    const form = new FormData();
    form.set("file", new File([bytes], "exam.jpg", { type: "image/jpeg" }));
    form.set("caption", "Exam schedule screenshot");

    const res = await app.request("/v1/entries", {
      method: "POST",
      headers: authHeaders,
      body: form,
    });

    expect(res.status).toBe(201);
    const body = await asJson(res);
    expect(body).toMatchObject({ ok: true, kind: "photo", status: "stored" });
    expect(body.attachment.derivedTextStatus).toBe("pending");
    createdEntryIds.push(body.id);

    const [attachmentRow] = await db.orm
      .select()
      .from(attachments)
      .where(sql`${attachments.id} = ${body.attachment.id}`);
    expect(attachmentRow?.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(attachmentRow?.sizeBytes).toBe(bytes.byteLength);

    const [job] = await boss.fetch<{ entryId: string; attachmentId: string }>(PHOTO_QUEUE);
    expect(job?.data.entryId).toBe(body.id);
    expect(job?.data.attachmentId).toBe(body.attachment.id);

    const getRes = await app.request(`/v1/entries/${body.id}`, { headers: authHeaders });
    const getBody = await asJson(getRes);
    expect(getBody.entry.textBody).toBe("Exam schedule screenshot");
    expect(getBody.entry.attachments[0].derivedTextStatus).toBe("pending");
  });

  it("stores a voice upload, enqueues a transcription job, and the job fills derivedText once run", async () => {
    const app = buildApp();
    const bytes = Buffer.from("fake-m4a-bytes");
    const form = new FormData();
    form.set("file", new File([bytes], "note.m4a", { type: "audio/m4a" }));

    const res = await app.request("/v1/entries", {
      method: "POST",
      headers: authHeaders,
      body: form,
    });
    expect(res.status).toBe(201);
    const body = await asJson(res);
    createdEntryIds.push(body.id);

    const [job] = await boss.fetch<{ entryId: string; attachmentId: string }>(VOICE_QUEUE);
    expect(job?.data.entryId).toBe(body.id);

    const fakeTranscriber: Transcriber = {
      transcribe: async () => ({
        provider: "groq",
        model: "whisper-large-v3-turbo",
        language: "es",
        durationMs: 1000,
        segments: [{ startMs: 0, endMs: 1000, speaker: null, text: "Dale que va." }],
      }),
    };

    await runVoiceJobAttempt(
      { db: db.orm, storage: ingest.storage, transcriber: fakeTranscriber, boss },
      {
        data: job?.data ?? { entryId: body.id, attachmentId: body.attachment.id },
        retryCount: 0,
        retryLimit: 3,
      },
    );

    const getRes = await app.request(`/v1/entries/${body.id}`, { headers: authHeaders });
    const getBody = await asJson(getRes);
    expect(getBody.entry.derivedText).toBe("Dale que va.");
    expect(getBody.entry.attachments[0].derivedTextStatus).toBe("done");
  });

  it("rejects an unsupported mime type before writing anything", async () => {
    const app = buildApp();
    const form = new FormData();
    form.set(
      "file",
      new File([Buffer.from("not an image")], "doc.pdf", { type: "application/pdf" }),
    );

    const res = await app.request("/v1/entries", {
      method: "POST",
      headers: authHeaders,
      body: form,
    });

    expect(res.status).toBe(415);
  });

  it("rejects a photo over the size limit", async () => {
    const app = buildApp();
    const oversized = Buffer.alloc(15 * 1024 * 1024 + 1);
    const form = new FormData();
    form.set("file", new File([oversized], "huge.jpg", { type: "image/jpeg" }));

    const res = await app.request("/v1/entries", {
      method: "POST",
      headers: authHeaders,
      body: form,
    });

    expect(res.status).toBe(413);
  });

  it("rejects a request body over the global limit before parsing it", async () => {
    const app = buildApp();
    const oversized = Buffer.alloc(MAX_REQUEST_BODY_BYTES + 1);
    const form = new FormData();
    form.set("file", new File([oversized], "huge.m4a", { type: "audio/mp4" }));

    const res = await app.request("/v1/entries", {
      method: "POST",
      headers: authHeaders,
      body: form,
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ ok: false, error: "request body too large" });
  });

  it("404s GET for an entry that does not exist", async () => {
    const app = buildApp();
    const res = await app.request("/v1/entries/00000000-0000-0000-0000-000000000000", {
      headers: authHeaders,
    });

    expect(res.status).toBe(404);
  });

  it("400s GET for a non-UUID id", async () => {
    const app = buildApp();
    const res = await app.request("/v1/entries/not-a-uuid", { headers: authHeaders });

    expect(res.status).toBe(400);
  });
});
