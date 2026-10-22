/** pg-boss worker for T08's scheduled nightly consolidation (`jobs/schedule.ts`). */
import type { PgBoss } from "pg-boss";
import { type ConsolidationDeps, runNightlyConsolidation } from "../consolidation/consolidation.js";
import { NIGHTLY_CONSOLIDATION_QUEUE } from "./queues.js";

export function registerNightlyConsolidationWorker(
  boss: PgBoss,
  deps: ConsolidationDeps,
): Promise<string> {
  return boss.work(NIGHTLY_CONSOLIDATION_QUEUE, async () => {
    const result = await runNightlyConsolidation(deps);
    if (result.status === "already_running") {
      // Should not normally happen for the scheduled firing itself (pg-boss
      // does not run two instances of the same cron job concurrently), but
      // can if an admin trigger is mid-run at 04:00 — logged, not an error.
      console.log("nightly consolidation: already running, skipped this firing");
      return;
    }
    console.log(
      `nightly consolidation ${result.runId}: ${result.mergeDuplicates.candidatePairCount} candidate pair(s) ` +
        `(${JSON.stringify(result.mergeDuplicates.outcomes)}), ` +
        `${result.topicSummaries.refreshedTopicCount}/${result.topicSummaries.staleTopicCount} topic summaries refreshed`,
    );
  });
}
