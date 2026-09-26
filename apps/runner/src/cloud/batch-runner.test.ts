import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), put: vi.fn(), remove: vi.fn(), allocation: vi.fn(), state: vi.fn(), blocked: vi.fn(), queue: vi.fn(), launch: vi.fn(), request: vi.fn(), release: vi.fn() }));
vi.mock("./protected-records.js", () => ({ protectedRecord: mocks.read, putProtected: mocks.put, deleteProtected: mocks.remove }));
vi.mock("./compute-store.js", () => ({ readComputeAllocation: mocks.allocation, readComputeState: mocks.state, isComputeRunBlocked: mocks.blocked }));
vi.mock("./simulation.js", () => ({ readSimulationRequest: mocks.queue, queueSimulation: mocks.launch }));
vi.mock("./compute-admin.js", () => ({ COMPUTE_TARGET: "fixed-worker", releaseComputeAllocation: mocks.release }));
vi.mock("./google.js", async importOriginal => ({ ...await importOriginal<typeof import("./google.js")>(), googleRequest: mocks.request }));
import { tickBatch, beginBatchRetirement, releaseBatchAllocation, completeBatchRetirement, reconcileBatch, GUARDIAN_DRAIN_SECONDS } from "./batch-runner.js";
import { ExperimentSettings, experimentDefaults } from "./experiment-settings.js";
const batchId = "batch-00000000-0000-4000-8000-000000000001";
const runId = "run-00000000-0000-4000-8000-000000000001";
const allocationId = "00000000-0000-4000-8000-000000000002";
const plan = { schema: "fleet.batch-plan.v1", batchId, name: "Bounded sweep", requestedBy: "operator1@example.com", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(), maxBudgetUsd: 1, experiments: [ExperimentSettings.parse(experimentDefaults())], runIds: [runId] };
let store: Map<string, unknown>, schedule: { state: string; userUpdateTime: string }, calls: string[], vmId = "123";
beforeEach(() => {
  vi.resetAllMocks();
  store = new Map([["batches/active.json", { batchId }], [`batches/${batchId}/plan.json`, plan], [`batches/${batchId}/approval.json`, { requestedBy: plan.requestedBy, runIds: plan.runIds }]]);
  mocks.read.mockImplementation(async (key: string) => store.has(key) ? { value: store.get(key), generation: "1" } : null);
  mocks.allocation.mockResolvedValue(null); mocks.queue.mockResolvedValue(null);
  schedule = { state: "ENABLED", userUpdateTime: new Date().toISOString() }; calls = [];
  // One fake Google API: the VM, the Guardian service, and the Guardian's Scheduler job.
  mocks.request.mockImplementation(async (service: string, path: string, init?: { method?: string }) => {
    calls.push(`${init?.method ?? "GET"} ${service} ${path.split("/").pop()}`);
    if (service === "cloudscheduler" && path.endsWith(":pause")) schedule = { state: "PAUSED", userUpdateTime: new Date().toISOString() };
    if (service === "cloudscheduler" && path.endsWith(":resume")) schedule = { state: "ENABLED", userUpdateTime: new Date().toISOString() };
    return { json: async () => service === "cloudscheduler" ? schedule : { id: vmId, status: "TERMINATED", terminalCondition: { state: "CONDITION_SUCCEEDED" } } };
  });
});
const allocation = { runId, allocationId, instanceId: "123" };
const retirement = { batchId, runId, allocationId, createdAt: new Date().toISOString() };
const drained = () => { schedule = { state: "PAUSED", userUpdateTime: new Date(Date.now() - (GUARDIAN_DRAIN_SECONDS + 1) * 1000).toISOString() }; };
describe("cloud batch lifecycle", () => {
  it("starts only the immutable human-approved entry", async () => {
    expect(await tickBatch()).toMatchObject({ phase: "running", runId });
    expect(mocks.launch).toHaveBeenCalledWith(runId, plan.experiments[0], "operator1@example.com", batchId);
  });
  it("fails closed without approval or with another queue owner", async () => {
    store.delete(`batches/${batchId}/approval.json`);
    await expect(tickBatch()).rejects.toThrow("authorisation");
    expect(mocks.launch).not.toHaveBeenCalled();
    store.set(`batches/${batchId}/approval.json`, { requestedBy: plan.requestedBy, runIds: plan.runIds });
    mocks.queue.mockResolvedValue({ runId: "another-run" });
    expect(await tickBatch()).toMatchObject({ phase: "blocked" });
    expect(mocks.launch).not.toHaveBeenCalled();
  });
  it("does not advance from agent completion or a stop request alone", async () => {
    mocks.allocation.mockResolvedValue(allocation);
    mocks.state.mockResolvedValue({ value: { phase: "halted" } });
    mocks.request.mockResolvedValue({ json: async () => ({ id: "123", status: "STOPPING" }) });
    expect(await tickBatch()).toMatchObject({ phase: "running" });
    expect(mocks.launch).not.toHaveBeenCalled(); expect(mocks.release).not.toHaveBeenCalled();
  });
  it("retires only the same allocation after a durable halt and observed shutdown", async () => {
    mocks.allocation.mockResolvedValue(allocation); mocks.state.mockResolvedValue({ value: { phase: "halted" } });
    expect(await tickBatch()).toMatchObject({ action: "retire", runId });
    expect(await beginBatchRetirement()).toMatchObject({ runId, allocationId });
    vmId = "456";
    await expect(beginBatchRetirement()).rejects.toThrow("same VM");
    vmId = "123";
  });
  it("refuses latch release until the Guardian is paused and drained", async () => {
    store.set(`batches/${batchId}/retirement-0.json`, retirement); mocks.allocation.mockResolvedValue(allocation);
    await expect(releaseBatchAllocation()).rejects.toThrow("paused and drained");
    schedule = { state: "PAUSED", userUpdateTime: new Date().toISOString() };
    await expect(releaseBatchAllocation()).rejects.toThrow("paused and drained");
    expect(mocks.release).not.toHaveBeenCalled();
    drained();
    await releaseBatchAllocation(); expect(mocks.release).toHaveBeenCalledWith(allocationId);
  });
  it("retires on GCP without sleeping or touching the Guardian's service: pause, drain, release, resume", async () => {
    mocks.allocation.mockResolvedValue(allocation); mocks.state.mockResolvedValue({ value: { phase: "halted" } });
    mocks.put.mockImplementation(async (key: string, value: unknown) => { if (key.includes("retirement")) store.set(key, value); });
    // Pass 1 pauses the Guardian's only trigger and returns at once.
    expect(await reconcileBatch()).toMatchObject({ phase: "retiring", runId });
    expect(schedule.state).toBe("PAUSED"); expect(mocks.release).not.toHaveBeenCalled();
    // Pass 2, still inside the drain window, does nothing.
    expect(await reconcileBatch()).toMatchObject({ phase: "retiring" }); expect(mocks.release).not.toHaveBeenCalled();
    // Pass 3, drained: release, resume, then advance to the next entry.
    drained();
    mocks.release.mockImplementation(async () => { mocks.allocation.mockResolvedValue(null); mocks.blocked.mockResolvedValue(true); });
    expect(await reconcileBatch()).toMatchObject({ phase: "queued", runId });
    expect(mocks.release).toHaveBeenCalledWith(allocationId);
    expect(schedule.state).toBe("ENABLED");
    expect(mocks.put).toHaveBeenCalledWith(`batches/${batchId}/state.json`, expect.objectContaining({ index: 1, phase: "queued" }), "0");
    // The Guardian service is only ever read, never deleted or redeployed.
    expect(calls.filter(call => call.includes(" run ")).every(call => call.startsWith("GET"))).toBe(true);
  });
  it("finishes a retirement that crashed after release without pausing the Guardian again", async () => {
    store.set(`batches/${batchId}/retirement-0.json`, retirement); drained();
    mocks.blocked.mockResolvedValue(true);
    expect(await reconcileBatch()).toMatchObject({ phase: "queued" });
    expect(schedule.state).toBe("ENABLED");
    expect(calls.some(call => call.includes(":pause"))).toBe(false);
  });
  it("resumes interrupted retirement even after cancellation, preserving the old stop", async () => {
    store.set(`batches/${batchId}/retirement-0.json`, retirement); store.set(`batches/${batchId}/cancel.json`, {});
    expect(await tickBatch()).toMatchObject({ action: "retire", runId });
    mocks.blocked.mockResolvedValue(true);
    await completeBatchRetirement();
    expect(mocks.put).toHaveBeenCalledWith(`batches/${batchId}/state.json`, expect.objectContaining({ index: 1, phase: "queued" }), "0");
    expect(mocks.launch).not.toHaveBeenCalled();
  });
  it("cancels future starts but leaves an in-flight allocation under Guardian control", async () => {
    store.set(`batches/${batchId}/cancel.json`, {});
    expect(await tickBatch()).toMatchObject({ phase: "cancelled" });
    expect(mocks.remove).toHaveBeenCalledWith("batches/active.json", "1");
    mocks.allocation.mockResolvedValue(allocation); mocks.state.mockResolvedValue({ value: { phase: "voting" } });
    expect(await tickBatch()).toMatchObject({ phase: "running" });
    expect(mocks.launch).not.toHaveBeenCalled();
  });
  it("does not restart an ambiguous preparation", async () => {
    mocks.queue.mockResolvedValue({ runId, createdAt: new Date(Date.now() - 21 * 60_000).toISOString() });
    await tickBatch();
    expect(mocks.put).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ phase: "blocked" }), "0");
    expect(mocks.launch).not.toHaveBeenCalled();
  });
  it("closes a recovered preparation without retrying it or advancing the batch", async () => {
    mocks.blocked.mockResolvedValue(true);
    store.set(`batches/${batchId}/state.json`, { batchId, index: 0, phase: "blocked", updatedAt: new Date().toISOString(), message: "Preparation needs recovery." });
    expect(await tickBatch()).toMatchObject({ phase: "cancelled" });
    expect(mocks.put).toHaveBeenCalledWith(`batches/${batchId}/state.json`, expect.objectContaining({ phase: "cancelled", index: 0 }), "1");
    expect(mocks.remove).toHaveBeenCalledWith("batches/active.json", "1");
    expect(mocks.launch).not.toHaveBeenCalled();
  });
  it("keeps a recovered run reserved until its queue and allocation are both released", async () => {
    mocks.blocked.mockResolvedValue(true);
    mocks.queue.mockResolvedValue({ runId, createdAt: new Date().toISOString() });
    expect(await tickBatch()).toMatchObject({ phase: "preparing" });
    expect(mocks.remove).not.toHaveBeenCalled();
    mocks.queue.mockResolvedValue(null);
    mocks.allocation.mockResolvedValue(allocation);
    mocks.state.mockResolvedValue({ value: { phase: "halted" } });
    expect(await tickBatch()).toMatchObject({ action: "retire" });
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
  });
});
