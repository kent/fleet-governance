import { describe, expect, it } from "vitest";
import { ComputeAllocation, evaluateComputeAllocation, permitsCheckpointExecution, type ComputeObservation } from "./compute-policy.js";

const addr = (n: number) => `0x${String(n).repeat(40)}`;
const hash = `0x${"a".repeat(64)}`;
const allocation = ComputeAllocation.parse({ schema: "fleet.compute-allocation.v1",
  allocationId: "11111111-1111-4111-8111-111111111111", runId: "run-22222222-2222-4222-8222-222222222222",
  project: "fleet-governance", zone: "us-central1-a", instance: "fleet-research", instanceId: "123",
  issuedAt: 1000, approvalDeadline: 3000, stopAt: 3000, chainId: 84532, governor: addr(8), governorCodeHash: hash,
  requiredProposalIds: [], maxObservationAgeSeconds: 120,
  discovery: { taskId: "9", hook: addr(7), hookCodeHash: hash, creditsContract: addr(6), creditsCodeHash: hash,
    runHash: hash, startBlock: "100", creditsPerAgent: 3, agents: [1, 2, 3, 4, 5].map(addr),
    proposalWindowSeconds: 540, publicationWindowSeconds: 120 } });
const observation = (proposals: ComputeObservation["proposals"], at = 1100): ComputeObservation => ({
  chainId: 84532, governor: addr(8), governorCodeHash: hash, blockNumber: "150", blockHash: hash,
  blockTimestamp: at, proposals, discoveryVerified: true });
const paid = (id: string, state: number, agent = 1) => ({ proposalId: id, state, proposer: addr(agent), paidAt: 1050, creditPaid: true });

describe("agent-originated governance", () => {
  it("begins work with no predetermined proposals", () => {
    const state = evaluateComputeAllocation(allocation, null, observation([]), 1100);
    expect(state.phase).toBe("authorised");
    expect(state.observedProposalIds).toEqual([]);
    expect(permitsCheckpointExecution(state, allocation, "777", 1100)).toBe(false);
  });
  it("pauses on a credit reservation, discovers the live vote, then releases its exact permission", () => {
    const reserved = evaluateComputeAllocation(allocation, null, observation([paid("77", -1)]), 1100);
    expect(reserved.phase).toBe("voting");
    const voting = evaluateComputeAllocation(allocation, reserved, observation([paid("77", 1)]), 1100);
    expect(voting.phase).toBe("voting");
    const approved = evaluateComputeAllocation(allocation, voting, observation([paid("77", 7)]), 1100);
    expect(approved.phase).toBe("authorised");
    expect(permitsCheckpointExecution(approved, allocation, "77", 1100)).toBe(true);
    expect(permitsCheckpointExecution(approved, allocation, "78", 1100)).toBe(false);
    expect(evaluateComputeAllocation(allocation, approved, observation([paid("77", 7), paid("78", 1, 2)]), 1100).phase).toBe("voting");
  });
  it("retains a failed vote even if later votes pass or the worker omits it", () => {
    const halted = evaluateComputeAllocation(allocation, null, observation([paid("77", 3)]), 1100);
    expect(halted.reason).toBe("vote_failed");
    expect(evaluateComputeAllocation(allocation, halted, observation([paid("78", 7)]), 1101)).toEqual(halted);
    const seen = evaluateComputeAllocation(allocation, null, observation([paid("77", 1)]), 1100);
    expect(evaluateComputeAllocation(allocation, seen, observation([]), 1100).reason).toBe("unverifiable_vote");
  });
  it("fails closed on bypassed payment or a fourth proposal from one agent", () => {
    expect(evaluateComputeAllocation(allocation, null, observation([{ ...paid("77", 1), creditPaid: false }]), 1100).reason).toBe("unpaid_proposal");
    expect(evaluateComputeAllocation(allocation, null, observation([1, 2, 3, 4].map(i => paid(String(i), 1))), 1100).reason).toBe("unverifiable_vote");
  });
  it("bounds publication and settlement from the payment block, never the worker's clock", () => {
    expect(evaluateComputeAllocation(allocation, null, observation([paid("77", -1)], 1170), 1170).reason).toBe("approval_deadline");
    expect(evaluateComputeAllocation(allocation, null, observation([paid("77", 7)], 1590), 1590).reason).toBe("approval_deadline");
    const approved = evaluateComputeAllocation(allocation, null, observation([paid("77", 7)]), 1100);
    expect(evaluateComputeAllocation(allocation, approved, observation([paid("77", 7)], 1590), 1590).phase).toBe("authorised");
    expect(evaluateComputeAllocation(allocation, approved, observation([paid("77", 7)], 3000), 3000).reason).toBe("allocation_expired");
  });
  it("rejects forged discovery, wrong payers, duplicate IDs and disappearing approvals", () => {
    expect(evaluateComputeAllocation(allocation, null, { ...observation([]), discoveryVerified: false }, 1100).reason).toBe("unverifiable_vote");
    expect(evaluateComputeAllocation(allocation, null, observation([paid("77", 1, 9)]), 1100).reason).toBe("unverifiable_vote");
    expect(evaluateComputeAllocation(allocation, null, observation([paid("77", 1), paid("77", 1)]), 1100).reason).toBe("unverifiable_vote");
    const approved = evaluateComputeAllocation(allocation, null, observation([paid("77", 7)]), 1100);
    expect(evaluateComputeAllocation(allocation, approved, observation([paid("77", 1)]), 1100).reason).toBe("unverifiable_vote");
  });
  it("cannot combine discovery with operator-selected proposal IDs", () => {
    expect(ComputeAllocation.safeParse({ ...allocation, requiredProposalIds: ["1"] }).success).toBe(false);
    expect(ComputeAllocation.safeParse({ ...allocation, discovery: undefined }).success).toBe(false);
  });
});
