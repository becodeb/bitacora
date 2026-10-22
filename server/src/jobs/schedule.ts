/**
 * Cron schedules for T08's two nightly jobs, registered against the
 * queues `boss.ts` already created. Both times are local to
 * `America/Argentina/Buenos_Aires` — the owner's own time zone, per
 * `odd/tasks/mvp.md` — via pg-boss's `schedule()` `tz` option, which
 * pg-boss itself resolves at send time (DST-aware if Argentina ever
 * reinstates it; see `lib/buenos-aires-date.ts`'s own note on that).
 */
import type { PgBoss } from "pg-boss";
import { BUENOS_AIRES_TIMEZONE } from "../lib/buenos-aires-date.js";
import { DAILY_ROLLUP_QUEUE, NIGHTLY_CONSOLIDATION_QUEUE } from "./queues.js";

/** 03:30 local — after the owner's day is realistically over, before the 04:00 consolidation run that may want that day's rollup groundwork done first (it does not depend on it, but running after costs nothing). */
export const DAILY_ROLLUP_CRON = "30 3 * * *";
/** 04:00 local. */
export const NIGHTLY_CONSOLIDATION_CRON = "0 4 * * *";

/**
 * `schedule()` is idempotent (an existing schedule with the same name is
 * overwritten, not duplicated — see pg-boss's own docs), so calling this
 * on every server start is safe, matching `startBoss`'s own
 * `createQueue` calls.
 */
export async function scheduleNightlyJobs(boss: PgBoss): Promise<void> {
  await boss.schedule(DAILY_ROLLUP_QUEUE, DAILY_ROLLUP_CRON, {}, { tz: BUENOS_AIRES_TIMEZONE });
  await boss.schedule(
    NIGHTLY_CONSOLIDATION_QUEUE,
    NIGHTLY_CONSOLIDATION_CRON,
    {},
    { tz: BUENOS_AIRES_TIMEZONE },
  );
}
