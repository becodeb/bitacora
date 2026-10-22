import { Hono } from "hono";
import type { AgentTurnDeps } from "../agent/run-turn.js";
import type { IngestDeps } from "../ingestion/entries.js";
import { withTimeout } from "../lib/with-timeout.js";
import { type AdminJobsDeps, createAdminJobsRouter } from "./admin-jobs.js";
import { bearerAuth } from "./auth.js";
import { createChatRouter } from "./chat.js";
import { createEntriesRouter } from "./entries.js";
import { createMeRouter } from "./me.js";

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
  /** Used by `POST /v1/admin/jobs/:name/run` (see `jobs/schedule.ts`'s two nightly jobs, T08). */
  adminJobs: AdminJobsDeps;
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

  // Exact "/me" (no trailing segment) predates the owner-facing API
  // below (`http/me.ts`) and is kept as-is: `auth.test.ts` asserts
  // this exact path returns `{ok: true}`, and a bare GET /v1/me has
  // no natural meaning of its own under the "What I know about you"
  // screen's resource-per-subpath shape (topics/memories/rules/changes).
  v1.get("/me", (c) => c.json({ ok: true }, 200));

  v1.route("/entries", createEntriesRouter(deps.ingest));
  v1.route("/chat", createChatRouter({ ingest: deps.ingest, agent: deps.agent }));
  v1.route("/admin/jobs", createAdminJobsRouter(deps.adminJobs));
  // T10's owner-facing memory API ("What I know about you"): reuses
  // the same `db`/`boss` the chat agent's memory service already has
  // (see `AppDeps.agent.memory`) rather than a separate dependency.
  v1.route("/me", createMeRouter(deps.agent.memory));

  app.route("/v1", v1);

  return app;
}
