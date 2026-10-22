/**
 * A simple in-process mutex: `run` queues its callback behind every
 * earlier `run` call on the same `Mutex` instance, so at most one runs
 * at a time, in call order. Built on a promise chain, not a worker
 * lock or an advisory DB lock — it only ever serializes work inside
 * THIS Node process. See `http/chat.ts`'s own comment for why that is
 * the right scope for the agent turn: Bitacora is single-user,
 * single-process (`odd/tasks/mvp.md`'s Architecture section — one
 * server process per deploy, no horizontal scaling), so a single
 * in-memory mutex is enough to stop two concurrent `POST /v1/chat`
 * calls from interleaving their reads/writes of the shared chat
 * history. It would NOT be enough across multiple processes/replicas;
 * that would need a DB-level lock instead (e.g. `pg_advisory_lock`).
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * Runs `fn` once every previously queued `run` call has settled
   * (resolved or rejected) — an earlier failure never jams the queue
   * for later callers. Returns `fn`'s own result/rejection.
   */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const settledTail = this.tail.then(
      () => undefined,
      () => undefined,
    );
    const result = settledTail.then(fn);
    this.tail = result;
    return result;
  }
}
