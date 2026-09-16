import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { InferenceScheduler } from "./inference.js";
import type { InferenceEvent } from "./inference.js";
import { ScriptedProvider } from "./providers/scripted.js";
import { withOneRepair } from "./providers/types.js";
import type { Provider } from "./providers/types.js";

const req = { system: "system", user: "user", schema: z.object({ value: z.string() }), maxTokens: 100, timeoutMs: 1000 };
const identity = { agentId: 0, model: "test", purpose: "task" as const };
const success = { ok: true as const, value: { value: "ok" }, usage: { inputTokens: 10, outputTokens: 2, model: "test", costUsd: 0.01 }, raw: '{"value":"ok"}', latencyMs: 0 };

function setup(overrides: Partial<ConstructorParameters<typeof InferenceScheduler>[0]> = {}) {
  const events: InferenceEvent[] = [];
  const scheduler = new InferenceScheduler({ concurrency: 3, reservedVoteSlots: 1, maxCalls: 100, journal: e => events.push(e), ...overrides });
  return { scheduler, events };
}

it("bounds shared task and vote inference while reserving a voting slot", async () => {
  const releases: (() => void)[] = [];
  const called: number[] = [];
  const { scheduler } = setup();
  const pending = [0, 1, 2].map(agentId => scheduler.wrap({ name: "scripted", complete: async () => {
    called.push(agentId);
    await new Promise<void>(resolve => releases.push(resolve));
    return success as never;
  } }, { ...identity, agentId }).complete(req));
  expect(called).toEqual([0, 1]);
  const vote = scheduler.wrap({ name: "scripted", complete: async () => {
    called.push(9);
    await new Promise<void>(resolve => releases.push(resolve));
    return success as never;
  } }, { ...identity, agentId: 9, purpose: "vote" }).complete(req);
  expect(called).toEqual([0, 1, 9]);
  releases[0]!();
  await pending[0];
  expect(called).toEqual([0, 1, 9, 2]);
  releases.slice(1).forEach(release => release());
  await Promise.all([...pending, vote]);
  expect(scheduler.summary()).toMatchObject({ callsStarted: 4, callsCompleted: 4, peakConcurrency: 3, inputTokens: 40, outputTokens: 8, reportedCostUsd: 0.04 });
});

it("journals both schema-repair attempts and their usage", async () => {
  const { scheduler, events } = setup();
  let call = 0;
  const raw = new ScriptedProvider(() => ({ raw: ++call === 1 ? "broken" : '{"value":"ok"}', usage: { model: "test", inputTokens: 10, outputTokens: 3 } }));
  const result = await withOneRepair(scheduler.wrap(raw, identity), req);
  expect(result.ok).toBe(true);
  expect(events.map(e => e.type)).toEqual(["started", "completed", "started", "completed"]);
  expect(scheduler.summary()).toMatchObject({ callsStarted: 2, inputTokens: 20, outputTokens: 6, unknownCostCalls: 2 });
});

it("preserves voting calls when task work exhausts its share, including after restart", async () => {
  const { scheduler, events } = setup({ maxCalls: 5, reservedVoteCalls: 2 });
  const provider = new ScriptedProvider(() => ({ raw: '{"value":"ok"}' }));
  const task = scheduler.wrap(provider, identity);
  for (let i = 0; i < 3; i++) await expect(task.complete(req)).resolves.toMatchObject({ ok: true });
  expect(scheduler.canStartTask()).toBe(false);
  await expect(task.complete(req)).resolves.toMatchObject({ raw: "inference_task_call_limit" });
  const restored = setup({ maxCalls: 5, reservedVoteCalls: 2, history: events }).scheduler;
  expect(restored.canStartTask()).toBe(false);
  const voter = restored.wrap(provider, { ...identity, purpose: "vote" });
  await expect(voter.complete(req)).resolves.toMatchObject({ ok: true });
  await expect(voter.complete(req)).resolves.toMatchObject({ ok: true });
  await expect(voter.complete(req)).resolves.toMatchObject({ raw: "inference_call_limit" });
  expect(restored.summary()).toMatchObject({ callsStarted: 5, reservedVoteCalls: 2 });
});

it("keeps an interrupted attempt charged after restart and refuses new calls at the ceiling", async () => {
  const { scheduler, events } = setup({ maxCalls: 1 });
  await scheduler.wrap(new ScriptedProvider(() => ({ raw: '{"value":"ok"}' })), identity).complete(req);
  const restored = setup({ maxCalls: 1, history: [events[0]!] }).scheduler;
  const complete = vi.fn();
  const result = await restored.wrap({ name: "scripted", complete } as Provider, identity).complete(req);
  expect(result).toMatchObject({ ok: false, raw: "inference_call_limit" });
  expect(complete).not.toHaveBeenCalled();
  expect(restored.summary()).toMatchObject({ callsStarted: 1, unknownUsageCalls: 1, unknownCostCalls: 1, callsDenied: 1 });
});

it("records missing usage as unknown, including provider exceptions", async () => {
  const { scheduler } = setup();
  await scheduler.wrap({ name: "openrouter", complete: async () => { throw new Error("unavailable"); } }, identity).complete(req);
  await scheduler.wrap({ name: "openrouter", complete: async () => ({ ...success, usage: { ...success.usage, known: false } }) as never }, identity).complete(req);
  expect(scheduler.summary()).toMatchObject({ callsStarted: 2, inputTokens: 0, unknownUsageCalls: 2, unknownCostCalls: 1 });
});

it("does not dispatch after an expired queue deadline", async () => {
  const { scheduler } = setup({ concurrency: 1, reservedVoteSlots: 0 });
  let release!: () => void;
  const first = scheduler.wrap({ name: "scripted", complete: async () => { await new Promise<void>(resolve => { release = resolve; }); return success as never; } }, identity).complete(req);
  const complete = vi.fn();
  const queued = scheduler.wrap({ name: "scripted", complete } as Provider, identity).complete({ ...req, timeoutMs: 10 });
  await expect(queued).resolves.toMatchObject({ error: "timeout", raw: "queue_timeout" });
  release();
  await first;
  expect(complete).not.toHaveBeenCalled();
});

it("fails closed before a paid call if the start journal cannot be written", async () => {
  const { scheduler } = setup({ journal: () => { throw new Error("disk full"); } });
  const complete = vi.fn();
  await expect(scheduler.wrap({ name: "openrouter", complete } as Provider, identity).complete(req)).rejects.toThrow("disk full");
  expect(complete).not.toHaveBeenCalled();
});

it("closing rejects queued work and waits for active calls to finish", async () => {
  const { scheduler } = setup({ concurrency: 1, reservedVoteSlots: 0 });
  let release!: () => void;
  const first = scheduler.wrap({ name: "scripted", complete: async () => { await new Promise<void>(resolve => { release = resolve; }); return success as never; } }, identity).complete(req);
  const complete = vi.fn();
  const queued = scheduler.wrap({ name: "scripted", complete } as Provider, identity).complete(req);
  let closed = false;
  const closing = scheduler.close().then(() => { closed = true; });
  await expect(queued).resolves.toMatchObject({ raw: "inference_closed" });
  expect(closed).toBe(false);
  release();
  await first;
  await closing;
  expect(complete).not.toHaveBeenCalled();
});

describe("journal validation", () => {
  it("rejects malformed and orphaned completion records", () => {
    expect(() => setup({ history: [{ type: "completed" } as InferenceEvent] })).toThrow();
    expect(() => setup({ history: [{ ...identity, provider: "scripted", type: "completed", id: "missing", at: "now", queueMs: 0 }] })).toThrow("unmatched");
  });
});

it("cancels waiting task requests without spending their slots or affecting votes", async () => {
  const { scheduler } = setup({ concurrency: 1, reservedVoteSlots: 0 });
  let release!: () => void;
  const first = scheduler.wrap({ name: "scripted", complete: async () => { await new Promise<void>(resolve => { release = resolve; }); return success as never; } }, identity).complete(req);
  const controller = new AbortController();
  const complete = vi.fn();
  const queued = scheduler.wrap({ name: "scripted", complete } as Provider, identity, controller.signal).complete(req);
  controller.abort();
  await expect(queued).resolves.toMatchObject({ raw: "inference_aborted" });
  const vote = scheduler.wrap(new ScriptedProvider(() => ({ raw: '{"value":"ok"}' })), { ...identity, purpose: "vote" }).complete(req);
  release();
  await first;
  await expect(vote).resolves.toMatchObject({ ok: true });
  expect(complete).not.toHaveBeenCalled();
});


it("honours an explicit review timeout cap without extending the request deadline", async () => {
  vi.useFakeTimers();
  try {
    const { scheduler } = setup({ concurrency: 1, reservedVoteSlots: 0, maxCallTimeoutMs: 120_000 });
    let release!: () => void;
    const deadlines: number[] = [];
    const provider: Provider = { name: "scripted", complete: async request => {
      deadlines.push(request.timeoutMs);
      if (deadlines.length === 1) await new Promise<void>(resolve => { release = resolve; });
      return success as never;
    } };
    const first = scheduler.wrap(provider, identity).complete({ ...req, timeoutMs: 300_000 });
    const queued = scheduler.wrap(provider, { ...identity, purpose: "vote" }).complete({ ...req, timeoutMs: 120_000 });
    await vi.advanceTimersByTimeAsync(3000);
    release();
    await Promise.all([first, queued]);
    expect(deadlines).toEqual([120_000, 117_000]);
    const normal = setup();
    const capture = vi.fn(async () => success as never);
    await normal.scheduler.wrap({ name: "scripted", complete: capture }, identity).complete({ ...req, timeoutMs: 120_000 });
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 60_000 }));
    expect(scheduler.summary().maxCallTimeoutMs).toBe(120_000);
  } finally { vi.useRealTimers(); }
});

it.each([0, -1, 120001, Infinity, NaN, 1.5])("rejects an invalid provider timeout cap: %s", cap => {
  expect(() => setup({ maxCallTimeoutMs: cap })).toThrow("timeout cap");
});
