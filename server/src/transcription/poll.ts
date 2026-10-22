import { TranscriptionTimeoutError } from "./errors.js";

export type PollOutcome<T> = { done: true; result: T } | { done: false };

export interface PollUntilDoneOptions<T> {
  /** The provider name, carried onto `TranscriptionTimeoutError`. */
  provider: string;
  /** Delay between a not-done poll and the next attempt. */
  pollIntervalMs: number;
  /** Total time budget, measured from just before the first `poll()` call. */
  timeoutMs: number;
  /** Checks the current state once. Any error it throws propagates immediately, with no retry. */
  poll: () => Promise<PollOutcome<T>>;
  /** Overridable only for tests, so a suite can skip the real delay between attempts. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Repeatedly calls `poll` (immediately on the first attempt, with no
 * initial delay) until it reports done, waiting `pollIntervalMs` between
 * attempts. Throws `TranscriptionTimeoutError` once `timeoutMs` has
 * elapsed since the first call without a done result.
 *
 * Shared by every polling adapter (AssemblyAI, Speechmatics) so the
 * "wait, check, repeat, time out" shape is implemented, and tested,
 * exactly once.
 */
export async function pollUntilDone<T>(options: PollUntilDoneOptions<T>): Promise<T> {
  const { provider, pollIntervalMs, timeoutMs, poll, sleep = defaultSleep } = options;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const outcome = await poll();
    if (outcome.done) {
      return outcome.result;
    }
    if (Date.now() >= deadline) {
      throw new TranscriptionTimeoutError(provider, timeoutMs);
    }
    await sleep(pollIntervalMs);
  }
}
