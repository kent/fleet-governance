import { expect, it, vi } from "vitest";
import { reconcileComputeAllocation, type ComputeControllerDeps, type ComputeRecord } from "./compute-controller.js";
import { ComputeAllocation, type ComputeObservation } from "./compute-policy.js";

const policy = ComputeAllocation.parse({
  schema: "fleet.compute-allocation.v1", allocationId: "00000000-0000-4000-8000-000000000001",
  runId: "run-00000000-0000-4000-8000-000000000001", project: "fleet-governance", zone: "us-central1-a",
  instance: "fleet-research", instanceId: "123", issuedAt: 1000, approvalDeadline: 1300, stopAt: 1600,
  chainId: 84532, governor: `0x${"11".repeat(20)}`, governorCodeHash: `0x${"22".repeat(32)}`,
  requiredProposalIds: ["123"], maxObservationAgeSeconds: 30,
});
function fixture() {
  let record: { value: ComputeRecord; generation: string } | null = null;
  let generation = 0;
  const order: string[] = [];
  const observation: ComputeObservation = {
    chainId: 84532, governor: policy.governor, governorCodeHash: policy.governorCodeHash,
    blockNumber: "100", blockHash: `0x${"33".repeat(32)}`, blockTimestamp: 1100,
    proposals: [{ proposalId: "123", state: 3 }],
  };
  const deps: ComputeControllerDeps = {
    readState: vi.fn(async () => record),
    saveState: vi.fn(async (value, match) => {
      if (match !== (record?.generation ?? "0")) return false;
      order.push(`save:${value.phase}`);
      record = { value: structuredClone(value), generation: String(++generation) };
      return true;
    }),
    observe: vi.fn(async () => observation),
    readVm: vi.fn(async () => ({ id: "123", status: "RUNNING" })),
    stopVm: vi.fn(async () => { order.push("stop"); return { operationId: "operation-test" }; }), now: () => 1100,
  };
  return { deps, order, observation };
}
it("persists a failed vote before requesting a GCP stop and verifies TERMINATED separately", async () => {
  const { deps, order } = fixture();
  const pending = await reconcileComputeAllocation(policy, deps);
  expect(order).toEqual(["save:halted", "stop", "save:halted"]);
  expect(pending).toMatchObject({ reason: "vote_failed", stopRequestedAt: 1100, stopAcceptedAt: 1100, stopOperationId: "operation-test" });
  expect(pending.observations?.[0]?.checks).toContainEqual(expect.objectContaining({ name: "Required approval", status: "fail" }));
  expect(pending.stoppedAt).toBeUndefined();
  vi.mocked(deps.readVm).mockResolvedValue({ id: "123", status: "STOPPING" });
  expect((await reconcileComputeAllocation(policy, deps)).stoppedAt).toBeUndefined();
  expect(deps.stopVm).toHaveBeenCalledTimes(1);
  vi.mocked(deps.readVm).mockResolvedValue({ id: "123", status: "TERMINATED" });
  expect((await reconcileComputeAllocation(policy, deps)).stoppedAt).toBe(1100);
});
it("keeps the halt after a stop API failure, and retries without needing a healthy blockchain", async () => {
  const { deps } = fixture();
  vi.mocked(deps.stopVm).mockRejectedValueOnce(new Error("Compute temporarily unavailable"));
  await expect(reconcileComputeAllocation(policy, deps)).rejects.toThrow("temporarily");
  const failed = (await deps.readState())!.value;
  expect(failed.phase).toBe("halted");
  expect(failed.stopRequestedAt).toBe(1100);
  expect(failed.stopAcceptedAt).toBeUndefined();
  expect(failed.stoppedAt).toBeUndefined();
  vi.mocked(deps.observe).mockRejectedValue(new Error("RPC offline"));
  expect((await reconcileComputeAllocation(policy, deps)).phase).toBe("halted");
  expect(deps.observe).toHaveBeenCalledTimes(1);
  expect(deps.stopVm).toHaveBeenCalledTimes(2);
  expect((await deps.readState())!.value.observations).toHaveLength(1);
});
it("stops a restarted worker without clearing the earlier failure", async () => {
  const { deps, observation } = fixture();
  await reconcileComputeAllocation(policy, deps);
  vi.mocked(deps.readVm).mockResolvedValueOnce({ id: "123", status: "TERMINATED" });
  await reconcileComputeAllocation(policy, deps);
  observation.proposals[0]!.state = 7;
  const restarted = await reconcileComputeAllocation(policy, deps);
  expect(restarted.reason).toBe("vote_failed");
  expect(restarted.stoppedAt).toBeUndefined();
  expect(deps.stopVm).toHaveBeenCalledTimes(2);
});
it("does not stop a different VM that reused an old instance name", async () => {
  const { deps } = fixture();
  vi.mocked(deps.readVm).mockResolvedValue({ id: "different-instance-id", status: "RUNNING" });
  expect((await reconcileComputeAllocation(policy, deps)).reason).toBe("allocation_mismatch");
  expect(deps.stopVm).not.toHaveBeenCalled();
});
it("cannot race a concurrent terminal stop into renewed authorisation", async () => {
  const { deps, observation } = fixture();
  const realSave = deps.saveState;
  vi.mocked(deps.saveState).mockImplementationOnce(async () => {
    await realSave({ allocationId: policy.allocationId, phase: "halted", observedAt: 1099,
      haltedAt: 1099, reason: "vote_failed" }, "0");
    return false;
  });
  observation.proposals[0]!.state = 7;
  expect((await reconcileComputeAllocation(policy, deps)).phase).toBe("halted");
  expect(deps.stopVm).toHaveBeenCalledTimes(1);
});
it("stops when the RPC cannot verify authority", async () => {
  const { deps } = fixture();
  vi.mocked(deps.observe).mockRejectedValue(new Error("RPC offline"));
  expect((await reconcileComputeAllocation(policy, deps)).reason).toBe("unverifiable_vote");
  expect(deps.stopVm).toHaveBeenCalledTimes(1);
});
it("enforces the hard deadline without making another RPC call", async () => {
  const { deps } = fixture();
  deps.now = () => 1600;
  expect((await reconcileComputeAllocation(policy, deps)).reason).toBe("allocation_expired");
  expect(deps.observe).not.toHaveBeenCalled();
  expect(deps.stopVm).toHaveBeenCalledTimes(1);
});
it("leaves the VM running for voting or authorised work without a start or resize capability", async () => {
  const { deps, observation } = fixture();
  observation.proposals[0]!.state = 1;
  expect((await reconcileComputeAllocation(policy, deps)).phase).toBe("voting");
  observation.proposals[0]!.state = 7;
  expect((await reconcileComputeAllocation(policy, deps)).phase).toBe("authorised");
  expect(deps.stopVm).not.toHaveBeenCalled();
});
