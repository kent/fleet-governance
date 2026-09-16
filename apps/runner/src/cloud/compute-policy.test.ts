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

describe("ordered compute checkpoints", () => {
  const plan = ComputeAllocation.parse({ ...allocation, approvalDeadline: 1500,
    checkpoints: [{ proposalId: "123", approvalDeadline: 1250 }, { proposalId: "456", approvalDeadline: 1500 }] });
  it("allows bounded initial work, then pauses for each vote and releases only its settled action", async () => {
    const { permitsCheckpointExecution } = await import("./compute-policy.js");
    const initial = evaluateComputeAllocation(plan, null, observe([-1, -1]), 1100);
    expect(initial).toMatchObject({ phase: "authorised", checkpointIndex: 0, approvedProposalIds: [], waitingForProposal: true });
    expect(permitsTaskExecution(initial, plan, 1100)).toBe(true);
    expect(permitsCheckpointExecution(initial, plan, "123", 1100)).toBe(false);
    const firstVoting = evaluateComputeAllocation(plan, initial, observe([1, -1], 1110), 1110);
    expect(permitsTaskExecution(firstVoting, plan, 1110)).toBe(false);
    const firstPass = evaluateComputeAllocation(plan, firstVoting, observe([7, -1], 1200), 1200);
    expect(firstPass.approvedProposalIds).toEqual(["123"]);
    expect(permitsCheckpointExecution(firstPass, plan, "123", 1200)).toBe(true);
    expect(permitsCheckpointExecution(firstPass, plan, "456", 1200)).toBe(false);
    expect(permitsCheckpointExecution(firstPass, plan, "999", 1200)).toBe(false);
    const secondVoting = evaluateComputeAllocation(plan, firstPass, observe([7, 1], 1260), 1260);
    expect(secondVoting.phase).toBe("voting");
    expect(permitsCheckpointExecution(secondVoting, plan, "123", 1260)).toBe(false);
    const secondPass = evaluateComputeAllocation(plan, secondVoting, observe([7, 7], 1400), 1400);
    expect(secondPass).toMatchObject({ phase: "authorised", checkpointIndex: 2, approvedProposalIds: ["123", "456"] });
    expect(permitsCheckpointExecution(secondPass, plan, "456", 1400)).toBe(true);
    expect(permitsCheckpointExecution(secondPass, plan, "456", 1431)).toBe(false);
    expect(evaluateComputeAllocation(plan, secondPass, observe([7, 7], 1600), 1600).reason).toBe("allocation_expired");
  });
  it("stops at the second failed vote and a third unrelated yes can never clear the halt", () => {
    const first = evaluateComputeAllocation(plan, null, observe([7, -1], 1200), 1200);
    const failed = evaluateComputeAllocation(plan, first, observe([7, 3], 1400), 1400);
    expect(failed).toMatchObject({ phase: "halted", reason: "vote_failed", failedProposalId: "456" });
    const later = observe([7, 7], 1410); later.proposals.push({ proposalId: "999", state: 7 });
    expect(evaluateComputeAllocation(plan, failed, later, 1410)).toEqual(failed);
  });
  it.each([[-1, 1], [1, 7], [-1, 7], [5, 0]])("refuses an out-of-order second proposal: %j", (...states) => {
    expect(evaluateComputeAllocation(plan, null, observe(states), 1100).reason).toBe("unverifiable_vote");
  });
  it("halts if a previously settled checkpoint disappears or regresses", () => {
    const first = evaluateComputeAllocation(plan, null, observe([7, -1], 1200), 1200);
    for (const state of [-1, 0, 1, 4, 5]) expect(evaluateComputeAllocation(plan, first, observe([state, -1], 1210), 1210).reason).toBe("unverifiable_vote");
  });
  it("uses each fixed checkpoint deadline even when a proposal is never submitted or is first seen settled late", () => {
    for (const state of [-1, 1, 7]) expect(evaluateComputeAllocation(plan, null, observe([state, -1], 1250), 1250))
      .toMatchObject({ phase: "halted", reason: "approval_deadline", failedProposalId: "123" });
    const first = evaluateComputeAllocation(plan, null, observe([7, -1], 1200), 1200);
    expect(evaluateComputeAllocation(plan, first, observe([7, -1], 1450), 1450).phase).toBe("authorised");
    expect(evaluateComputeAllocation(plan, first, observe([7, 7], 1500), 1500))
      .toMatchObject({ phase: "halted", reason: "approval_deadline", failedProposalId: "456" });
  });
  it("never treats a network error as an uncreated checkpoint or permits unknown states on legacy policies", () => {
    expect(evaluateComputeAllocation(plan, null, null, 1100).reason).toBe("unverifiable_vote");
    expect(evaluateComputeAllocation(allocation, null, observe([-1, -1]), 1100).reason).toBe("unverifiable_vote");
  });
  it("rejects mutable, reordered, duplicate, missing or out-of-budget checkpoint plans", () => {
    for (const checkpoints of [[], [{ proposalId: "123", approvalDeadline: 1250 }],
      [{ proposalId: "456", approvalDeadline: 1250 }, { proposalId: "123", approvalDeadline: 1500 }],
      [{ proposalId: "123", approvalDeadline: 1500 }, { proposalId: "456", approvalDeadline: 1400 }],
      [{ proposalId: "123", approvalDeadline: 1000 }, { proposalId: "456", approvalDeadline: 1500 }],
      [{ proposalId: "123", approvalDeadline: 1250 }, { proposalId: "456", approvalDeadline: 1700 }]]) {
      expect(ComputeAllocation.safeParse({ ...plan, checkpoints }).success).toBe(false);
    }
  });
});
