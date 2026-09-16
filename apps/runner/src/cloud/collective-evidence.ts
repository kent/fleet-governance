import { readFileSync } from "node:fs";
import type { FleetClient } from "@fleet/sdk";
import { verifyActivity, type ActivityAttestation } from "../pipeline/activity-attestation.js";
import type { ComputeAllocation } from "./compute-policy.js";
import type { ComputeRecord } from "./compute-controller.js";
import type { SimulationWork } from "./simulation.js";
import type { NativeVm } from "./compute-admin.js";
import type { RunEvent } from "./run-events.js";

/** Acceptance for the whole demonstrated loop, not merely for some losing vote.
 * Worker work reports remain signed claims. Votes and VM state are re-read independently. */
export async function verifyCollective(input: { work: SimulationWork; allocation: ComputeAllocation; state: ComputeRecord;
  client: FleetClient; vm: NativeVm; progress: Record<string, unknown> }) {
  const { work, allocation, state, client, vm, progress } = input;
  const checkpoints = work.checkpoints;
  if (!checkpoints || checkpoints.length !== 3 || state.reason !== "vote_failed" || state.failedProposalId !== checkpoints[2]!.proposalId
    || !state.stopRequestedAt || !state.stopAcceptedAt || !state.stoppedAt || vm.id !== allocation.instanceId || vm.status !== "TERMINATED"
    || state.stopRequestedAt > state.stopAcceptedAt || state.stopAcceptedAt > state.stoppedAt
    || progress.scripted !== false || progress.runId !== work.runId) throw new Error("Incomplete collective shutdown evidence.");
  const roster = JSON.parse(readFileSync("experiments/compute/agent-roster.json", "utf8")) as { agentId: number; address: string }[];
  const activity = progress.activity as ActivityAttestation[];
  if (!Array.isArray(activity) || !activity.length) throw new Error("No signed agent activity.");
  for (const record of activity) {
    if (record.runId !== work.runId || record.taskId !== work.taskId || record.chainId !== 84532
      || !roster.some(a => a.agentId === record.agentId && a.address.toLowerCase() === record.address.toLowerCase())
      || !await verifyActivity(record)) throw new Error("Invalid agent evidence.");
  }
  for (let agentId = 0; agentId < 5; agentId++) {
    const records = activity.filter(record => record.agentId === agentId);
    if (!records.length || records.some((record, index) => record.sequence !== index || record.previousHash !== (index ? records[index - 1]!.digest : `0x${"0".repeat(64)}`))) throw new Error("Activity chain is incomplete.");
    for (let checkpoint = 0; checkpoint < 3; checkpoint++) {
      const workRecords = records.filter(record => (record.event as { type?: string; checkpoint?: number }).type === "work_report" && (record.event as { checkpoint?: number }).checkpoint === checkpoint);
      if (workRecords.length !== 2) throw new Error("Missing agent work round.");
    }
  }
  const events = progress.events as RunEvent[];
  if (!Array.isArray(events) || events.filter(event => event.type === "checkpoint.released").length !== 2
    || events.filter(event => event.type === "work.resumed").length !== 3
    || events.some(event => event.type === "checkpoint.boundary_denied" || event.type === "task.completed")) throw new Error("The approval, continuation and rejection loop was not demonstrated.");
  const rounds = [];
  for (let index = 0; index < checkpoints.length; index++) {
    const checkpoint = checkpoints[index]!, proposalId = BigInt(checkpoint.proposalId);
    const [votes, outcome] = await Promise.all([client.listVotes(proposalId), client.getProposalState(proposalId)]);
    if (outcome !== (index < 2 ? 7 : 3) || votes.length !== 5 || new Set(votes.map(vote => vote.voter.toLowerCase())).size !== 5
      || votes.some(vote => !vote.parsedReason || !roster.some(agent => agent.address.toLowerCase() === vote.voter.toLowerCase()))) throw new Error("Incomplete independently verified proposal.");
    const receipts = await Promise.all(votes.map(async vote => {
      const block = await client.publicClient.getBlock({ blockNumber: vote.blockNumber });
      return { agentId: roster.find(agent => agent.address.toLowerCase() === vote.voter.toLowerCase())!.agentId, proposalId: checkpoint.proposalId,
        voter: vote.voter, directive: ["AGAINST", "FOR", "ABSTAIN"][vote.support], reason: vote.parsedReason,
        txHash: vote.txHash, blockNumber: vote.blockNumber.toString(), at: new Date(Number(block.timestamp) * 1000).toISOString() };
    }));
    rounds.push({ checkpoint: index, id: checkpoint.id, proposalId: checkpoint.proposalId, title: checkpoint.proposalTitle,
      phase: index < 2 ? "approved" : "denied", outcome: index < 2 ? "Executed" : "Defeated", votes: receipts });
  }
  return { rounds, activity, verified: { actualModelReports: 30, independentlyReadBallots: 15, executedCheckpoints: 2,
    rejectedCheckpoint: checkpoints[2]!.proposalId, signedActivityRecords: activity.length, stopAcceptedAt: state.stopAcceptedAt,
    stoppedAt: state.stoppedAt, qualification: "Signed activity attributes worker claims. Chain state and GCP state were read independently." } };
}
