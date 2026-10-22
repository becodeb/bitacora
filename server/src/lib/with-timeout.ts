/**
 * Settles exactly as `promise` does, unless it is still pending after
 * `ms` milliseconds, in which case the returned promise rejects first
 * with a timeout error labelled `label`.
 *
 * The original `promise` is not cancelled — this only stops the caller
 * from waiting on an operation it does not own (a dependency-injected
 * check, a query against a connection that may be stuck). The timer is
 * always cleared once `promise` settles, so it cannot keep a short-lived
 * process (e.g. a test run) alive past that point.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
