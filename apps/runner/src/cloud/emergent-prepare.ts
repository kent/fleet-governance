import { readFileSync } from "node:fs";
import { createWalletClient, http, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { fleetVotesAbi } from "@fleet/abi";
import { ExperimentSettings } from "./experiment-settings.js";
import { buildExperimentCharter } from "./experiment-charter.js";
import type { FleetClient, FleetAddresses } from "@fleet/sdk";
import type { FleetKeys } from "../pipeline/fixture-runner.js";
import { openTask } from "../pipeline/task.js";
import { armComputeAllocation, COMPUTE_TARGET, nativeStopAt, writeControlObject, type NativeVm } from "./compute-admin.js";
import { googleRequest, writeObject } from "./google.js";
import { readComputeObject } from "./compute-store.js";
import { BOND_DEPLOYMENT, proposalBondsAbi, bondVotesAbi, bondUnits } from "./proposal-bonds.js";
import { EMERGENT_SCENARIO } from "./emergent-scenario.js";
import { simulationPath, type SimulationRequest, type SimulationWork } from "./simulation.js";
import { runEvent, type RunEvent } from "./run-events.js";

export async function prepareEmergent(input: { request: SimulationRequest; client: FleetClient; rpcUrl: string;
  addresses: FleetAddresses; keys: FleetKeys; constitution: string; startBlock: bigint }): Promise<SimulationWork> {
  const { request, client, rpcUrl, addresses, keys, constitution, startBlock } = input;
  const settings = ExperimentSettings.parse(request.settings ?? {});
  const goal = settings.goal;
  const runId = request.runId, events: RunEvent[] = [];
  const progress = async (event: Omit<RunEvent, "id" | "runId" | "at">) => {
    events.push(runEvent(runId, event));
    await writeObject(simulationPath(runId, "preparation.json"), { runId, events });
    await writeObject(simulationPath(runId), { runId, scenario: EMERGENT_SCENARIO, phase: "provisioning", message: event.title,
      goal, updatedAt: events.at(-1)!.at, terminal: false, agents: [], rounds: [] });
  };
  const credits = await readComputeObject(BOND_DEPLOYMENT) as { schema: string; address: Hex; codeHash: Hex; governor: string; token: string } | null;
  if (!credits || credits.schema !== "fleet.proposal-bonds.v4" || credits.governor.toLowerCase() !== addresses.governor.toLowerCase() || credits.token.toLowerCase() !== addresses.token.toLowerCase()) throw new Error("Deploy single-token proposal bonds through CI first.");
  const budgetCode = await client.publicClient.getBytecode({ address: credits.address });
  if (!budgetCode || keccak256(budgetCode) !== credits.codeHash) throw new Error("Proposal bond controller code changed.");
  await progress({ component: "task", type: "task.assigned", title: "Task assigned: investigate the local benchmark", detail: goal });
  const vm = await (await googleRequest("compute", COMPUTE_TARGET)).json() as NativeVm;
  const now = Math.floor(Date.now() / 1000), stopAt = Math.min(nativeStopAt(vm, now), now + settings.durationMinutes * 60);
  if (stopAt - now < settings.durationMinutes * 60 - 5) throw new Error("The selected duration must fit within the remaining native VM allocation.");
  await progress({ component: "compute", type: "compute.observed_running", title: "Agent VM is running", detail: "GCP reports RUNNING. The agents have not started and no proposals have been drafted.", evidence: { id: vm.id, status: vm.status, lastStartTimestamp: vm.lastStartTimestamp } });
  const roster = JSON.parse(readFileSync("experiments/compute/agent-roster.json", "utf8")) as { agentId: number; address: Hex }[];
  // Explicit experiment setup resets the shared pilot electorate, never an active run.
  for (const agent of roster) {
    const delegate = await client.publicClient.readContract({ address: addresses.token, abi: fleetVotesAbi, functionName: "delegates", args: [agent.address] });
    if (delegate.toLowerCase() !== agent.address.toLowerCase()) {
      const signer = createWalletClient({ account: privateKeyToAccount(keys.agentKeys[agent.agentId]!), chain: baseSepolia, transport: http(rpcUrl) });
      const txHash = await signer.writeContract({ address: addresses.token, abi: fleetVotesAbi, functionName: "delegate", args: [agent.address], gas: 300000n, maxFeePerGas: 100000000n });
      const reset = await client.publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 3 });
      if (reset.status !== "success") throw new Error("Could not reset the experiment electorate.");
      await progress({ component: "governance", type: "delegation.reset", agentId: agent.agentId, txHash,
        title: `Operator reset Agent${agent.agentId + 1} to self-delegation`, detail: "A new experiment starts from equal voting power. This is recorded setup, not an agent decision." });
    }
  }
  const charter = buildExperimentCharter(settings, constitution);
  const task = await openTask({ client, addresses, chainId: 84532, rpcUrl, operatorKey: keys.operatorKey, charter, lifetimeSeconds: stopAt - now + 180 });
  await progress({ component: "governance", type: "task.opened", title: "Task charter recorded on Base Sepolia", detail: "The charter fixes the initial scope. The proposal list is empty.", txHash: task.txHash, evidence: { taskId: task.taskId.toString(), blockNumber: task.blockNumber.toString() } });
  const wallet = createWalletClient({ account: privateKeyToAccount(keys.operatorKey), chain: baseSepolia, transport: http(rpcUrl) });
  const runHash = keccak256(toHex(runId));
  const activeAgents = roster.slice(0, settings.agentCount).map(a => a.address);
  const paymentSetup = await wallet.writeContract({ address: credits.address, abi: proposalBondsAbi, functionName: "registerRunPolicy",
    args: [task.taskId, runHash, BigInt(stopAt), bondUnits(settings.proposalBond), bondUnits(settings.proposalThreshold),
      settings.proposalCooldownSeconds, settings.bondParticipationPercent * 100, activeAgents], maxFeePerGas: 100000000n, gas: 2000000n });
  const receipt = await client.publicClient.waitForTransactionReceipt({ hash: paymentSetup, confirmations: 3 });
  if (receipt.status !== "success") throw new Error("Proposal bond registration failed.");
  const [tokenCode, supply, controller, ...balances] = await Promise.all([
    client.publicClient.getBytecode({ address: addresses.token, blockNumber: receipt.blockNumber }),
    client.publicClient.readContract({ address: addresses.token, abi: bondVotesAbi, functionName: "totalSupply", blockNumber: receipt.blockNumber }),
    client.publicClient.readContract({ address: addresses.token, abi: bondVotesAbi, functionName: "bondController", blockNumber: receipt.blockNumber }),
    ...roster.map(agent => client.publicClient.readContract({ address: addresses.token, abi: bondVotesAbi, functionName: "balanceOf", args: [agent.address], blockNumber: receipt.blockNumber })),
  ]);
  if (!tokenCode || tokenCode === "0x" || supply !== BigInt(roster.length) * 10n ** 18n || controller.toLowerCase() !== credits.address.toLowerCase()
    || balances.some(balance => balance !== 10n ** 18n)) throw new Error("Fixed FleetGov electorate and bond binding did not match.");
  const code = await client.publicClient.getBytecode({ address: addresses.hook, blockNumber: receipt.blockNumber });
  if (!code || code === "0x") throw new Error("Missing task proposal hook.");
  const allocation = await armComputeAllocation({ runId, governor: addresses.governor, requiredProposalIds: [], stopAt,
    discovery: { taskId: task.taskId.toString(), hook: addresses.hook, hookCodeHash: keccak256(code),
      creditsContract: credits.address, creditsCodeHash: credits.codeHash, runHash, startBlock: startBlock.toString(),
      proposalBonds: { token: addresses.token, tokenCodeHash: keccak256(tokenCode), totalSupply: supply.toString(),
        amount: bondUnits(settings.proposalBond).toString(), cooldownSeconds: settings.proposalCooldownSeconds, participationBps: settings.bondParticipationPercent * 100 },
      creditsPerAgent: 1, proposalCost: 1, proposalThreshold: settings.proposalThreshold,
      allowDelegation: settings.allowDelegation, agents: activeAgents, proposalWindowSeconds: 540, publicationWindowSeconds: 120 } });
  await progress({ component: "compute", type: "allocation.armed", title: "One FleetGov token. Agent-authored proposals.",
    detail: `Each agent holds one FleetGov voting token. Proposing reserves ${settings.proposalBond} FleetGov and requires ${settings.proposalThreshold} voting units. A ${settings.proposalCooldownSeconds}s cooldown and one unsettled proposal per agent limit spam. The bond returns when ${settings.bondParticipationPercent}% of the total supply votes FOR, AGAINST or ABSTAIN, even if the proposal loses. Cancellation or insufficient participation forfeits it. Fresh experiments redistribute the original fixed supply after the old run closes; no new tokens are minted.`,
    txHash: paymentSetup, evidence: { allocationId: allocation.allocationId, taskId: task.taskId.toString(), proposalBonds: credits.address,
      token: addresses.token, totalSupply: supply.toString(), proposalBond: settings.proposalBond, proposalThreshold: settings.proposalThreshold,
      proposalCooldownSeconds: settings.proposalCooldownSeconds, bondParticipationPercent: settings.bondParticipationPercent,
      allowDelegation: settings.allowDelegation, proposals: [], stopAt: allocation.stopAt } });
  const work: SimulationWork = { schema: "fleet.simulation-work.v1", scenario: EMERGENT_SCENARIO, runId,
    allocationId: allocation.allocationId, chainId: 84532, addresses, taskId: task.taskId.toString(),
    startBlock: startBlock.toString(), goal, constitution, settings, createdAt: new Date().toISOString(), preparationEvents: events,
    agentDriven: { creditsContract: credits.address, proposalBonds: credits.address, allowance: 1, maxWorkSteps: settings.maxWorkSteps, proposalWindowSeconds: 540 } };
  await writeControlObject(`simulations/${runId}/work.json`, work);
  return work;
}
