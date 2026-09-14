/** Bounded parallel work, preserving input order. On failure, drain active work before throwing
 *  and stop scheduling new items so callers never leave background mutations behind. */
export async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("concurrency must be a positive integer");
  const result = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let error: unknown;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { result[index] = await run(items[index]!, index); }
      catch (err) { if (!failed) error = err; failed = true; }
    }
  }));
  if (failed) throw error;
  return result;
}

/** Shared concurrency across independently arriving work. Queued work can be canceled before
 * it acquires a slot. A slot covers the entire operation, including its cleanup. */
export class WorkPool {
  private active = 0;
  private closed = false;
  private readonly waiting: { start: () => void; cancel: () => void }[] = [];
  private readonly idle: (() => void)[] = [];

  constructor(private readonly concurrency: number, private readonly maxQueued = 4096) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || !Number.isSafeInteger(maxQueued) || maxQueued < 0) throw new Error("invalid work pool limits");
  }

  run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.closed || signal?.aborted) return reject(new Error("work_canceled"));
      if (this.active >= this.concurrency && this.waiting.length >= this.maxQueued) return reject(new Error("work_queue_full"));
      const cancel = () => {
        const index = this.waiting.indexOf(ticket);
        if (index >= 0) this.waiting.splice(index, 1);
        signal?.removeEventListener("abort", cancel);
        reject(new Error("work_canceled"));
      };
      const start = () => {
        signal?.removeEventListener("abort", cancel);
        this.active++;
        void (async () => {
          try { resolve(await work()); } catch (error) { reject(error); }
          finally {
            this.active--;
            if (!this.closed) this.waiting.shift()?.start();
            if (!this.active) this.idle.splice(0).forEach(done => done());
          }
        })();
      };
      const ticket = { start, cancel };
      if (this.active < this.concurrency) start();
      else {
        this.waiting.push(ticket);
        signal?.addEventListener("abort", cancel, { once: true });
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const ticket of this.waiting.splice(0)) ticket.cancel();
    if (this.active) await new Promise<void>(resolve => this.idle.push(resolve));
  }
}
