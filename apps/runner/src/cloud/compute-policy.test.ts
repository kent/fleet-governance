import { describe, expect, it } from "vitest";
import { ComputeAllocation, evaluateComputeAllocation, permitsTaskExecution, type ComputeObservation } from "./compute-policy.js";

const allocation = ComputeAllocation.parse({
  schema: "fleet.compute-allocation.v1", allocationId: "00000000-0000-4000-8000-000000000001",
  runId: "run-00000000-0000-4000-8000-000000000001", project: "fleet-governance", zone: "us-central1-a",
  instance: "fleet-research", instanceId: "123", issuedAt: 1000, approvalDeadline: 1300, stopAt: 1600,
  chainId: 84532, governor: `0x${"11".repeat(20)}`, governorCodeHash: `0x${"22".repeat(32)}`,
  requiredProposalIds: ["123", "456"], maxObservationAgeSeconds: 30,
});
const observe = (states = [1, 1], time = 1100): ComputeObservation => ({
  chainId: allocation.chainId, governor: allocation.governor, governorCodeHash: allocation.governorCodeHash,
  blockNumber: "100", blockHash: `0x${"33".repeat(32)}`, blockTimestamp: time,
  proposals: states.map((state, index) => ({ proposalId: allocation.requiredProposalIds[index]!, state })),
});

describe("GCP compute allocation authority", () => {
  it.each([0, 1, 4, 5])("keeps task execution closed for unsettled proposal state %s", state => {
    const result = evaluateComputeAllocation(allocation, null, observe([state, 7]), 1100);
    expect(result.phase).toBe("voting");
    expect(permitsTaskExecution(result, allocation, 1100)).toBe(false);
  });
  it.each([2, 3, 6])("halts the entire allocation when required proposal state is %s", state => {
    expect(evaluateComputeAllocation(allocation, null, observe([7, state]), 1100))
      .toMatchObject({ phase: "halted", reason: "vote_failed", failedProposalId: "456" });
  });
  it("never lets later yes votes or another proposal undo the stop", () => {
    const halted = evaluateComputeAllocation(allocation, null, observe([3, 7]), 1100);
    const later = observe([7, 7], 1110);
    later.proposals.push({ proposalId: "999", state: 7 });
    expect(evaluateComputeAllocation(allocation, halted, later, 1110)).toEqual(halted);
  });
  it("requires every specifically registered proposal, not any successful vote", () => {
    const other = observe([7, 7]);
    other.proposals[1]!.proposalId = "999";
    expect(evaluateComputeAllocation(allocation, null, other, 1100).reason).toBe("unverifiable_vote");
  });
  it("allows settled approval only within the original hard resource deadline", () => {
    const state = evaluateComputeAllocation(allocation, null, observe([7, 7]), 1100);
    expect(permitsTaskExecution(state, allocation, 1100)).toBe(true);
    expect(permitsTaskExecution(state, allocation, 1131)).toBe(false);
    const refreshed = evaluateComputeAllocation(allocation, state, observe([7, 7], 1400), 1400);
    expect(refreshed.authorisedAt).toBe(1100);
    expect(evaluateComputeAllocation(allocation, refreshed, observe([7, 7], 1600), 1600).reason).toBe("allocation_expired");
  });
  it.each([[1, 1], [4, 5], [7, 7]])("refuses late first approval with states %j", (...states) => {
    expect(evaluateComputeAllocation(allocation, null, observe(states, 1300), 1300).reason).toBe("approval_deadline");
  });
  it.each([null, observe([7, 7], 1069), { ...observe([7, 7]), chainId: 1 },
    { ...observe([7, 7]), governorCodeHash: `0x${"44".repeat(32)}` },
    { ...observe([7, 7]), governor: `0x${"55".repeat(20)}` },
  ])("halts when authority cannot be verified", observation => {
    expect(evaluateComputeAllocation(allocation, null, observation, 1100).reason).toBe("unverifiable_vote");
  });
  it("does not reuse authorisation from another allocation", () => {
    const old = evaluateComputeAllocation(allocation, null, observe([7, 7]), 1100);
    old.allocationId = "00000000-0000-4000-8000-000000000002";
    expect(evaluateComputeAllocation(allocation, old, observe([7, 7]), 1100).reason).toBe("allocation_mismatch");
    expect(permitsTaskExecution(old, allocation, 1100)).toBe(false);
  });
  it("rejects worker targets, duplicate ballots, and expanded compute budgets outside policy", () => {
    expect(ComputeAllocation.safeParse({ ...allocation, instance: "unrelated-production-vm" }).success).toBe(false);
    expect(ComputeAllocation.safeParse({ ...allocation, stopAt: allocation.issuedAt + 14401 }).success).toBe(false);
    expect(ComputeAllocation.safeParse({ ...allocation, machineType: "larger-vm" }).success).toBe(false);
    expect(ComputeAllocation.safeParse({ ...allocation, requiredProposalIds: ["123", "123"] }).success).toBe(false);
    const duplicated = observe([7, 7]);
    duplicated.proposals.push(duplicated.proposals[0]!);
    expect(evaluateComputeAllocation(allocation, null, duplicated, 1100).reason).toBe("unverifiable_vote");
  });
});
