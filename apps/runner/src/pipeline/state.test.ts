import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonFileRunStore, MemoryRunStore, STAGE_ORDER, runStages } from "./state.js";
import type { Stage } from "./state.js";

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

  it("calls onStage once per executed stage, with the updated ctx", async () => {
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
