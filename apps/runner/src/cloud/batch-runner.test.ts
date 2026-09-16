import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), put: vi.fn(), remove: vi.fn(), allocation: vi.fn(), state: vi.fn(), blocked: vi.fn(), queue: vi.fn(), launch: vi.fn(), request: vi.fn(), release: vi.fn() }));
vi.mock("./protected-records.js", () => ({ protectedRecord: mocks.read, putProtected: mocks.put, deleteProtected: mocks.remove }));
vi.mock("./compute-store.js", () => ({ readComputeAllocation: mocks.allocation, readComputeState: mocks.state, isComputeRunBlocked: mocks.blocked }));
vi.mock("./simulation.js", () => ({ readSimulationRequest: mocks.queue, queueSimulation: mocks.launch }));
vi.mock("./compute-admin.js", () => ({ COMPUTE_TARGET: "fixed-worker", releaseComputeAllocation: mocks.release }));
vi.mock("./google.js", async importOriginal => ({ ...await importOriginal<typeof import("./google.js")>(), googleRequest: mocks.request }));
import { tickBatch, beginBatchRetirement, releaseBatchAllocation, completeBatchRetirement } from "./batch-runner.js";
import { experimentDefaults } from "./experiment-settings.js";
import { CloudError } from "./google.js";
const batchId = "batch-00000000-0000-4000-8000-000000000001";
const runId = "run-00000000-0000-4000-8000-000000000001";
const allocationId = "00000000-0000-4000-8000-000000000002";
const image = `us-central1-docker.pkg.dev/fleet-governance/fleet/runner@sha256:${"a".repeat(64)}`;
const plan = { schema: "fleet.batch-plan.v1", batchId, name: "Bounded sweep", requestedBy: "operator1@example.com", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(), maxBudgetUsd: 1, experiments: [experimentDefaults()], runIds: [runId] };
let store: Map<string, unknown>;
beforeEach(() => {
  vi.resetAllMocks();
  store = new Map([["batches/active.json", { batchId }], [`batches/${batchId}/plan.json`, plan], [`batches/${batchId}/approval.json`, { requestedBy: plan.requestedBy, runIds: plan.runIds }]]);
  mocks.read.mockImplementation(async (key: string) => store.has(key) ? { value: store.get(key), generation: "1" } : null);
  mocks.allocation.mockResolvedValue(null); mocks.queue.mockResolvedValue(null);
  mocks.request.mockResolvedValue({ json: async () => ({ id: "123", status: "TERMINATED", template: { containers: [{ image }] }, terminalCondition: { state: "CONDITION_SUCCEEDED" } }) });
});
const allocation = { runId, allocationId, instanceId: "123" };
const retirement = { batchId, runId, allocationId, image, createdAt: new Date().toISOString() };
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
    expect(await beginBatchRetirement()).toMatchObject({ runId, allocationId, image });
    mocks.request.mockResolvedValue({ json: async () => ({ id: "456", status: "TERMINATED" }) });
    await expect(beginBatchRetirement()).rejects.toThrow("same VM");
  });
  it("refuses latch release until the old service is absent", async () => {
    store.set(`batches/${batchId}/retirement-0.json`, retirement); mocks.allocation.mockResolvedValue(allocation);
    await expect(releaseBatchAllocation()).rejects.toThrow("retired before release");
    expect(mocks.release).not.toHaveBeenCalled();
    mocks.request.mockRejectedValue(new CloudError(404, "run"));
    await releaseBatchAllocation(); expect(mocks.release).toHaveBeenCalledWith(allocationId);
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
});
