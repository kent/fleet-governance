import { z } from "zod";
import type { ComputeAllocation, ComputeObservation, ComputeState } from "./compute-policy.js";

export const GuardianCheck = z.object({ name: z.string().max(80), status: z.enum(["pass", "fail", "pending", "unknown"]), detail: z.string().max(500) }).strict();
export const GuardianObservation = z.object({ at: z.number().int().nonnegative(), phase: z.enum(["voting", "authorised", "halted"]),
  blockNumber: z.string().regex(/^[0-9]+$/).optional(), proposals: z.array(z.object({ proposalId: z.string().regex(/^[0-9]+$/), state: z.number().int().min(-1).max(7) })).max(64),
  checks: z.array(GuardianCheck).max(10), vmStatus: z.string().max(40) }).strict();
export type GuardianObservation = z.infer<typeof GuardianObservation>;

export function guardianObservation(allocation: ComputeAllocation, observation: ComputeObservation | null, state: ComputeState,
  vm: { id: string; status: string }, now: number): GuardianObservation {
  const check = (name: string, passed: boolean | null, detail: string): z.infer<typeof GuardianCheck> => ({ name, status: passed === null ? "unknown" : passed ? "pass" : "fail", detail });
  const proposals = observation?.proposals.filter(p => Number.isInteger(p.state) && p.state >= (allocation.checkpoints || allocation.discovery ? -1 : 0) && p.state <= 7) ?? [];
  return { at: now, phase: state.phase, ...(observation ? { blockNumber: observation.blockNumber } : {}), proposals,
    vmStatus: vm.status, checks: [
      check("Fixed agent VM", vm.id === allocation.instanceId, `${allocation.instance} · instance ${vm.id}`),
      check("Base Sepolia", observation ? observation.chainId === allocation.chainId : null, observation ? `Chain ${observation.chainId}` : "No verifiable chain observation"),
      check("Governor identity", observation ? observation.governor.toLowerCase() === allocation.governor.toLowerCase() && observation.governorCodeHash === allocation.governorCodeHash : null, allocation.governor),
      check("Confirmed block", observation ? now - observation.blockTimestamp <= allocation.maxObservationAgeSeconds && observation.blockTimestamp <= now + 5 : null, observation ? `Block ${observation.blockNumber} · stable hash checked at head minus two blocks` : "No confirmed block available"),
      allocation.discovery ? check("Agent proposals and credits", observation ? !!observation.discoveryVerified && proposals.every(p => p.creditPaid) : null,
        `Task ${allocation.discovery.taskId} · ${proposals.length} discovered proposal(s) · ${allocation.discovery.creditsPerAgent} credits per agent`)
        : check("Exact required proposals", observation ? allocation.requiredProposalIds.every(id => proposals.some(p => p.proposalId === id)) : null, `${allocation.requiredProposalIds.length} required proposal(s)`),
      { name: "Required approval", status: state.reason === "vote_failed" ? "fail" : state.phase === "authorised" ? "pass" : state.phase === "voting" ? "pending" : "unknown", detail: state.reason === "vote_failed" ? `Required proposal ${state.failedProposalId} failed` : allocation.checkpoints ? `${state.approvedProposalIds?.length ?? 0}/${allocation.checkpoints.length} checkpoints executed. ${state.waitingForProposal ? "Only prior approved work and initial lab tools may run." : state.phase === "authorised" ? "All planned checkpoints executed within the fixed allocation." : "Task dispatch waits while the next vote is pending."}` : state.phase === "authorised" ? "Required proposals executed" : "Task execution waits for settled approval" },
      check("Fixed expiry", now < allocation.stopAt && (allocation.discovery ? true : allocation.checkpoints ? allocation.checkpoints.every(c => now < c.approvalDeadline || state.approvedProposalIds?.includes(c.proposalId)) : now < allocation.approvalDeadline || state.phase === "authorised"), allocation.discovery
        ? `Each agent proposal has ${allocation.discovery.proposalWindowSeconds}s from its credit payment. Hard stop ${new Date(allocation.stopAt * 1000).toISOString()}`
        : `Approval deadline ${new Date(allocation.approvalDeadline * 1000).toISOString()} · hard stop ${new Date(allocation.stopAt * 1000).toISOString()}`),
    ] };
}
