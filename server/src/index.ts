import { serve } from "@hono/node-server";
import { type Config, loadConfig } from "./config.js";
import { checkDb, createDb } from "./db/client.js";
import { createApp } from "./http/app.js";

/**
 * Upper bound on how long shutdown waits for `pool.end()` to finish
 * draining connections before exiting anyway. Protects against a
 * connection stuck mid-connect (e.g. an unreachable DATABASE_URL) from
 * hanging SIGINT/SIGTERM — the process must still exit promptly even if
 * the pool cannot close cleanly in time.
 */
const SHUTDOWN_GRACE_MILLIS = 3_000;

function main(): void {
  let config: Config;

  try {
    config = loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const { pool } = createDb(config.DATABASE_URL);
  const app = createApp({
    appToken: config.APP_TOKEN,
    checkDb: () => checkDb(pool),
  });

  const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    console.log(`bitacora server listening on port ${info.port}`);
  });

  const shutdown = async (): Promise<void> => {
    server.close();

    // Race pool.end() against a grace period instead of awaiting it
    // unconditionally: a connection stuck mid-connect must not block
    // process exit. Either way we exit once one of the two settles.
    await Promise.race([
      pool.end().catch(() => {
        // Ignored: we exit regardless of how the pool reports closing.
      }),
      new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MILLIS)),
    ]);

    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
