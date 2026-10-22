/**
 * Fixed Postgres advisory-lock keys for T08's two nightly jobs (see
 * `lib/advisory-lock.ts`). Arbitrary but fixed and distinct — picked
 * once, never reused for anything else, and never changed (an existing
 * held lock is identified only by its numeric key, not by name).
 */
export const DAILY_ROLLUP_LOCK_KEY = 830_801;
export const NIGHTLY_CONSOLIDATION_LOCK_KEY = 830_802;
