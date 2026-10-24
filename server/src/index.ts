import { serve } from "@hono/node-server";
import { createAnthropicClaudeClient } from "./agent/claude-client.js";
import type { AgentTurnDeps } from "./agent/run-turn.js";
import { type Config, loadConfig } from "./config.js";
import { createClaudeConsolidationJudge } from "./consolidation/claude-consolidation-judge.js";
import { createClaudeTopicSummarizer } from "./consolidation/claude-topic-summarizer.js";
import type { ConsolidationDeps } from "./consolidation/consolidation.js";
import { checkDb, createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { createVoyageEmbedder } from "./embeddings/voyage.js";
import type { AdminJobsDeps } from "./http/admin-jobs.js";
import { createApp } from "./http/app.js";
import type { IngestDeps } from "./ingestion/entries.js";
import { createBoss, startBoss } from "./jobs/boss.js";
import { registerDailyRollupWorker } from "./jobs/daily-rollup-job.js";
import { registerEmbedWorker } from "./jobs/embed.js";
import { registerNightlyConsolidationWorker } from "./jobs/nightly-consolidation-job.js";
import { registerPhotoOcrWorker } from "./jobs/photo-ocr.js";
import { registerVoiceTranscribeWorker } from "./jobs/voice-transcribe.js";
import { createClaudeMemoryJudge } from "./memory/claude-judge.js";
import { createPlaceholderOcr } from "./ocr/placeholder.js";
import { createClaudeRollupSummarizer } from "./rollup/claude-rollup.js";
import type { RollupDeps } from "./rollup/rollup.js";
import { createHybridSearch } from "./search/hybrid-search.js";
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

  // Must resolve before pg-boss or the HTTP server start: the process
  // must never serve a request, or let a worker claim a job, against a
  // schema that is missing a table or column it expects. A rejection
  // here propagates to `main().catch` below, which exits the process
  // instead of coming up half-migrated.
  await runMigrations(orm);

  const storage = createFileAttachmentStorage(config.DATA_DIR);
  const embedder = createVoyageEmbedder({ apiKey: config.VOYAGE_API_KEY });

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
  await registerEmbedWorker(boss, { db: orm, embedder });

  const rollupDeps: RollupDeps = {
    db: orm,
    pool,
    summarizer: createClaudeRollupSummarizer({ apiKey: config.ANTHROPIC_API_KEY }),
  };
  const consolidationDeps: ConsolidationDeps = {
    db: orm,
    pool,
    boss,
    judge: createClaudeConsolidationJudge({ apiKey: config.ANTHROPIC_API_KEY }),
    topicSummarizer: createClaudeTopicSummarizer({ apiKey: config.ANTHROPIC_API_KEY }),
  };
  await registerDailyRollupWorker(boss, rollupDeps);
  await registerNightlyConsolidationWorker(boss, consolidationDeps);
  const adminJobs: AdminJobsDeps = { rollup: rollupDeps, consolidation: consolidationDeps };

  const search = createHybridSearch({ db: orm, embedder });
  const agent: AgentTurnDeps = {
    db: orm,
    claudeClient: createAnthropicClaudeClient({ apiKey: config.ANTHROPIC_API_KEY }),
    hybridSearch: search.hybridSearch,
    findHints: search.findHints,
    memory: {
      db: orm,
      boss,
      embedder,
      judge: createClaudeMemoryJudge({ apiKey: config.ANTHROPIC_API_KEY }),
    },
    effort: config.AGENT_EFFORT,
  };

  const app = createApp({
    appToken: config.APP_TOKEN,
    checkDb: () => checkDb(pool),
    ingest,
    agent,
    adminJobs,
  });

  // Explicit: @hono/node-server's own default is good enough for local
  // dev, but inside a container the server must bind every interface,
  // not just the loopback one, or the Docker network (and Coolify's
  // healthcheck/proxy) cannot reach it.
  const server = serve({ fetch: app.fetch, port: config.PORT, hostname: "0.0.0.0" }, (info) => {
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
