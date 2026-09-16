import { BaseError, ContractFunctionRevertedError, keccak256, type PublicClient, type Hex } from "viem";
import { agoraGovernorAbi, fleetHookAbi, fleetVotesAbi } from "@fleet/abi";
import type { ComputeAllocation, ComputeObservation } from "./compute-policy.js";
import { proposalCreditsAbi, proposalTokenAbi, proposalBudgetHookAbi } from "./proposal-credits.js";
import { discoverBondProposals } from "./bond-discovery.js";

export function isMissingProposal(error: unknown, proposalId: bigint): boolean {
  const reverted = error instanceof BaseError ? error.walk(cause => cause instanceof ContractFunctionRevertedError) : undefined;
  return reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName === "GovernorNonexistentProposal"
    && reverted.data.args?.[0] === proposalId;
}

/** Enumerate both payment reservations AND every task proposal from the pinned hook.
 * An agent cannot hide an unpaid proposal by omitting it from worker-written metadata. */
export async function discoverTaskProposals(client: Pick<PublicClient, "getBytecode" | "readContract" | "getContractEvents">, allocation: ComputeAllocation, blockNumber: bigint): Promise<ComputeObservation["proposals"]> {
  const p = allocation.discovery;
  if (!p || BigInt(p.startBlock) > blockNumber) throw new Error("No confirmed discovery range.");
  if (p.proposalBonds) return discoverBondProposals(client, allocation, blockNumber);
  const credits = p.creditsContract as Hex, hook = p.hook as Hex, governor = allocation.governor as Hex;
  const [creditsCode, hookCode, bankGovernor, bankToken, governorToken, governorHook, hookGovernor, run, count] = await Promise.all([
    client.getBytecode({ address: credits, blockNumber }), client.getBytecode({ address: hook, blockNumber }),
    client.readContract({ address: credits, abi: proposalCreditsAbi, functionName: "governor", blockNumber }),
    client.readContract({ address: credits, abi: proposalCreditsAbi, functionName: "token", blockNumber }),
    client.readContract({ address: governor, abi: agoraGovernorAbi, functionName: "token", blockNumber }),
    client.readContract({ address: governor, abi: agoraGovernorAbi, functionName: "hooks", blockNumber }),
    client.readContract({ address: hook, abi: fleetHookAbi, functionName: "governor", blockNumber }),
    client.readContract({ address: credits, abi: proposalCreditsAbi, functionName: "runs", args: [BigInt(p.taskId)], blockNumber }),
    client.readContract({ address: credits, abi: proposalCreditsAbi, functionName: "proposalCount", args: [BigInt(p.taskId)], blockNumber }),
  ]);
  if (!creditsCode || keccak256(creditsCode) !== p.creditsCodeHash || !hookCode || keccak256(hookCode) !== p.hookCodeHash
    || bankGovernor.toLowerCase() !== governor.toLowerCase() || hookGovernor.toLowerCase() !== governor.toLowerCase()
    || bankToken.toLowerCase() !== governorToken.toLowerCase() || governorHook.toLowerCase() !== hook.toLowerCase()
    || run[0] !== p.runHash || run[1] !== BigInt(allocation.stopAt) || run[2] !== p.creditsPerAgent || run[3] !== p.proposalCost || run[4] !== BigInt(p.proposalThreshold) * 10n ** 18n
    || count > BigInt(p.agents.length * p.creditsPerAgent)) throw new Error("Proposal credit authority did not match.");
  const delegations = await client.getContractEvents({ address: governorToken, abi: fleetVotesAbi, eventName: "DelegateChanged",
    fromBlock: BigInt(p.startBlock), toBlock: blockNumber, strict: true });
  for (const log of delegations) {
    const { delegator, toDelegate } = log.args;
    if (p.agents.some(a => a.toLowerCase() === delegator.toLowerCase()) &&
      (!p.agents.some(a => a.toLowerCase() === toDelegate.toLowerCase()) || !p.allowDelegation && delegator.toLowerCase() !== toDelegate.toLowerCase())) throw new Error("Delegation violated this experiment's rules.");
  }
  const logs = await client.getContractEvents({ address: hook, abi: fleetHookAbi, eventName: "DecisionProposed",
    args: { taskId: BigInt(p.taskId) }, fromBlock: BigInt(p.startBlock), toBlock: blockNumber, strict: true });
  const proposed = new Map(logs.map(log => [log.args.proposalId.toString(), log.args.proposer]));
  if (proposed.size !== logs.length) throw new Error("Duplicate task proposal.");
  const reservations = new Map<string, { proposer: string; paidAt: number }>();
  for (let i = 0; i < Number(count); i++) {
    const id = await client.readContract({ address: credits, abi: proposalCreditsAbi, functionName: "proposalAt", args: [BigInt(p.taskId), BigInt(i)], blockNumber });
    const receipt = await client.readContract({ address: credits, abi: proposalCreditsAbi, functionName: "receipts", args: [id], blockNumber });
    if (receipt[0] !== BigInt(p.taskId) || receipt[2] === 0n || receipt[3] !== p.proposalCost || receipt[4] < BigInt(p.proposalThreshold) * 10n ** 18n || reservations.has(id.toString())) throw new Error("Invalid credit receipt.");
    reservations.set(id.toString(), { proposer: receipt[1], paidAt: Number(receipt[2]) });
  }
  const ids = [...new Set([...reservations.keys(), ...proposed.keys()])];
  if (p.proposalToken) {
    const budgetToken = p.proposalToken.address as Hex;
    const [canonicalToken, bankHook, hookBank, code, controller, taskId, runHash, decimals, initialSupply, supply, balances] = await Promise.all([
      client.readContract({ address: credits, abi: proposalCreditsAbi, functionName: "proposalToken", args: [BigInt(p.taskId)], blockNumber }),
      client.readContract({ address: credits, abi: proposalCreditsAbi, functionName: "hook", blockNumber }),
      client.readContract({ address: hook, abi: proposalBudgetHookAbi, functionName: "proposalBudget", blockNumber }),
      client.getBytecode({ address: budgetToken, blockNumber }),
      client.readContract({ address: budgetToken, abi: proposalTokenAbi, functionName: "controller", blockNumber }),
      client.readContract({ address: budgetToken, abi: proposalTokenAbi, functionName: "taskId", blockNumber }),
      client.readContract({ address: budgetToken, abi: proposalTokenAbi, functionName: "runHash", blockNumber }),
      client.readContract({ address: budgetToken, abi: proposalTokenAbi, functionName: "decimals", blockNumber }),
      client.readContract({ address: budgetToken, abi: proposalTokenAbi, functionName: "initialSupply", blockNumber }),
      client.readContract({ address: budgetToken, abi: proposalTokenAbi, functionName: "totalSupply", blockNumber }),
      Promise.all(p.agents.map(agent => client.readContract({ address: budgetToken, abi: proposalTokenAbi, functionName: "balanceOf", args: [agent as Hex], blockNumber }))),
    ]);
    const expectedSupply = BigInt(p.agents.length * p.creditsPerAgent);
    if (canonicalToken.toLowerCase() !== budgetToken.toLowerCase() || !code || keccak256(code) !== p.proposalToken.codeHash
      || controller.toLowerCase() !== credits.toLowerCase() || bankHook.toLowerCase() !== hook.toLowerCase() || hookBank.toLowerCase() !== credits.toLowerCase()
      || taskId !== BigInt(p.taskId) || runHash !== p.runHash || decimals !== 0
      || initialSupply !== expectedSupply || BigInt(p.proposalToken.initialSupply) !== expectedSupply
      || supply + count * BigInt(p.proposalCost) !== expectedSupply || balances.reduce((sum, balance) => sum + balance, 0n) !== supply
      || balances.some((balance, index) => balance + BigInt([...reservations.values()].filter(r => r.proposer.toLowerCase() === p.agents[index]!.toLowerCase()).length * p.proposalCost) !== BigInt(p.creditsPerAgent))
      || ids.some(id => !reservations.has(id) || !proposed.has(id))) throw new Error("ERC-20 proposal burns did not match the fixed supply and Governor hook.");
  }
  const result: ComputeObservation["proposals"] = [];
  for (const proposalId of ids) {
    const payment = reservations.get(proposalId), proposer = proposed.get(proposalId);
    let state: number;
    try { state = Number(await client.readContract({ address: governor, abi: agoraGovernorAbi, functionName: "state", args: [BigInt(proposalId)], blockNumber })); }
    catch (error) { if (p.proposalToken || !payment || proposer || !isMissingProposal(error, BigInt(proposalId))) throw error; state = -1; }
    // A reservation for some other task's existing proposal cannot release this task.
    if (state !== -1 && !proposer) throw new Error("Paid proposal is not part of the task.");
    const creditPaid = !!payment && (!proposer || proposer.toLowerCase() === payment.proposer.toLowerCase());
    result.push({ proposalId, state, creditPaid, ...(proposer || payment ? { proposer: proposer ?? payment!.proposer } : {}),
      ...(payment ? { paidAt: payment.paidAt } : {}) });
  }
  return result;
}
