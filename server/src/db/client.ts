import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { withTimeout } from "../lib/with-timeout.js";

export interface Db {
  pool: Pool;
  orm: NodePgDatabase;
}

/**
 * Bounds how long the Pool waits to establish a brand-new connection.
 * Without this, an unreachable or black-holed DATABASE_URL (e.g. a
 * dropped TEST-NET address) hangs the underlying TCP connect for a long
 * time — well past what a healthcheck or a graceful shutdown should
 * ever wait.
 */
const CONNECTION_TIMEOUT_MILLIS = 2_000;

/**
 * Bounds `checkDb`'s own probe query, independent of the Pool's
 * connection timeout above. That timeout only covers establishing a new
 * connection; it does nothing for a query that hangs on a connection
 * that is already open.
 */
const CHECK_QUERY_TIMEOUT_MILLIS = 2_000;

/**
 * Create a pg Pool and the Drizzle instance wrapping it. Callers own the
 * pool's lifecycle and should call `pool.end()` on shutdown.
 */
export function createDb(databaseUrl: string): Db {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MILLIS,
  });
  const orm = drizzle(pool);
  return { pool, orm };
}

/**
 * Lightweight liveness check: true when the database answers a trivial
 * query within `CHECK_QUERY_TIMEOUT_MILLIS`, false on any connection or
 * query error, or if it does not answer in time. Never throws, so it is
 * safe to call directly from the `/health` handler.
 */
export async function checkDb(pool: Pool): Promise<boolean> {
  try {
    await withTimeout(pool.query("SELECT 1"), CHECK_QUERY_TIMEOUT_MILLIS, "checkDb query");
    return true;
  } catch {
    return false;
  }
}
