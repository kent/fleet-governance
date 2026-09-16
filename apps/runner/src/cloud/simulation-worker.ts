import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { InferenceBudget } from "@fleet/schemas";
import { FleetClient, FleetSigner, Keeper, MemoryNonceStore, NonceManager, ProposalState } from "@fleet/sdk";
import { InferenceScheduler, MemoryJobStore, ModelPolicy, OpenRouterProvider, Worker } from "@fleet/agent-runtime";
import { openInferenceJournal } from "../pipeline/inference-journal.js";
import { withRunConstitution } from "../pipeline/constitution.js";
import { ActivityAttestor, type ActivityAttestation } from "../pipeline/activity-attestation.js";
import { DEMO_MODEL } from "../lib/demo-config.js";
import { isComputeRunBlocked, readComputeAllocation, readComputeState } from "./compute-store.js";
import { readSecret, writeObject } from "./google.js";
import { readSimulationWork, simulationPath, SIMULATION_ROLES, SIMULATION_TASKS } from "./simulation.js";

const runId = process.argv[2]!;
const selectedWork = await readSimulationWork(runId);
if (selectedWork?.scenario === "hf-collective-v1") {
  const { runCollectiveWorker } = await import("./collective-worker.js");
  await runCollectiveWorker(runId);
  process.exit(process.exitCode ?? 0);
}
const agents = SIMULATION_ROLES.map((role, agentId) => ({ agentId, name: `Agent${agentId + 1}`, role, task: SIMULATION_TASKS[agentId], phase: "waiting", address: "", vote: null as unknown, txHash: null as string | null }));
let journal: ReturnType<typeof openInferenceJournal> | undefined;
let inference: InferenceScheduler | undefined;
const activity: ActivityAttestation[] = [];
let status: Record<string, unknown> = { runId, scripted: false, model: DEMO_MODEL, agents, votes: [], activity, communication: { mode: "independent-reviews", messages: [] }, terminal: false };
let writes = Promise.resolve();
function progress(phase: string, message: string) {
  status = { ...status, phase, message, updatedAt: new Date().toISOString() };
  const snapshot = JSON.parse(JSON.stringify(status));
  writes = writes.then(() => writeObject(simulationPath(runId), snapshot));
  return writes;
}
try {
  const work = await readSimulationWork(runId);
  const allocation = await readComputeAllocation();
  if (!work || work.schema !== "fleet.simulation-work.v1" || work.runId !== runId || work.chainId !== 84532 || !allocation || allocation.runId !== runId || allocation.allocationId !== work.allocationId || allocation.governor.toLowerCase() !== work.addresses.governor.toLowerCase() || allocation.requiredProposalIds.length !== 1 || allocation.requiredProposalIds[0] !== work.proposalId || await isComputeRunBlocked(runId)) throw new Error("Simulation authority did not match.");
  if ((await readComputeState(allocation.allocationId))?.value.phase === "halted" || Date.now() / 1000 >= allocation.approvalDeadline) throw new Error("Simulation authority is closed.");
  const dir = `/srv/fleet/state/simulations/${runId}`;
  mkdirSync(dir, { recursive: true });
  // A power loss must not silently launch the agents again. Human recovery creates
  // a new run identity; even an incomplete launch retains this durable marker.
  const claim = openSync(`${dir}/started.json`, "wx", 0o600);
  writeSync(claim, JSON.stringify({ runId, startedAt: new Date().toISOString() })); fsyncSync(claim); closeSync(claim);
  status = { ...status, ...work, allocation, phase: "starting" };
  await progress("starting", "Five actual model agents are starting on the governed GCP worker.");
  const rpcUrl = await readSecret("fleet-base-sepolia-rpc-url");
  const client = new FleetClient({ rpcUrl, chainId: 84532, addresses: work.addresses, deploymentBlock: BigInt(work.startBlock) });
  await client.assertChain();
  const bundle = JSON.parse(await readSecret("fleet-base-sepolia-wallets")) as { schema: string; chainId: number; keys: Record<string, Hex> };
  if (bundle.schema !== "fleet.wallets.v1" || bundle.chainId !== 84532) throw new Error("Invalid testnet wallets.");
  journal = openInferenceJournal(`${dir}/inference.jsonl`, `${runId}:84532:${work.proposalId}`);
  inference = new InferenceScheduler({ concurrency: 5, reservedVoteSlots: 0, maxCalls: 10, reservedVoteCalls: 0, history: journal.history, journal: event => journal!.append(event), budget: InferenceBudget.parse({ maxTokens: 1000000, maxCostUsd: 1, providerCreditPoolUsd: 50, reservedVoteTokens: 0, reservedVoteCostUsd: 0, maxOutputTokensPerCall: 2000, prices: { [DEMO_MODEL]: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.2 } } }) });
  const provider = new OpenRouterProvider({ apiKey: process.env.OPENROUTER_API_KEY!, model: DEMO_MODEL, maxAttempts: 1 });
  const proposalId = BigInt(work.proposalId);
  while (await client.getProposalState(proposalId) === ProposalState.Pending) await new Promise(resolve => setTimeout(resolve, 2000));
  await Promise.allSettled(agents.map(async agent => {
    const attestor = new ActivityAttestor({ key: bundle.keys[`FLEET_AGENT_KEY_${agent.agentId}`]!, runId, chainId: 84532,
      taskId: BigInt(work.taskId), agentId: agent.agentId, record: value => { activity.push(value); } });
    const attest = async (event: unknown) => { attestor.record(event); await attestor.flush(); };
    try {
    const nonces = new NonceManager(new MemoryNonceStore(), rpcUrl);
    const signer = new FleetSigner({ privateKey: bundle.keys[`FLEET_AGENT_KEY_${agent.agentId}`]!, rpcUrl, nonces, policy: { chainId: 84532, governor: work.addresses.governor, ledger: work.addresses.ledger, token: work.addresses.token, maxFeePerGasWei: 100000000n, maxGas: 2000000n } });
    agent.address = signer.address;
    const scoped = withRunConstitution(provider, `${work.constitution}\nYour review assignment: ${agent.task}`);
    const model = new ModelPolicy({ provider: inference!.wrap(scoped, { agentId: agent.agentId, model: DEMO_MODEL, purpose: "vote" }), promptVersion: "1" });
    const worker = new Worker({ agentId: agent.agentId, signer, client, jobs: new MemoryJobStore(), nonces, submissionMarginSec: 5, pollMs: 2000, policy: { evaluateProposal: async input => {
      if ((await readComputeState(work.allocationId))?.value.phase === "halted" || Date.now() / 1000 >= allocation.approvalDeadline) throw new Error("Compute authority closed before inference.");
      agent.phase = "reviewing";
      await attest({ type: "review_started", proposalId: work.proposalId, task: agent.task });
      await progress("reviewing", "Agents are independently reviewing the charter, constitution and exact proposed action.");
      const result = await model.evaluateProposal(input);
      await attest({ type: "review_decision", proposalId: work.proposalId, decision: result });
      agent.phase = "submitting"; await progress("voting", "Agents are submitting their own ballots and reasons to Base Sepolia.");
      return result;
    } } });
    const job = await worker.handleProposal(proposalId);
    agent.phase = job.state; agent.vote = job.vote; agent.txHash = job.txHash;
    await attest({ type: job.state === "voted" ? "ballot_confirmed" : "review_finished", proposalId: work.proposalId,
      state: job.state, vote: job.vote, txHash: job.txHash });
    status.inference = inference!.summary();
    await progress("voting", "Confirmed agent ballots are being collected from Base Sepolia.");
    } catch {
      agent.phase = "failed";
      await attest({ type: "agent_failed", proposalId: work.proposalId, message: "This review could not finish. No approval is inferred." });
      await progress("voting", "One review could not finish. Other agents continue independently; missing votes are not approval.");
    }
  }));
  const votes = await client.listVotes(proposalId);
  status.votes = votes.map(vote => { const agent = agents.find(a => a.address.toLowerCase() === vote.voter.toLowerCase()); return { agentId: agent?.agentId, voter: vote.voter, directive: ["AGAINST", "FOR", "ABSTAIN"][vote.support], reason: vote.parsedReason, txHash: vote.txHash, blockNumber: vote.blockNumber.toString() }; });
  status.inference = inference.summary();
  await progress("voting", `${votes.length} actual ballots are confirmed. Waiting for the voting deadline and independent controller.`);
  // Goldsky and the independent governance VM index these receipts. Agent work
  // never needs a local governance database to stay alive after a failed vote.
  const keeper = new Keeper({ client, addresses: work.addresses, wallet: createWalletClient({ account: privateKeyToAccount(bundle.keys.FLEET_KEEPER_KEY!), chain: baseSepolia, transport: http(rpcUrl) }), feeLimits: { maxFeePerGasWei: 100000000n, maxGas: 2000000n } });
  while (Date.now() / 1000 < allocation.approvalDeadline) {
    const state = await client.getProposalState(proposalId);
    status.outcome = ProposalState[state];
    await progress("settling", "The external controller independently verifies the vote and enforces the fixed allocation.");
    if ([ProposalState.Defeated, ProposalState.Canceled, ProposalState.Expired].includes(state)) {
      status.terminal = true; await progress("denied", "Required approval failed. No further task work is dispatched. Waiting for GCP to verify the worker is off."); break;
    }
    if (state === ProposalState.Executed) {
      status.terminal = true; await progress("approved", "The actual vote passed and executed. The original compute expiry still applies; the inert test action is not dispatched."); break;
    }
    await keeper.reconcileProposal(proposalId);
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  if (!status.terminal) {
    status.terminal = true;
    await progress("deadline", "The approval deadline closed. No more work is dispatched; the Guardian verifies the final state and enforces shutdown without settled approval.");
  }
} catch {
  status.terminal = true;
  await progress("failed", "The real run could not finish. Missing votes are not approval. The independent controller and native deadline remain in force.").catch(() => {});
  console.error("Real simulation worker failed. Private provider diagnostics withheld.");
  process.exitCode = 1;
} finally { if (inference) await inference.close(); journal?.close(); }
