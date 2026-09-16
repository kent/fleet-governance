import { z } from "zod";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
const timestamp = z.number().int().nonnegative().safe();

export const ProposalDiscovery = z.object({
  taskId: decimal, hook: address, hookCodeHash: hash,
  creditsContract: address, creditsCodeHash: hash, runHash: hash,
  // Historical FPROP allocations and new single-FleetGov bond allocations are distinct.
  proposalToken: z.object({ address, codeHash: hash, initialSupply: z.number().int().min(1).max(40) }).strict().optional(),
  proposalBonds: z.object({ token: address, tokenCodeHash: hash, totalSupply: decimal,
    amount: decimal, cooldownSeconds: z.number().int().min(30).max(600), participationBps: z.number().int().min(1000).max(10000) }).strict().optional(),
  startBlock: decimal, creditsPerAgent: z.number().int().min(1).max(8),
  agents: z.array(address).min(3).max(5),
  proposalCost: z.number().int().min(1).max(8).default(1),
  proposalThreshold: z.number().int().min(1).max(5).default(1),
  allowDelegation: z.boolean().default(true),
  proposalWindowSeconds: z.number().int().min(450).max(900),
  publicationWindowSeconds: z.number().int().min(60).max(120),
}).strict().refine(value => new Set(value.agents.map(a => a.toLowerCase())).size === value.agents.length && value.proposalCost <= value.creditsPerAgent && value.proposalThreshold <= value.agents.length, "Distinct agent identities and attainable proposal rules required.").refine(value => !value.proposalBonds || !value.proposalToken && BigInt(value.proposalBonds.totalSupply) === 5n * 10n ** 18n && BigInt(value.proposalBonds.amount) > 0n && BigInt(value.proposalBonds.amount) <= 10n ** 18n, "Use one fixed-supply FleetGov bond policy.");

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
  nativeStopAt: timestamp.optional(),
  chainId: z.literal(84532),
  governor: address,
  governorCodeHash: hash,
  requiredProposalIds: z.array(decimal).max(64),
  // Optional ordered checkpoints preserve the legacy all-at-once allocation shape.
  // IDs and absolute deadlines are fixed before any agent work starts.
  checkpoints: z.array(z.object({ proposalId: decimal, approvalDeadline: timestamp }).strict()).min(1).max(8).optional(),
  discovery: ProposalDiscovery.optional(),
  maxObservationAgeSeconds: z.number().int().min(5).max(120),
}).strict().superRefine((value, ctx) => {
  if (value.discovery ? value.requiredProposalIds.length !== 0 || !!value.checkpoints : value.requiredProposalIds.length === 0) {
    ctx.addIssue({ code: "custom", message: "Use either fixed proposals or task-scoped discovery, never both." });
  }
  if (!(value.issuedAt < value.approvalDeadline && value.approvalDeadline <= value.stopAt)) {
    ctx.addIssue({ code: "custom", message: "Approval must have a deadline within the allocation." });
  }
  if (value.stopAt - value.issuedAt > 4 * 60 * 60) {
    ctx.addIssue({ code: "custom", message: "A compute allocation cannot exceed four hours." });
  }
  if (value.nativeStopAt !== undefined && (value.nativeStopAt < value.stopAt || value.nativeStopAt - value.issuedAt > 14400)) {
    ctx.addIssue({ code: "custom", message: "Native expiry must bound the fixed allocation within four hours." });
  }
  if (value.checkpoints) {
    if (value.checkpoints.length !== value.requiredProposalIds.length
      || value.checkpoints.some((checkpoint, index) => checkpoint.proposalId !== value.requiredProposalIds[index]
        || checkpoint.approvalDeadline <= (index ? value.checkpoints![index - 1]!.approvalDeadline : value.issuedAt)
        || checkpoint.approvalDeadline > value.approvalDeadline)
      || value.checkpoints.at(-1)!.approvalDeadline !== value.approvalDeadline) {
      ctx.addIssue({ code: "custom", message: "Checkpoints must pin the same ordered proposals with increasing deadlines inside the allocation." });
    }
  }
  if (new Set(value.requiredProposalIds).size !== value.requiredProposalIds.length) {
    ctx.addIssue({ code: "custom", message: "Required proposals must be unique." });
  }
});
export type ComputeAllocation = z.infer<typeof ComputeAllocation>;

export type ComputeHaltReason =
  | "vote_failed" | "approval_deadline" | "allocation_expired"
  | "unverifiable_vote" | "allocation_mismatch" | "unpaid_proposal";
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
  checkpointIndex?: number;
  approvedProposalIds?: string[];
  waitingForProposal?: boolean;
  observedProposalIds?: string[];
};
export type ComputeObservation = {
  chainId: number;
  governor: string;
  governorCodeHash: string;
  blockNumber: string;
  blockHash: string;
  blockTimestamp: number;
  /** Read from Governor.state at the same confirmed block. -1 means its specific nonexistent-proposal error, allowed only for pinned future checkpoints or paid reservations. */
  proposals: { proposalId: string; state: number; proposer?: string; paidAt?: number; creditPaid?: boolean }[];
  discoveryVerified?: boolean;
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
    ...(previous?.allocationId === allocation.allocationId && previous.approvedProposalIds ? {
      approvedProposalIds: previous.approvedProposalIds,
      ...(previous.checkpointIndex !== undefined ? { checkpointIndex: previous.checkpointIndex } : {}),
    } : {}),
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
      || proposals.get(id)! < (allocation.checkpoints ? -1 : 0) || proposals.get(id)! > 7)) return halt("unverifiable_vote");
  if (allocation.discovery) {
    const policy = allocation.discovery;
    if (!observation.discoveryVerified || observation.proposals.length > (policy.proposalBonds ? 64 : policy.agents.length * policy.creditsPerAgent)
      || observation.proposals.some(p => !decimal.safeParse(p.proposalId).success || !Number.isInteger(p.state) || p.state < -1 || p.state > 7)) return halt("unverifiable_vote");
    // Discovery is monotonic. A worker cannot drop a rejected proposal from its status
    // file, and a reorg cannot quietly remove a proposal the Guardian already observed.
    if (previous?.observedProposalIds?.some(id => !proposals.has(id))) return halt("unverifiable_vote");
    const unpaid = observation.proposals.find(p => !p.creditPaid);
    if (unpaid) return halt("unpaid_proposal", unpaid.proposalId);
    const spent = new Map<string, number>();
    for (const p of observation.proposals) {
      const payer = p.proposer?.toLowerCase();
      if (!payer || !policy.agents.some(a => a.toLowerCase() === payer)
        || !Number.isSafeInteger(p.paidAt) || p.paidAt! < allocation.issuedAt - 120 || p.paidAt! > observation.blockTimestamp) return halt("unverifiable_vote");
      spent.set(payer, (spent.get(payer) ?? 0) + policy.proposalCost);
      if (!policy.proposalBonds && spent.get(payer)! > policy.creditsPerAgent) return halt("unverifiable_vote");
      if ([2, 3, 6].includes(p.state)) return halt("vote_failed", p.proposalId);
      if (p.state === -1 && now >= p.paidAt! + policy.publicationWindowSeconds) return halt("approval_deadline", p.proposalId);
      if (now >= Math.min(allocation.stopAt, p.paidAt! + policy.proposalWindowSeconds)
        && !previous?.approvedProposalIds?.includes(p.proposalId)) return halt("approval_deadline", p.proposalId);
    }
    const approved = observation.proposals.filter(p => p.state === 7).map(p => p.proposalId);
    if (previous?.approvedProposalIds?.some(id => proposals.get(id) !== 7)) return halt("unverifiable_vote");
    const pending = observation.proposals.some(p => p.state !== 7);
    return { allocationId: allocation.allocationId, phase: pending ? "voting" : "authorised", observedAt: now,
      approvedProposalIds: approved, observedProposalIds: observation.proposals.map(p => p.proposalId),
      waitingForProposal: !pending, ...(approved.length ? { authorisedAt: previous?.authorisedAt ?? now } : {}),
      blockNumber: observation.blockNumber, blockHash: observation.blockHash };
  }
  // OpenZeppelin Governor: Canceled=2, Defeated=3, Expired=6. Abstention, a tie and
  // insufficient quorum become Defeated through the Governor's own voting rules.
  const failed = allocation.requiredProposalIds.find(id => [2, 3, 6].includes(proposals.get(id)!));
  if (failed) return halt("vote_failed", failed);
  if (allocation.checkpoints) {
    const approvedBefore = previous?.approvedProposalIds ?? [];
    // Recorded approval can never be silently lost or rearranged after a reorg.
    if (approvedBefore.some((id, index) => id !== allocation.requiredProposalIds[index] || proposals.get(id) !== 7)) return halt("unverifiable_vote");
    for (const checkpoint of allocation.checkpoints) {
      if (now >= checkpoint.approvalDeadline && !approvedBefore.includes(checkpoint.proposalId)) return halt("approval_deadline", checkpoint.proposalId);
    }
    const firstUnsettled = allocation.requiredProposalIds.findIndex(id => proposals.get(id) !== 7);
    const checkpointIndex = firstUnsettled === -1 ? allocation.requiredProposalIds.length : firstUnsettled;
    // No second vote may get ahead of the first. Extra unrelated proposals never grant authority.
    if (allocation.requiredProposalIds.slice(checkpointIndex + 1).some(id => proposals.get(id) !== -1)) return halt("unverifiable_vote");
    const waitingForProposal = firstUnsettled !== -1 && proposals.get(allocation.requiredProposalIds[checkpointIndex]!) === -1;
    return {
      allocationId: allocation.allocationId,
      phase: waitingForProposal || firstUnsettled === -1 ? "authorised" : "voting",
      observedAt: now, checkpointIndex, approvedProposalIds: allocation.requiredProposalIds.slice(0, checkpointIndex), waitingForProposal,
      // This timestamp does not grant every later action. Dispatch checks its exact checkpoint.
      ...(checkpointIndex > 0 ? { authorisedAt: previous?.authorisedAt ?? now } : {}),
      blockNumber: observation.blockNumber, blockHash: observation.blockHash,
    };
  }
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

/** Only initial bounded lab work may use generic task authority between checkpoints.
 * Every governed action must additionally match its own settled checkpoint. */
export function permitsCheckpointExecution(state: ComputeState, allocation: ComputeAllocation, proposalId: string, now: number): boolean {
  return (!!allocation.discovery || !!allocation.checkpoints && allocation.requiredProposalIds.includes(proposalId))
    && permitsTaskExecution(state, allocation, now) && !!state.approvedProposalIds?.includes(proposalId);
}
