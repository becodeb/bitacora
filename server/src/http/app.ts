import { Hono } from "hono";
import type { AgentTurnDeps } from "../agent/run-turn.js";
import type { IngestDeps } from "../ingestion/entries.js";
import { withTimeout } from "../lib/with-timeout.js";
import { bearerAuth } from "./auth.js";
import { createChatRouter } from "./chat.js";
import { createEntriesRouter } from "./entries.js";

/**
 * Bounds how long `/health` waits on `deps.checkDb()`. This wraps the
 * call generically — not just the Postgres-backed implementation in
 * `db/client.ts` — because `checkDb` is an injected dependency and the
 * route must not trust every possible implementation (including a test
 * fake) to bound itself.
 */
const HEALTH_CHECK_TIMEOUT_MILLIS = 2_000;

export interface AppDeps {
  /** Resolves true when the database is reachable, false otherwise. Never throws. */
  checkDb: () => Promise<boolean>;
  /** The single bearer token required for every request under /v1. */
  appToken: string;
  /** Shared with the pg-boss derivation workers (see `jobs/`); used by `POST /v1/entries`. */
  ingest: IngestDeps;
  /** Used by `POST /v1/chat` (see `agent/run-turn.ts`). */
  agent: AgentTurnDeps;
}

/**
 * Build the Hono app from its dependencies, so tests can inject fakes
 * (e.g. a `checkDb` that always fails, or hangs) instead of needing a
 * real database or a fixed token for every scenario.
 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  // Public: used by the deploy platform's healthcheck, so it must not
  // require auth.
  app.get("/health", async (c) => {
    let up: boolean;
    try {
      up = await withTimeout(deps.checkDb(), HEALTH_CHECK_TIMEOUT_MILLIS, "checkDb");
    } catch {
      up = false;
    }
    return up ? c.json({ ok: true, db: "up" }, 200) : c.json({ ok: false, db: "down" }, 503);
  });

  const v1 = new Hono();
  v1.use("*", bearerAuth(deps.appToken));

  // Exists so the auth middleware has something to protect and test.
  v1.get("/me", (c) => c.json({ ok: true }, 200));

  v1.route("/entries", createEntriesRouter(deps.ingest));
  v1.route("/chat", createChatRouter({ ingest: deps.ingest, agent: deps.agent }));

  app.route("/v1", v1);

  return app;
}
