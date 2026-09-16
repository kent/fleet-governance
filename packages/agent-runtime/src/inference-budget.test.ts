import { expect, it, vi } from "vitest";
import { z } from "zod";
import { InferenceBudget } from "@fleet/schemas";
import { InferenceScheduler } from "./inference.js";
import type { InferenceEvent } from "./inference.js";
import type { CompleteRequest, Provider } from "./providers/types.js";
import { withOneRepair } from "./providers/types.js";

const req = { system: "system", user: "user", schema: z.object({ value: z.string() }), maxTokens: 20, timeoutMs: 5000 };
const identity = { agentId: 0, model: "test", purpose: "task" as const };
const success = { ok: true as const, value: { value: "ok" }, usage: { inputTokens: 10, outputTokens: 2, model: "test", costUsd: 0.000024 }, raw: '{"value":"ok"}', latencyMs: 0 };
const config = { maxTokens: 1000, maxCostUsd: 1, reservedVoteTokens: 0, reservedVoteCostUsd: 0, maxOutputTokensPerCall: 30, prices: { test: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } } };

function setup(budget = config, extra: Partial<ConstructorParameters<typeof InferenceScheduler>[0]> = {}) {
  const events: InferenceEvent[] = [];
  const scheduler = new InferenceScheduler({ concurrency: 3, reservedVoteSlots: 0, maxCalls: 100, reservedVoteCalls: 0,
    budget: InferenceBudget.parse(budget), journal: e => events.push(e), ...extra });
  return { scheduler, events };
}
function provider(complete: Provider["complete"] = async () => success as never): Provider {
  return { name: "openrouter", estimateInputTokens: () => 100, complete };
}

it.each(["tokens", "dollars"])("reserves shared %s before concurrent dispatch and waits for refunds", async dimension => {
  const { scheduler, events } = setup({ ...config, ...(dimension === "tokens" ? { maxTokens: 240 } : { maxCostUsd: 0.00028 }) });
  const releases: (() => void)[] = [];
  const complete = vi.fn(async () => { await new Promise<void>(resolve => releases.push(resolve)); return success as never; });
  const wrapped = scheduler.wrap(provider(complete), identity);
  const calls = [wrapped.complete(req), wrapped.complete(req), wrapped.complete(req)];
  expect(complete).toHaveBeenCalledTimes(2);
  expect(events.filter(e => e.type === "started").every(e => e.reservation?.costNanodollars === "140000")).toBe(true);
  releases[0]!(); releases[1]!();
  await Promise.all(calls.slice(0, 2));
  expect(complete).toHaveBeenCalledTimes(3);
  releases[2]!();
  await Promise.all(calls);
  expect(scheduler.summary().budget).toMatchObject({ chargedTokens: 36, chargedCostUsd: 0.000072, reservationBreached: false });
  await scheduler.close();
});

it.each(["tokens", "dollars"])("preserves voting %s after task work consumes its allowance, including restart", async dimension => {
  const budget = { ...config, ...(dimension === "tokens" ? { maxTokens: 240, reservedVoteTokens: 120 } : { maxCostUsd: 0.00028, reservedVoteCostUsd: 0.00014 }) };
  const { scheduler, events } = setup(budget);
  const fullUsage = provider(async () => ({ ...success, usage: { ...success.usage, inputTokens: 100, outputTokens: 20, costUsd: 0.00014 } }) as never);
  await scheduler.wrap(fullUsage, identity).complete(req);
  const restored = setup(budget, { history: events }).scheduler;
  await expect(restored.wrap(fullUsage, identity).complete(req)).resolves.toMatchObject({ ok: false, raw: dimension === "tokens" ? "inference_task_token_limit" : "inference_task_dollar_limit" });
  await expect(restored.wrap(fullUsage, { ...identity, purpose: "vote" }).complete(req)).resolves.toMatchObject({ ok: true });
  expect(restored.summary().budget).toMatchObject({ chargedTokens: 240, chargedCostUsd: 0.00028 });
});

it("retains both reservations after interruption and cannot reset them by restarting", async () => {
  const { scheduler, events } = setup({ ...config, maxTokens: 120 });
  await scheduler.wrap(provider(), identity).complete(req);
  const restored = setup({ ...config, maxTokens: 120 }, { history: [events[0]!] }).scheduler;
  const complete = vi.fn();
  await expect(restored.wrap(provider(complete), identity).complete(req)).resolves.toMatchObject({ raw: "inference_token_limit" });
  expect(complete).not.toHaveBeenCalled();
  expect(restored.summary().budget).toMatchObject({ chargedTokens: 120, chargedCostUsd: 0.00014 });
});

it("keeps unknown usage charged, and releases only the reported component", async () => {
  const { scheduler } = setup();
  await scheduler.wrap(provider(async () => ({ ok: false, error: "timeout", raw: "", latencyMs: 0 })), identity).complete(req);
  await scheduler.wrap(provider(async () => ({ ...success, usage: { inputTokens: 10, outputTokens: 2, model: "test" } }) as never), identity).complete(req);
  expect(scheduler.summary()).toMatchObject({ unknownUsageCalls: 1, unknownCostCalls: 2, budget: { chargedTokens: 132, chargedCostUsd: 0.00028 } });
});

it.each(["input", "output", "cost"])("halts further dispatch after a reported %s reservation overrun, including restart", async dimension => {
  const { scheduler, events } = setup();
  await scheduler.wrap(provider(async () => ({ ...success, usage: { ...success.usage,
    ...(dimension === "input" ? { inputTokens: 101 } : dimension === "output" ? { outputTokens: 21 } : { costUsd: 0.000141 }),
  } }) as never), identity).complete(req);
  expect(scheduler.summary().budget?.reservationBreached).toBe(true);
  const restored = setup(config, { history: events }).scheduler;
  const complete = vi.fn();
  await expect(restored.wrap(provider(complete), { ...identity, purpose: "vote" }).complete(req)).resolves.toMatchObject({ raw: "inference_reservation_breached" });
  expect(complete).not.toHaveBeenCalled();
});

it("caps repair output before reserving and records both provider attempts", async () => {
  const { scheduler, events } = setup();
  const requests: CompleteRequest<unknown>[] = [];
  const raw = provider(async request => {
    requests.push(request);
    return (requests.length === 1 ? { ...success, ok: false, error: "malformed", truncated: true } : success) as never;
  });
  await expect(withOneRepair(scheduler.wrap(raw, identity), req)).resolves.toMatchObject({ ok: true });
  expect(requests.map(r => r.maxTokens)).toEqual([20, 30]);
  expect(events.filter(e => e.type === "started").map(e => e.reservation?.outputTokens)).toEqual([20, 30]);
  expect(requests[1]?.spending).toEqual({ inputTokens: 100, inputUsdPerMillion: 1, outputUsdPerMillion: 2 });
});

it("allows the collective review and one larger repair inside the same dollar ceiling", async () => {
  const { scheduler, events } = setup({ ...config, maxTokens: 1000000, maxOutputTokensPerCall: 16000 });
  const requests: CompleteRequest<unknown>[] = [];
  const raw = provider(async request => {
    requests.push(request);
    return (requests.length === 1 ? { ...success, ok: false, error: "malformed", truncated: true } : success) as never;
  });
  await expect(withOneRepair(scheduler.wrap(raw, { ...identity, purpose: "vote" }), { ...req, maxTokens: 6000 })).resolves.toMatchObject({ ok: true });
  expect(events.filter(e => e.type === "started").map(e => e.reservation?.outputTokens)).toEqual([6000, 12000]);
  expect(requests.map(r => r.maxTokens)).toEqual([6000, 12000]);
  expect(scheduler.summary().budget).toMatchObject({ maxCostUsd: 1, reservationBreached: false });
});

it("refuses an unpriced or unsupported provider and an oversized prompt before starting", async () => {
  const { scheduler, events } = setup();
  const complete = vi.fn();
  await expect(scheduler.wrap({ name: "claude-cli", complete }, identity).complete(req)).resolves.toMatchObject({ raw: "inference_budget_unsupported_provider" });
  await expect(scheduler.wrap(provider(complete), { ...identity, model: "other" }).complete(req)).resolves.toMatchObject({ raw: "inference_budget_missing_price" });
  await expect(scheduler.wrap({ ...provider(complete), estimateInputTokens: () => 100_000 }, identity).complete(req)).resolves.toMatchObject({ raw: "inference_input_limit" });
  expect(complete).not.toHaveBeenCalled();
  expect(events.every(e => e.type === "denied")).toBe(true);
});

it("reads a lowered charter after queueing and never raises the operator token ceiling", async () => {
  let charterLimit = 1000;
  const { scheduler } = setup(config, { concurrency: 1, charterTokenLimit: async () => charterLimit });
  let release!: () => void;
  const started = new Promise<void>(resolve => {
    const first = scheduler.wrap(provider(async () => { resolve(); await new Promise<void>(r => { release = r; }); return success as never; }), identity).complete(req);
    void first;
  });
  await started;
  const complete = vi.fn();
  const queued = scheduler.wrap(provider(complete), identity).complete(req);
  charterLimit = 100;
  release();
  await expect(queued).resolves.toMatchObject({ raw: "inference_token_limit" });
  expect(complete).not.toHaveBeenCalled();
  charterLimit = 10_000;
  await scheduler.wrap(provider(), identity).complete(req);
  expect(scheduler.summary().budget?.effectiveMaxTokens).toBe(1000);
  await scheduler.close();
});

it("cannot dispatch when canceled or closed during the charter read", async () => {
  let release!: (limit: number) => void;
  const { scheduler } = setup(config, { charterTokenLimit: () => new Promise(resolve => { release = resolve; }) });
  const controller = new AbortController();
  const complete = vi.fn();
  const call = scheduler.wrap(provider(complete), identity, controller.signal).complete(req);
  controller.abort();
  const closed = scheduler.close();
  release(1000);
  await expect(call).resolves.toMatchObject({ raw: "inference_aborted" });
  await closed;
  expect(complete).not.toHaveBeenCalled();
});

it("rejects legacy usage without reservations instead of assuming old calls were free", () => {
  expect(() => setup(config, { history: [{ ...identity, provider: "openrouter", type: "started", id: "old", at: "now", queueMs: 0 }] })).toThrow("no budget reservation");
});

it("rounds sub-nanodollar reservations up so a tiny balance cannot buy unaccounted calls", async () => {
  const { scheduler } = setup({ ...config, maxCostUsd: 1e-9, prices: { test: { inputUsdPerMillion: 0.000001, outputUsdPerMillion: 0.000002 } } });
  const raw = provider(async () => ({ ...success, usage: { ...success.usage, costUsd: 1e-9 } }) as never);
  await expect(scheduler.wrap(raw, identity).complete(req)).resolves.toMatchObject({ ok: true });
  await expect(scheduler.wrap(raw, identity).complete(req)).resolves.toMatchObject({ raw: "inference_dollar_limit" });
  expect(scheduler.summary().budget).toMatchObject({ chargedCostUsd: 1e-9, reservationBreached: false });
});
