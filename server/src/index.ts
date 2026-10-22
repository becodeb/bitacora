import { serve } from "@hono/node-server";
import { type Config, loadConfig } from "./config.js";
import { checkDb, createDb } from "./db/client.js";
import { createVoyageEmbedder } from "./embeddings/voyage.js";
import { createApp } from "./http/app.js";
import type { IngestDeps } from "./ingestion/entries.js";
import { createBoss, startBoss } from "./jobs/boss.js";
import { registerEmbedWorker } from "./jobs/embed.js";
import { registerPhotoOcrWorker } from "./jobs/photo-ocr.js";
import { registerVoiceTranscribeWorker } from "./jobs/voice-transcribe.js";
import { createPlaceholderOcr } from "./ocr/placeholder.js";
import { createFileAttachmentStorage } from "./storage/attachment-storage.js";
import { createGroqTranscriber } from "./transcription/groq.js";

/**
 * Upper bound on how long shutdown waits for `pool.end()` to finish
 * draining connections before exiting anyway. Protects against a
 * connection stuck mid-connect (e.g. an unreachable DATABASE_URL) from
 * hanging SIGINT/SIGTERM — the process must still exit promptly even if
 * the pool cannot close cleanly in time.
 */
const SHUTDOWN_GRACE_MILLIS = 3_000;

async function main(): Promise<void> {
  let config: Config;

  try {
    config = loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const { pool, orm } = createDb(config.DATABASE_URL);
  const storage = createFileAttachmentStorage(config.DATA_DIR);

  // Shares one Postgres connection string with `pool` above, but keeps
  // its own internal pool: pg-boss manages its own `pgboss` schema and
  // connection lifecycle independently of the Drizzle pool used for the
  // app's own tables.
  const boss = createBoss(config.DATABASE_URL);
  boss.on("error", (error) => console.error("pg-boss error:", error));
  await startBoss(boss);

  const ingest: IngestDeps = { db: orm, boss, storage };

  await registerVoiceTranscribeWorker(boss, {
    db: orm,
    storage,
    transcriber: createGroqTranscriber({ apiKey: config.GROQ_API_KEY }),
    boss,
  });
  await registerPhotoOcrWorker(boss, { db: orm, storage, ocr: createPlaceholderOcr(), boss });
  await registerEmbedWorker(boss, {
    db: orm,
    embedder: createVoyageEmbedder({ apiKey: config.VOYAGE_API_KEY }),
  });

  const app = createApp({
    appToken: config.APP_TOKEN,
    checkDb: () => checkDb(pool),
    ingest,
  });

  const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    console.log(`bitacora server listening on port ${info.port}`);
  });

  const shutdown = async (): Promise<void> => {
    server.close();

    // Race the pool/worker teardown against a grace period instead of
    // awaiting it unconditionally: a connection stuck mid-connect must
    // not block process exit. Either way we exit once one of the two
    // settles.
    await Promise.race([
      Promise.allSettled([boss.stop({ timeout: SHUTDOWN_GRACE_MILLIS }), pool.end()]),
      new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MILLIS)),
    ]);

    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
