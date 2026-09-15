import { z } from "zod";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
const timestamp = z.number().int().nonnegative().safe();

/** Written by human-authorised control software, never by the agent worker. A vote may
 * satisfy this allocation, but cannot edit its deadline, worker, or required proposals. */
export const ComputeAllocation = z.object({
  schema: z.literal("fleet.compute-allocation.v1"),
  allocationId: z.string().uuid(),
  runId: z.string().regex(/^run-[0-9a-f-]{36}$/),
  project: z.literal("fleet-governance"),
  zone: z.literal("us-central1-a"),
  instance: z.string().regex(/^fleet-(research|execution-[a-z0-9-]{1,40})$/),
  instanceId: decimal,
  issuedAt: timestamp,
  approvalDeadline: timestamp,
  stopAt: timestamp,
  chainId: z.literal(84532),
  governor: address,
  governorCodeHash: hash,
  requiredProposalIds: z.array(decimal).min(1).max(64),
  maxObservationAgeSeconds: z.number().int().min(5).max(120),
}).strict().superRefine((value, ctx) => {
  if (!(value.issuedAt < value.approvalDeadline && value.approvalDeadline <= value.stopAt)) {
    ctx.addIssue({ code: "custom", message: "Approval must have a deadline within the allocation." });
  }
  if (value.stopAt - value.issuedAt > 4 * 60 * 60) {
    ctx.addIssue({ code: "custom", message: "A compute allocation cannot exceed four hours." });
  }
  if (new Set(value.requiredProposalIds).size !== value.requiredProposalIds.length) {
    ctx.addIssue({ code: "custom", message: "Required proposals must be unique." });
  }
});
export type ComputeAllocation = z.infer<typeof ComputeAllocation>;

export type ComputeHaltReason =
  | "vote_failed" | "approval_deadline" | "allocation_expired"
  | "unverifiable_vote" | "allocation_mismatch";
export type ComputeState = {
  allocationId: string;
  phase: "voting" | "authorised" | "halted";
  observedAt: number;
  authorisedAt?: number;
  haltedAt?: number;
  reason?: ComputeHaltReason;
  failedProposalId?: string;
  blockNumber?: string;
  blockHash?: string;
};
export type ComputeObservation = {
  chainId: number;
  governor: string;
  governorCodeHash: string;
  blockNumber: string;
  blockHash: string;
  blockTimestamp: number;
  /** Read from Governor.state at the same confirmed block, never from model output. */
  proposals: { proposalId: string; state: number }[];
};

/** This is an authority decision, not a model judgment. Terminal stops are irreversible
 * within one allocation. A human can authorise a different allocation separately. */
export function evaluateComputeAllocation(
  allocation: ComputeAllocation,
  previous: ComputeState | null,
  observation: ComputeObservation | null,
  now: number,
): ComputeState {
  const halt = (reason: ComputeHaltReason, failedProposalId?: string): ComputeState => ({
    allocationId: allocation.allocationId, phase: "halted", observedAt: now, haltedAt: now,
    reason, ...(failedProposalId ? { failedProposalId } : {}),
  });
  if (previous && previous.allocationId !== allocation.allocationId) return halt("allocation_mismatch");
  if (previous?.phase === "halted") return previous;
  if (now >= allocation.stopAt) return halt("allocation_expired");
  if (now < allocation.issuedAt || !observation
    || observation.chainId !== allocation.chainId
    || observation.governor.toLowerCase() !== allocation.governor.toLowerCase()
    || observation.governorCodeHash.toLowerCase() !== allocation.governorCodeHash.toLowerCase()
    || !hash.safeParse(observation.blockHash).success
    || !decimal.safeParse(observation.blockNumber).success
    || observation.blockTimestamp > now + 5
    || now - observation.blockTimestamp > allocation.maxObservationAgeSeconds) {
    return halt("unverifiable_vote");
  }
  const proposals = new Map(observation.proposals.map(proposal => [proposal.proposalId, proposal.state]));
  if (proposals.size !== observation.proposals.length
    || allocation.requiredProposalIds.some(id => !Number.isInteger(proposals.get(id))
      || proposals.get(id)! < 0 || proposals.get(id)! > 7)) return halt("unverifiable_vote");
  // OpenZeppelin Governor: Canceled=2, Defeated=3, Expired=6. Abstention, a tie and
  // insufficient quorum become Defeated through the Governor's own voting rules.
  const failed = allocation.requiredProposalIds.find(id => [2, 3, 6].includes(proposals.get(id)!));
  if (failed) return halt("vote_failed", failed);
  const settled = allocation.requiredProposalIds.every(id => proposals.get(id) === 7);
  // If we missed the deadline, do not accept a late observation as evidence that a vote
  // settled on time. Only an earlier recorded authorisation can continue to stopAt.
  if (now >= allocation.approvalDeadline && previous?.phase !== "authorised") return halt("approval_deadline");
  if (!settled && previous?.phase === "authorised") return halt("unverifiable_vote");
  return {
    allocationId: allocation.allocationId,
    phase: settled ? "authorised" : "voting",
    observedAt: now,
    ...(settled ? { authorisedAt: previous?.authorisedAt ?? now } : {}),
    blockNumber: observation.blockNumber, blockHash: observation.blockHash,
  };
}

export function permitsTaskExecution(state: ComputeState, allocation: ComputeAllocation, now: number): boolean {
  return state.allocationId === allocation.allocationId && state.phase === "authorised"
    && now >= state.observedAt && now < allocation.stopAt
    && now - state.observedAt <= allocation.maxObservationAgeSeconds;
}
