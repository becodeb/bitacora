/** pg-boss worker for T08's scheduled daily rollup (`jobs/schedule.ts`). */
import type { PgBoss } from "pg-boss";
import { type RollupDeps, runDailyRollup } from "../rollup/rollup.js";
import { DAILY_ROLLUP_QUEUE, type DailyRollupJobData } from "./queues.js";

export function registerDailyRollupWorker(boss: PgBoss, deps: RollupDeps): Promise<string> {
  return boss.work<DailyRollupJobData, void>(DAILY_ROLLUP_QUEUE, async ([job]) => {
    if (!job) return;
    const result = await runDailyRollup(deps, { date: job.data.date });
    console.log(
      `daily rollup ${result.dateLabel}: ${result.status} (${result.sourceEntryCount} source entries${result.truncated ? ", truncated" : ""})`,
    );
  });
}
