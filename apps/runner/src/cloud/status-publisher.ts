import { CloudError } from "./google.js";

/** Coalesce concurrent telemetry updates and avoid Cloud Storage's per-object
 * write limit. A failed batch never poisons the queue for the terminal record. */
export function statusPublisher(write: (snapshot: unknown) => Promise<void>, intervalMs = 1100) {
  let latest: unknown, running = false, lastAttempt = -Infinity;
  let waiters: { resolve: () => void; reject: (error: unknown) => void }[] = [];
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const drain = async () => {
    running = true;
    while (waiters.length) {
      await pause(Math.max(0, intervalMs - (Date.now() - lastAttempt)));
      const snapshot = latest, batch = waiters;
      waiters = [];
      try {
        for (let attempt = 0; ; attempt++) {
          lastAttempt = Date.now();
          try { await write(snapshot); break; }
          catch (error) {
            const retryable = error instanceof CloudError
              ? error.status === 429 || error.status >= 500
              : error instanceof Error && error.message === "storage request failed; provider details withheld.";
            if (!retryable || attempt >= 3) throw error;
            await pause(intervalMs * 2 ** attempt);
          }
        }
        batch.forEach(waiter => waiter.resolve());
      } catch (error) { batch.forEach(waiter => waiter.reject(error)); }
    }
    running = false;
  };
  return (snapshot: unknown) => {
    latest = snapshot;
    const pending = new Promise<void>((resolve, reject) => waiters.push({ resolve, reject }));
    if (!running) void drain();
    return pending;
  };
}
