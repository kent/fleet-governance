import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ control: vi.fn(), blocked: vi.fn(), allocation: vi.fn(), read: vi.fn(), request: vi.fn(), write: vi.fn() }));
vi.mock("./compute-store.js", () => ({ COMPUTE_BUCKET: "protected", readComputeObject: mocks.control, readComputeAllocation: mocks.allocation, isComputeRunBlocked: mocks.blocked }));
vi.mock("./google.js", () => ({ googleRequest: mocks.request, readObject: mocks.read, writeObject: mocks.write }));
vi.mock("./control.js", () => ({ ACTIVE: "demo/active.json", runPath: (id: string) => `demo/runs/${id}/status.json` }));
import { queueSimulation } from "./simulation.js";
const runId = "run-00000000-0000-4000-8000-000000000001";
beforeEach(() => { vi.resetAllMocks(); mocks.blocked.mockResolvedValue(false); mocks.control.mockResolvedValue(null); mocks.allocation.mockResolvedValue(null); mocks.read.mockResolvedValue(null); mocks.request.mockResolvedValue({ json: async () => ({ status: "RUNNING", state: "ENABLED", terminalCondition: { state: "CONDITION_SUCCEEDED" } }) }); });
describe("real simulation request", () => {
  it("creates protected reservation and invokes only the fixed job with no overrides", async () => {
    await queueSimulation(runId);
    expect(mocks.request.mock.calls[2]?.[1]).toContain("ifGenerationMatch=0");
    expect(mocks.request).toHaveBeenLastCalledWith("run", "v2/projects/fleet-governance/locations/us-central1/jobs/fleet-simulation:run", { method: "POST", body: "{}" });
    expect(mocks.request.mock.calls.some(call => String(call[1]).endsWith("/start"))).toBe(false);
  });
  it("refuses to start during human recovery while the shutdown controller is absent", async () => {
    mocks.request.mockResolvedValue({ json: async () => ({ terminalCondition: { state: "CONDITION_FAILED" } }) });
    await expect(queueSimulation(runId)).rejects.toThrow("not ready");
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.request.mock.calls.some(call => call[2]?.method === "POST")).toBe(false);
  });
  it("rejects a previously retired run identity before creating a request or starting anything", async () => {
    mocks.blocked.mockResolvedValue(true);
    await expect(queueSimulation(runId)).rejects.toThrow("permanently retired");
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("never repeats the job for a retried request or permits another request to replace it", async () => {
    mocks.control.mockResolvedValue({ runId, createdAt: new Date().toISOString(), requestedBy: "operator2@example.com", schema: "fleet.simulation-request.v1" });
    await queueSimulation(runId);
    expect(mocks.request).not.toHaveBeenCalled();
    await expect(queueSimulation("run-00000000-0000-4000-8000-000000000002")).rejects.toThrow("recovery");
  });
  it("blocks a halted allocation and an active ordinary experiment before any mutation", async () => {
    mocks.allocation.mockResolvedValue({ allocationId: "halted" });
    await expect(queueSimulation(runId)).rejects.toThrow("recovery");
    expect(mocks.request).not.toHaveBeenCalled();
    mocks.allocation.mockResolvedValue(null); mocks.read.mockResolvedValueOnce({ runId: "another" }).mockResolvedValueOnce({ terminal: false });
    await expect(queueSimulation(runId)).rejects.toThrow("already running");
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("retains the protected request after an ambiguous dispatch and never restarts on an authority race", async () => {
    mocks.allocation.mockResolvedValueOnce(null).mockResolvedValueOnce({ allocationId: "concurrent" });
    await expect(queueSimulation(runId)).rejects.toThrow("concurrently");
    expect(mocks.request).toHaveBeenCalledTimes(3);
    expect(mocks.request.mock.calls[2]?.[2]?.method).toBe("POST");
  });
});
