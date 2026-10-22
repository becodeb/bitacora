import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import { BUENOS_AIRES_TIMEZONE } from "../lib/buenos-aires-date.js";
import { DAILY_ROLLUP_QUEUE, NIGHTLY_CONSOLIDATION_QUEUE } from "./queues.js";
import { DAILY_ROLLUP_CRON, NIGHTLY_CONSOLIDATION_CRON, scheduleNightlyJobs } from "./schedule.js";

describe("scheduleNightlyJobs", () => {
  it("registers both nightly jobs with the right cron and Buenos Aires time zone", async () => {
    const schedule = vi.fn().mockResolvedValue(undefined);
    const fakeBoss = { schedule } as unknown as PgBoss;

    await scheduleNightlyJobs(fakeBoss);

    expect(schedule).toHaveBeenCalledTimes(2);
    expect(schedule).toHaveBeenCalledWith(
      DAILY_ROLLUP_QUEUE,
      DAILY_ROLLUP_CRON,
      {},
      {
        tz: BUENOS_AIRES_TIMEZONE,
      },
    );
    expect(schedule).toHaveBeenCalledWith(
      NIGHTLY_CONSOLIDATION_QUEUE,
      NIGHTLY_CONSOLIDATION_CRON,
      {},
      { tz: BUENOS_AIRES_TIMEZONE },
    );
  });
});
