import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ read: vi.fn(), put: vi.fn(), allocation: vi.fn(), request: vi.fn() }));
vi.mock("./protected-records.js", () => ({ protectedRecord: m.read, putProtected: m.put }));
vi.mock("./compute-store.js", () => ({ readComputeAllocation: m.allocation, readComputeState: vi.fn() }));
vi.mock("./simulation.js", () => ({ readSimulationRequest: m.request, readSimulationWork: vi.fn() }));
vi.mock("./experiment-records.js", () => ({ experimentRecord: vi.fn() }));
import { createBatch, startBatch, cancelBatch } from "./batches.js";
const batchId = "batch-00000000-0000-4000-8000-000000000001";
const input = { name: "Research sweep", experiments: [{}], maxBudgetUsd: 1, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
let store: Map<string, unknown>;
beforeEach(() => {
  vi.resetAllMocks(); store = new Map();
  m.read.mockImplementation(async (name: string) => store.has(name) ? { value: store.get(name), generation: "1" } : null);
  m.put.mockImplementation(async (name: string, value: unknown) => { if (store.has(name)) throw new Error("Precondition failed"); store.set(name, value); });
  m.allocation.mockResolvedValue(null); m.request.mockResolvedValue(null);
});
describe("human batch authorisation", () => {
  it("creating and retrying a draft never authorises or dispatches it", async () => {
    const first = await createBatch(batchId, input, "operator4@example.com");
    const retried = await createBatch(batchId, input, "operator4@example.com");
    expect(retried.runIds).toEqual(first.runIds);
    expect(store.has("batches/active.json")).toBe(false);
    expect(store.has(`batches/${batchId}/approval.json`)).toBe(false);
  });
  it("requires the creator and rejects attempts to change or steal a draft", async () => {
    await createBatch(batchId, input, "operator4@example.com");
    await expect(startBatch(batchId, "operator5@example.com")).rejects.toThrow("creator");
    await expect(createBatch(batchId, input, "operator5@example.com")).rejects.toThrow("different owner");
    await expect(createBatch(batchId, { ...input, name: "Changed rules" }, "operator4@example.com")).rejects.toThrow("configuration");
    expect(store.has("batches/active.json")).toBe(false);
  });
  it("approves a finite list once and retries without extending it", async () => {
    const plan = await createBatch(batchId, input, "operator4@example.com");
    await startBatch(batchId, "operator4@example.com"); await startBatch(batchId, "operator4@example.com");
    expect(store.get(`batches/${batchId}/approval.json`)).toMatchObject({ requestedBy: "operator4@example.com", runIds: plan.runIds });
    expect(m.put.mock.calls.filter(([name]) => name === "batches/active.json")).toHaveLength(1);
    store.delete("batches/active.json");
    await expect(startBatch(batchId, "operator4@example.com")).rejects.toThrow("cannot be restarted");
  });
  it("refuses cancelled plans and existing allocations", async () => {
    await createBatch(batchId, input, "operator4@example.com");
    m.allocation.mockResolvedValue({ allocationId: "owned" });
    await expect(startBatch(batchId, "operator4@example.com")).rejects.toThrow("owns");
    m.allocation.mockResolvedValue(null);
    await cancelBatch(batchId, "operator5@example.com");
    await expect(startBatch(batchId, "operator4@example.com")).rejects.toThrow("cancelled");
    expect(store.has("batches/active.json")).toBe(false);
  });
});
