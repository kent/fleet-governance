import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ observe: vi.fn(), write: vi.fn(), request: vi.fn() }));
vi.mock("node:fs", () => ({ writeFileSync: mocks.write }));
vi.mock("@fleet/sdk", () => ({ FleetClient: class { async assertChain() {} } }));
vi.mock("./compute-store.js", () => ({
  readComputeAllocation: async () => ({ runId: "run-test", allocationId: "allocation-test", instanceId: "123" }),
  readComputeState: async () => ({ value: { phase: "authorised" } }),
  assertComputeStartAllowed: async () => { throw new Error("Allocation is active"); },
}));
vi.mock("./compute-admin.js", () => ({ COMPUTE_TARGET: "fixed-vm" }));
vi.mock("./compute-observer.js", () => ({ observeComputeApproval: mocks.observe }));
vi.mock("./google.js", () => ({ googleRequest: mocks.request, readSecret: async () => "test-rpc", readObject: async () => ({}) }));
vi.mock("./simulation.js", () => ({
  readSimulationRequest: async () => ({ runId: "run-test" }),
  readSimulationWork: async () => ({ runId: "run-test", startBlock: "1" }),
  simulationPath: () => "test-record",
}));
vi.mock("./agent-experiment-evidence.js", () => ({ verifyAgentExperiment: async () => ({ verified: {} }) }));

it("reads final shutdown evidence only after the chain scan, and consumes the VM response at once", async () => {
  let finishScan!: (value: unknown) => void;
  mocks.observe.mockReturnValue(new Promise(resolve => { finishScan = resolve; }));
  const response = Response.json({ id: "123", status: "RUNNING" });
  mocks.request.mockResolvedValue(response);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const verification = import("./verify-agent-experiment.js");
  try {
    // The scan can outlast the shutdown, so the VM is not read until it finishes.
    await vi.waitFor(() => expect(mocks.observe).toHaveBeenCalled());
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  } finally {
    finishScan({});
    await verification;
    log.mockRestore();
  }
  // Once requested, the body is read within the request deadline.
  expect(response.bodyUsed).toBe(true);
  const evidence = JSON.parse(mocks.write.mock.calls[0]![1]);
  expect(evidence.vm).toEqual({ id: "123", status: "RUNNING" });
  expect(evidence.restartDenied).toBe(true);
});
