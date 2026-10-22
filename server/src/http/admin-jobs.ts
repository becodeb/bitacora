/**
 * `POST /v1/admin/jobs/:name/run`: runs one of T08's nightly jobs right
 * now, outside its schedule — for manual testing and for backfilling a
 * specific day's rollup. Calls the job's own function directly (not
 * through pg-boss) so the HTTP response can return the result
 * synchronously; already protected by the same bearer auth as the rest
 * of `/v1` (see `http/app.ts`).
 */
import { Hono } from "hono";
import { z } from "zod";
import type { ConsolidationDeps } from "../consolidation/consolidation.js";
import { runNightlyConsolidation } from "../consolidation/consolidation.js";
import { isValidDateLabel } from "../lib/buenos-aires-date.js";
import type { RollupDeps } from "../rollup/rollup.js";
import { runDailyRollup } from "../rollup/rollup.js";

export interface AdminJobsDeps {
  rollup: RollupDeps;
  consolidation: ConsolidationDeps;
}

const runDailyRollupBodySchema = z.object({ date: z.string().optional() });

export function createAdminJobsRouter(deps: AdminJobsDeps): Hono {
  const router = new Hono();

  router.post("/:name/run", async (c) => {
    const name = c.req.param("name");

    if (name === "daily-rollup") {
      const rawBody = await c.req.json().catch(() => ({}));
      const parsed = runDailyRollupBodySchema.safeParse(rawBody);
      if (!parsed.success) {
        return c.json({ ok: false, error: "body must be {} or { date: 'YYYY-MM-DD' }" }, 400);
      }
      if (parsed.data.date !== undefined && !isValidDateLabel(parsed.data.date)) {
        return c.json({ ok: false, error: `invalid date: ${parsed.data.date}` }, 400);
      }
      const result = await runDailyRollup(deps.rollup, { date: parsed.data.date });
      if (result.status === "already_running") {
        return c.json({ ok: false, error: "daily-rollup is already running" }, 409);
      }
      return c.json({ ok: true, result }, 200);
    }

    if (name === "nightly-consolidation") {
      const result = await runNightlyConsolidation(deps.consolidation);
      if (result.status === "already_running") {
        return c.json({ ok: false, error: "nightly-consolidation is already running" }, 409);
      }
      return c.json({ ok: true, result }, 200);
    }

    return c.json({ ok: false, error: `unknown job: ${name}` }, 404);
  });

  return router;
}
