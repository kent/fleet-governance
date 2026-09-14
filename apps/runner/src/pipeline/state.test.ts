import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonFileRunStore, MemoryRunStore, STAGE_ORDER, runStages } from "./state.js";
import type { Stage, StageTimings } from "./state.js";

type FakeCtx = { calls: string[]; count: number };

function buildStages(calls: string[]): Stage<FakeCtx>[] {
  return STAGE_ORDER.map((name) => ({
    name,
    async run(ctx: FakeCtx): Promise<FakeCtx> {
      calls.push(name);
      return { calls: [...ctx.calls, name], count: ctx.count + 1 };
    },
  }));
}

describe("runStages", () => {
  it("runs every stage in order from a fresh run", async () => {
    const store = new MemoryRunStore();
    const calls: string[] = [];
    const stages = buildStages(calls);
    const result = await runStages({
      runId: "run-1",
      store,
      stages,
      ctx: { calls: [], count: 0 },
      toPayload: (ctx) => ({ count: ctx.count }),
    });
    expect(calls).toEqual([...STAGE_ORDER]);
    expect(result.count).toBe(STAGE_ORDER.length);
    const record = await store.get("run-1");
    expect(record?.stage).toBe(STAGE_ORDER[STAGE_ORDER.length - 1]);
    expect(record?.payload).toEqual({ count: STAGE_ORDER.length });
  });

  it("resumes from immediately after the persisted stage, for every possible resume point", async () => {
    for (let stopAt = 0; stopAt < STAGE_ORDER.length; stopAt++) {
      const store = new MemoryRunStore();
      await store.save({
        runId: "run-1",
        stage: STAGE_ORDER[stopAt]!,
        updatedAt: new Date().toISOString(),
        payload: { count: stopAt + 1 },
      });

      const calls: string[] = [];
      const stages = buildStages(calls);
      await runStages({
        runId: "run-1",
        store,
        stages,
        ctx: { calls: [], count: stopAt + 1 },
        toPayload: (ctx) => ({ count: ctx.count }),
      });

      expect(calls).toEqual(STAGE_ORDER.slice(stopAt + 1));
    }
  });

  it("a run already at the last stage resumes to a no-op (no stage re-run)", async () => {
    const store = new MemoryRunStore();
    await store.save({
      runId: "run-1",
      stage: STAGE_ORDER[STAGE_ORDER.length - 1]!,
      updatedAt: new Date().toISOString(),
      payload: {},
    });
    const calls: string[] = [];
    const stages = buildStages(calls);
    await runStages({ runId: "run-1", store, stages, ctx: { calls: [], count: 0 }, toPayload: () => ({}) });
    expect(calls).toEqual([]);
  });

  it("rehydrates the ctx from the persisted payload before the first resumed stage runs", async () => {
    // Final review I1: without this hook `runStages` read only `existing.stage`, so every stage
    // after a resume point ran against a fresh, empty context.
    const store = new MemoryRunStore();
    await store.save({
      runId: "run-1",
      stage: "TASK_OPENED",
      updatedAt: new Date().toISOString(),
      payload: { count: 6, restored: "from the checkpoint" },
    });

    const calls: string[] = [];
    const seen: string[] = [];
    const stages: Stage<FakeCtx & { restored?: string }>[] = STAGE_ORDER.map((name) => ({
      name,
      async run(ctx) {
        calls.push(name);
        seen.push(ctx.restored ?? "MISSING");
        return { ...ctx, calls: [...ctx.calls, name], count: ctx.count + 1 };
      },
    }));

    const result = await runStages({
      runId: "run-1",
      store,
      stages,
      ctx: { calls: [], count: 0 },
      toPayload: (ctx) => ({ count: ctx.count, restored: ctx.restored }),
      rehydrate: (ctx, payload) => ({ ...ctx, count: Number(payload["count"] ?? 0), restored: String(payload["restored"]) }),
    });

    expect(calls).toEqual(["AGENTS_RUNNING", "TASK_ENDED", "CAPTURED", "REPORTED"]);
    expect(seen).toEqual(Array(4).fill("from the checkpoint"));
    expect(result.count).toBe(10);
  });

  it("records one timing per stage it runs, and carries a resumed run's earlier timings forward", async () => {
    // Final review M5: record.json's `timings` was always `{}`, though runStages already knew when
    // every stage started and finished.
    const store = new MemoryRunStore();
    const timings: StageTimings = {};
    await runStages({
      runId: "run-1",
      store,
      stages: buildStages([]),
      ctx: { calls: [], count: 0 },
      toPayload: (ctx) => ({ count: ctx.count, timings }),
      timings,
    });

    expect(Object.keys(timings).sort()).toEqual([...STAGE_ORDER].sort());
    for (const stage of STAGE_ORDER) {
      const timing = timings[stage]!;
      expect(typeof timing.startedAt).toBe("string");
      expect(timing.durationMs).toBeGreaterThanOrEqual(0);
      expect(Date.parse(timing.endedAt)).toBeGreaterThanOrEqual(Date.parse(timing.startedAt));
    }

    // A resume keeps what the earlier process measured and adds only the stages it runs itself.
    await store.save({
      runId: "run-2",
      stage: "TASK_OPENED",
      updatedAt: new Date().toISOString(),
      payload: {
        count: 6,
        timings: { PREFLIGHT: { startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:01.000Z", durationMs: 1000 } },
      },
    });
    const resumedTimings: StageTimings = {};
    await runStages({
      runId: "run-2",
      store,
      stages: buildStages([]),
      ctx: { calls: [], count: 6 },
      toPayload: (ctx) => ({ count: ctx.count, timings: resumedTimings }),
      timings: resumedTimings,
    });
    expect(resumedTimings["PREFLIGHT"]?.durationMs).toBe(1000);
    expect(Object.keys(resumedTimings).sort()).toEqual(
      ["PREFLIGHT", "AGENTS_RUNNING", "TASK_ENDED", "CAPTURED", "REPORTED"].sort(),
    );
  });

  it("does not call rehydrate for a fresh run with no checkpoint", async () => {
    const store = new MemoryRunStore();
    let called = 0;
    await runStages({
      runId: "run-1",
      store,
      stages: buildStages([]),
      ctx: { calls: [], count: 0 },
      toPayload: (ctx) => ({ count: ctx.count }),
      rehydrate: (ctx) => {
        called += 1;
        return ctx;
      },
    });
    expect(called).toBe(0);
  });

  it("calls onStage once per executed stage, with the updated ctx", async () =>{
    const store = new MemoryRunStore();
    const calls: string[] = [];
    const stages = buildStages(calls);
    const seen: string[] = [];
    await runStages({
      runId: "run-1",
      store,
      stages,
      ctx: { calls: [], count: 0 },
      toPayload: (ctx) => ({ count: ctx.count }),
      onStage: (name, ctx) => {
        seen.push(`${name}:${ctx.count}`);
      },
    });
    expect(seen[0]).toBe(`${STAGE_ORDER[0]}:1`);
    expect(seen.length).toBe(STAGE_ORDER.length);
  });

  it("throws if the persisted stage name is not one of the stages given", async () => {
    const store = new MemoryRunStore();
    await store.save({ runId: "run-1", stage: "PREFLIGHT", updatedAt: new Date().toISOString(), payload: {} });
    const calls: string[] = [];
    const stages = buildStages(calls).filter((s) => s.name !== "PREFLIGHT");
    await expect(
      runStages({ runId: "run-1", store, stages, ctx: { calls: [], count: 0 }, toPayload: () => ({}) }),
    ).rejects.toThrow(/not one of the stages/);
  });
});

describe("JsonFileRunStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "fleet-run-state-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null before any save", async () => {
    const store = new JsonFileRunStore(dir);
    expect(await store.get("run-1")).toBeNull();
  });

  it("saves and reads back a record, creating the directory as needed", async () => {
    const runDir = path.join(dir, "nested", "run-1");
    const store = new JsonFileRunStore(runDir);
    await store.save({ runId: "run-1", stage: "DEPLOYED", updatedAt: "2026-01-01T00:00:00.000Z", payload: { a: 1 } });
    const record = await store.get("run-1");
    expect(record).toEqual({ runId: "run-1", stage: "DEPLOYED", updatedAt: "2026-01-01T00:00:00.000Z", payload: { a: 1 } });
  });

  it("overwrites the previous record on a later save", async () => {
    const store = new JsonFileRunStore(dir);
    await store.save({ runId: "run-1", stage: "DEPLOYED", updatedAt: "t1", payload: { a: 1 } });
    await store.save({ runId: "run-1", stage: "VERIFIED", updatedAt: "t2", payload: { a: 2 } });
    const record = await store.get("run-1");
    expect(record?.stage).toBe("VERIFIED");
    expect(record?.payload).toEqual({ a: 2 });
  });

  it("returns null for a different runId than the one on disk", async () => {
    const store = new JsonFileRunStore(dir);
    await store.save({ runId: "run-1", stage: "DEPLOYED", updatedAt: "t1", payload: {} });
    expect(await store.get("run-2")).toBeNull();
  });

  it("writes readable, newline-terminated JSON", async () => {
    const store = new JsonFileRunStore(dir);
    await store.save({ runId: "run-1", stage: "DEPLOYED", updatedAt: "t1", payload: {} });
    const raw = readFileSync(path.join(dir, "run-state.json"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw).runId).toBe("run-1");
  });

  it("runStages resumes correctly against a real JsonFileRunStore", async () => {
    const store = new JsonFileRunStore(dir);
    await store.save({ runId: "run-1", stage: "DEPLOYED", updatedAt: "t1", payload: { count: 3 } });
    const calls: string[] = [];
    const stages = buildStages(calls);
    await runStages({ runId: "run-1", store, stages, ctx: { calls: [], count: 3 }, toPayload: (ctx) => ({ count: ctx.count }) });
    expect(calls).toEqual(STAGE_ORDER.slice(STAGE_ORDER.indexOf("DEPLOYED") + 1));
  });
});
