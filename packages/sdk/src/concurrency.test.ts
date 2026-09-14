import { describe, expect, it } from "vitest";
import { mapConcurrent, WorkPool } from "./concurrency.js";

describe("bounded work", () => {
  it("limits active work and preserves input order despite different completion order", async () => {
    let active = 0;
    let peak = 0;
    const values = Array.from({ length: 100 }, (_, i) => i);
    const result = await mapConcurrent(values, 4, async n => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, n % 3));
      active--;
      return n * 2;
    });
    expect(peak).toBe(4);
    expect(active).toBe(0);
    expect(result).toEqual(values.map(n => n * 2));
  });

  it("drains active tasks on failure without scheduling more", async () => {
    const started: number[] = [];
    let drained = false;
    await expect(mapConcurrent([0, 1, 2, 3], 2, async n => {
      started.push(n);
      if (n === 0) throw new Error("stop");
      await new Promise(resolve => setTimeout(resolve, 10));
      drained = true;
    })).rejects.toThrow("stop");
    expect(started).toEqual([0, 1]);
    expect(drained).toBe(true);
  });
});

describe("shared work pool", () => {
  it("bounds independently arriving jobs and holds each slot until cleanup finishes", async () => {
    const pool = new WorkPool(3);
    let active = 0;
    let peak = 0;
    const jobs = Array.from({ length: 50 }, (_, i) => pool.run(async () => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--;
      return i;
    }));
    expect(await Promise.all(jobs)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(peak).toBe(3);
    expect(active).toBe(0);
    await pool.close();
  });

  it("cancels waiting jobs before execution and refuses an overflowing queue", async () => {
    const pool = new WorkPool(1, 1);
    let release!: () => void;
    const active = pool.run(() => new Promise<void>(resolve => { release = resolve; }));
    const controller = new AbortController();
    let ran = false;
    const queued = pool.run(async () => { ran = true; }, controller.signal);
    await expect(pool.run(async () => {})).rejects.toThrow("work_queue_full");
    controller.abort();
    await expect(queued).rejects.toThrow("work_canceled");
    release();
    await active;
    expect(ran).toBe(false);
    await pool.close();
  });

  it("closing drains active work while refusing pending and later jobs", async () => {
    const pool = new WorkPool(1);
    let release!: () => void;
    const active = pool.run(() => new Promise<void>(resolve => { release = resolve; }));
    const queued = pool.run(async () => {});
    let closed = false;
    const closing = pool.close().then(() => { closed = true; });
    await expect(queued).rejects.toThrow("work_canceled");
    expect(closed).toBe(false);
    release();
    await active;
    await closing;
    await expect(pool.run(async () => {})).rejects.toThrow("work_canceled");
  });
});
