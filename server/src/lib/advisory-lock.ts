/**
 * Run-level mutual exclusion for T08's two nightly jobs, via a
 * Postgres session-level advisory lock. Guards against the 04:00
 * schedule firing while an admin trigger (or another concurrent
 * trigger) is already running the same job — without this, two
 * concurrent runs could both read the same memory pair as live under
 * READ COMMITTED and act on it twice (see `consolidation.ts`'s own
 * per-pair staleness recheck, which only protects against overlap
 * *within* one run, not between two runs).
 */
import type { Pool } from "pg";

export type AdvisoryLockResult<T> = { ran: true; result: T } | { ran: false };

/**
 * Runs `fn` while holding `lockKey` via `pg_try_advisory_lock`, or
 * returns `{ ran: false }` immediately if another holder already has
 * it — never waits.
 *
 * Session-level advisory locks are tied to the CONNECTION that took
 * them, not to a transaction, so this checks out one dedicated client
 * from `pool` with `pool.connect()` and holds it for `fn`'s entire
 * duration (even though `fn` itself opens its own separate
 * transactions against the pool for its real work) — running the lock
 * query through the pool directly would risk the pool handing that
 * same connection to an unrelated caller before `fn` finishes, or
 * unlocking from a different connection than the one that locked,
 * neither of which `pg_advisory_unlock` tolerates.
 */
export async function runWithAdvisoryLock<T>(
  pool: Pool,
  lockKey: number,
  fn: () => Promise<T>,
): Promise<AdvisoryLockResult<T>> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock($1) as locked",
      [lockKey],
    );
    if (!rows[0]?.locked) {
      return { ran: false };
    }
    try {
      const result = await fn();
      return { ran: true, result };
    } finally {
      await client.query("select pg_advisory_unlock($1)", [lockKey]);
    }
  } finally {
    client.release();
  }
}
