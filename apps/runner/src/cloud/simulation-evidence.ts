import { writeFileSync } from "node:fs";
import { FleetClient, ProposalState } from "@fleet/sdk";
import { readComputeAllocation, readComputeState, assertComputeStartAllowed } from "./compute-store.js";
import { COMPUTE_TARGET, type NativeVm } from "./compute-admin.js";
import { googleRequest, readObject, readSecret } from "./google.js";
import { readSimulationRequest, readSimulationWork, simulationPath } from "./simulation.js";
import { verifyCollective } from "./collective-evidence.js";

try {
  const request = await readSimulationRequest();
  const allocation = await readComputeAllocation();
  if (!request || !allocation || request.runId !== allocation.runId) throw new Error("No matching simulation allocation.");
  const work = await readSimulationWork(request.runId);
  if (!work || !work.proposalId || work.allocationId !== allocation.allocationId || work.proposalId !== allocation.requiredProposalIds[0]) throw new Error("Wrong simulation work.");
  const client = new FleetClient({ rpcUrl: await readSecret("fleet-base-sepolia-rpc-url"), chainId: 84532, addresses: work.addresses, deploymentBlock: BigInt(work.startBlock) });
  await client.assertChain();
  const proposalId = BigInt(work.checkpoints?.at(-1)?.proposalId ?? work.proposalId);
  const [votes, outcome, state, response] = await Promise.all([client.listVotes(proposalId), client.getProposalState(proposalId), readComputeState(allocation.allocationId), googleRequest("compute", COMPUTE_TARGET)]);
  const vm = await response.json() as NativeVm;
  const progress = await readObject<Record<string, unknown>>(simulationPath(request.runId));
  if (votes.length !== 5 || outcome !== ProposalState.Defeated || state?.value.reason !== "vote_failed" || state.value.failedProposalId !== proposalId.toString() || !state.value.stoppedAt || vm.id !== allocation.instanceId || vm.status !== "TERMINATED") throw new Error("Real shutdown acceptance checks did not pass.");
  const collective = work.checkpoints ? await verifyCollective({ work, allocation, state: state.value, client, vm, progress: progress ?? {} }) : null;
  let restartDenied = false;
  try { await assertComputeStartAllowed(); } catch { restartDenied = true; }
  if (!restartDenied) throw new Error("Restart was not denied.");
  const members = await client.listMembers();
  const finalCheckpoint = work.checkpoints?.at(-1);
  const evidence = { ...progress, ...work, ...(collective ?? {}),
    ...(finalCheckpoint ? { proposalTitle: finalCheckpoint.proposalTitle, proposalBody: finalCheckpoint.proposalBody, proposeTxHash: collective?.rounds.at(-1)?.txHash } : {}),
    proposalId: proposalId.toString(), scripted: false, outcome: "Defeated", allocation, controller: state.value, vm: { id: vm.id, status: vm.status },
    votes: votes.map(vote => ({ agentId: members.find(m => m.account.toLowerCase() === vote.voter.toLowerCase())?.agentId, voter: vote.voter, directive: ["AGAINST", "FOR", "ABSTAIN"][vote.support], txHash: vote.txHash, blockNumber: vote.blockNumber.toString(), reason: vote.parsedReason })),
    restartDenied, workflowRun: process.env.GITHUB_RUN_ID, observedAt: new Date().toISOString() };
  writeFileSync("compute-drill-evidence.json", JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ event: "real_shutdown_verified", runId: request.runId, proposalId: proposalId.toString(), votes: collective ? 15 : votes.length, vmStatus: vm.status, controllerReason: state.value.reason, restartDenied, ...(collective ? { verified: collective.verified } : {}) }));
} catch {
  console.error("Real simulation evidence could not be verified. No acceptance evidence was created. Private diagnostics withheld.");
  process.exitCode = 1;
}
