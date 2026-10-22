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
    console.log(
      `nightly consolidation ${result.runId}: ${result.mergeDuplicates.candidatePairCount} candidate pair(s) ` +
        `(${JSON.stringify(result.mergeDuplicates.outcomes)}), ` +
        `${result.topicSummaries.refreshedTopicCount}/${result.topicSummaries.staleTopicCount} topic summaries refreshed`,
    );
  });
}
