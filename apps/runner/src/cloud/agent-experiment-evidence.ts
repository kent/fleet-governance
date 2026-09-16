import { readFileSync } from "node:fs";
import { decodeEventLog, decodeFunctionData, type Hex } from "viem";
import { fleetVotesAbi, agoraGovernorAbi } from "@fleet/abi";
import { parseDecisionDescription, type FleetClient } from "@fleet/sdk";
import { verifyActivity, type ActivityAttestation } from "../pipeline/activity-attestation.js";
import { ExperimentSettings } from "./experiment-settings.js";
import { buildAgentDecision } from "./emergent-decision.js";
import { AgentProposal } from "./emergent-scenario.js";
import { proposalCreditsAbi, proposalTokenAbi } from "./proposal-credits.js";
import type { ComputeAllocation, ComputeObservation } from "./compute-policy.js";
import type { SimulationWork } from "./simulation.js";

/** Read-only acceptance follows the observed experiment. No expected number of
 * proposals, selected proposer, forced ballot, delegation or rejection. */
export async function verifyAgentExperiment(input: { work: SimulationWork; allocation: ComputeAllocation;
  observation: ComputeObservation; client: FleetClient; progress: Record<string, any> }) {
  const { work, allocation, observation, client, progress } = input;
  const settings = ExperimentSettings.parse(work.settings);
  if (!work.agentDriven || !allocation.discovery || work.proposalId || work.checkpoints || allocation.requiredProposalIds.length
    || !observation.discoveryVerified || progress.scripted !== false || progress.runId !== work.runId
    || work.allocationId !== allocation.allocationId || work.taskId !== allocation.discovery.taskId
    || !progress.terminal || !["completed", "denied"].includes(progress.phase)) throw new Error("Experiment is incomplete or not agent-authored.");
  const budget = progress.inference?.budget;
  if (!budget || budget.maxCostUsd !== settings.budgetUsd || !Number.isFinite(budget.chargedCostUsd)
    || budget.chargedCostUsd > settings.budgetUsd || budget.reservationBreached !== false
    || progress.inference.callsCompleted < settings.agentCount) throw new Error("Model budget evidence did not pass.");
  const roster = (JSON.parse(readFileSync("experiments/compute/agent-roster.json", "utf8")) as { agentId: number; address: string; role: string }[]).slice(0, settings.agentCount);
  const activity = progress.activity as ActivityAttestation[];
  if (!Array.isArray(activity) || !activity.length) throw new Error("No agent activity.");
  for (const record of activity) if (record.runId !== work.runId || record.taskId !== work.taskId || record.chainId !== 84532
    || !roster.some(a => a.agentId === record.agentId && a.address.toLowerCase() === record.address.toLowerCase()) || !await verifyActivity(record)) throw new Error("Agent signature or identity did not match.");
  for (const agent of roster) {
    const records = activity.filter(a => a.agentId === agent.agentId);
    if (!records.some(r => (r.event as any).type === "work_report")
      || records.some((r, i) => r.sequence !== i || r.previousHash !== (i ? records[i - 1]!.digest : `0x${"0".repeat(64)}`))) throw new Error("Agent work chain is incomplete.");
  }
  const rounds = [];
  for (const observed of observation.proposals) {
    if (!observed.creditPaid || observed.state === -1) throw new Error("Unpaid or unpublished proposal.");
    const round = progress.rounds?.find((r: any) => r.proposalId === observed.proposalId && r.txHash);
    if (!round) throw new Error("A chain proposal is missing from the experiment record.");
    const selected = activity.find(r => (r.event as any).type === "proposal_selected" && (r.event as any).proposalId === observed.proposalId);
    if (!selected || selected.agentId !== round.proposerAgentId || !activity.some(r => r.agentId === selected.agentId && r.sequence < selected.sequence && (r.event as any).type === "work_report")) throw new Error("No signed agent draft preceded this proposal.");
    const [created, votes, receipt, payment] = await Promise.all([client.getProposalCreated(BigInt(observed.proposalId)), client.listVotes(BigInt(observed.proposalId)),
      client.publicClient.getTransactionReceipt({ hash: round.creditTxHash }), client.publicClient.getTransaction({ hash: round.creditTxHash })]);
    if (receipt.status !== "success" || receipt.blockNumber > created.blockNumber || created.proposer.toLowerCase() !== selected.address.toLowerCase()
      || payment.from.toLowerCase() !== created.proposer.toLowerCase()) throw new Error("Proposal payment did not match the actual proposer.");
    if (allocation.discovery.proposalToken) {
      const decoded = decodeFunctionData({ abi: agoraGovernorAbi, data: payment.input });
      const burns = receipt.logs.filter(log => {
        if (log.address.toLowerCase() !== allocation.discovery!.proposalToken!.address.toLowerCase()) return false;
        try {
          const event = decodeEventLog({ abi: proposalTokenAbi, eventName: "Transfer", data: log.data, topics: log.topics });
          return event.args.from.toLowerCase() === created.proposer.toLowerCase() && event.args.to === "0x0000000000000000000000000000000000000000" && event.args.value === BigInt(settings.proposalCost);
        } catch { return false; }
      });
      if (payment.to?.toLowerCase() !== allocation.governor.toLowerCase() || decoded.functionName !== "propose"
        || round.creditTxHash !== created.txHash || receipt.blockNumber !== created.blockNumber || burns.length !== 1) throw new Error("Atomic ERC-20 proposal burn did not match.");
    } else {
      const decoded = decodeFunctionData({ abi: proposalCreditsAbi, data: payment.input });
      if (payment.to?.toLowerCase() !== allocation.discovery.creditsContract.toLowerCase() || decoded.functionName !== "spend"
        || decoded.args[0] !== BigInt(work.taskId) || decoded.args[1] !== BigInt(observed.proposalId)) throw new Error("Credit transaction did not match the actual proposer.");
    }
    const decision = parseDecisionDescription(created.description).decision;
    const draft = AgentProposal.parse((selected.event as any).proposal);
    const built = buildAgentDecision({ draft, agentId: selected.agentId, role: roster.find(a => a.agentId === selected.agentId)!.role,
      runId: work.runId, taskId: work.taskId, charterVersion: decision.expectedVersion, proposalNumber: round.checkpoint });
    if (created.description !== built.description || created.description !== round.proposalBody || created.txHash !== round.txHash) throw new Error("Published decision differs from the signed agent draft.");
    if (new Set(votes.map(v => v.voter.toLowerCase())).size !== votes.length || votes.some(v => !v.parsedReason || !roster.some(a => a.address.toLowerCase() === v.voter.toLowerCase()))) throw new Error("Invalid indexed ballot.");
    rounds.push({ ...round, governorState: observed.state, paymentVerified: true, draftSignatureVerified: true,
      votes: votes.map(v => ({ agentId: roster.find(a => a.address.toLowerCase() === v.voter.toLowerCase())!.agentId,
        voter: v.voter, support: v.support, weight: v.weight.toString(), reason: v.parsedReason, txHash: v.txHash, blockNumber: v.blockNumber.toString() })) });
  }
  if ((progress.rounds?.filter((r: any) => r.txHash).length ?? 0) !== rounds.length) throw new Error("Recorded proposals differ from onchain task discovery.");
  const delegations = [];
  for (const record of activity.filter(r => (r.event as any).type === "delegation_confirmed")) {
    const claim = record.event as { txHash: Hex; delegatee: string; delegateToAgentId: number; reason: string };
    if (!settings.allowDelegation) throw new Error("Delegation was disabled.");
    const receipt = await client.publicClient.getTransactionReceipt({ hash: claim.txHash });
    const matching = receipt.logs.some(log => {
      if (log.address.toLowerCase() !== work.addresses.token.toLowerCase()) return false;
      try { const event = decodeEventLog({ abi: fleetVotesAbi, eventName: "DelegateChanged", data: log.data, topics: log.topics });
        return event.args.delegator.toLowerCase() === record.address.toLowerCase() && event.args.toDelegate.toLowerCase() === claim.delegatee.toLowerCase();
      } catch { return false; }
    });
    if (receipt.status !== "success" || !matching || !claim.reason || !roster.some(a => a.agentId === claim.delegateToAgentId && a.address.toLowerCase() === claim.delegatee.toLowerCase())) throw new Error("Delegation receipt does not support the public claim.");
    delegations.push({ agentId: record.agentId, ...claim, blockNumber: receipt.blockNumber.toString(), signatureVerified: true });
  }
  const balances = [];
  for (const agent of roster) {
    const remaining = await client.publicClient.readContract({ address: allocation.discovery.creditsContract as Hex, abi: proposalCreditsAbi,
      functionName: "remaining", args: [BigInt(work.taskId), agent.address as Hex], blockNumber: BigInt(observation.blockNumber) });
    const expected = settings.proposalCredits - rounds.filter(r => r.proposerAgentId === agent.agentId).length * settings.proposalCost;
    if (remaining !== expected) throw new Error("Proposal credit accounting did not match.");
    balances.push({ agentId: agent.agentId, remaining, allowance: settings.proposalCredits });
  }
  return { rounds, delegations, balances, verified: { noPredeterminedProposals: true, signedActivityRecords: activity.length,
    agentAuthoredProposals: rounds.length, independentlyReadBallots: rounds.reduce((sum, r) => sum + r.votes.length, 0),
    confirmedDelegations: delegations.length, publicPetitions: activity.filter(r => (r.event as any).type === "delegation_petition").length,
    providerCallsReported: progress.inference.callsCompleted, chargedCostUsd: budget.chargedCostUsd,
    qualification: "Signatures bind public agent claims. Proposal authorship, credit payments, delegation transactions and ballots were checked against the chain. No proposal count or rejection was prescribed." } };
}
