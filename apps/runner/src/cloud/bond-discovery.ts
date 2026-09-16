import { keccak256, type PublicClient, type Hex } from "viem";
import { agoraGovernorAbi, fleetHookAbi, fleetVotesAbi } from "@fleet/abi";
import type { ComputeAllocation, ComputeObservation } from "./compute-policy.js";
import { bondHookAbi, bondUnits, bondVotesAbi, proposalBondsAbi } from "./proposal-bonds.js";

/** Read canonical contracts at one confirmed block. Worker reports grant no authority. */
export async function discoverBondProposals(client: Pick<PublicClient, "getBytecode" | "readContract" | "getContractEvents">,
  allocation: ComputeAllocation, blockNumber: bigint): Promise<ComputeObservation["proposals"]> {
  const p = allocation.discovery!, policy = p.proposalBonds!;
  const bank = p.creditsContract as Hex, hook = p.hook as Hex, governor = allocation.governor as Hex, token = policy.token as Hex;
  const [bankCode, hookCode, tokenCode, bankGovernor, bankToken, bankHook, tokenController, governorToken, governorHook, hookBank, run, count, supply, treasury, totalBonded, currentTask] = await Promise.all([
    client.getBytecode({ address: bank, blockNumber }), client.getBytecode({ address: hook, blockNumber }), client.getBytecode({ address: token, blockNumber }),
    client.readContract({ address: bank, abi: proposalBondsAbi, functionName: "governor", blockNumber }),
    client.readContract({ address: bank, abi: proposalBondsAbi, functionName: "token", blockNumber }),
    client.readContract({ address: bank, abi: proposalBondsAbi, functionName: "hook", blockNumber }),
    client.readContract({ address: token, abi: bondVotesAbi, functionName: "bondController", blockNumber }),
    client.readContract({ address: governor, abi: agoraGovernorAbi, functionName: "token", blockNumber }),
    client.readContract({ address: governor, abi: agoraGovernorAbi, functionName: "hooks", blockNumber }),
    client.readContract({ address: hook, abi: bondHookAbi, functionName: "proposalBonds", blockNumber }),
    client.readContract({ address: bank, abi: proposalBondsAbi, functionName: "runs", args: [BigInt(p.taskId)], blockNumber }),
    client.readContract({ address: bank, abi: proposalBondsAbi, functionName: "proposalCount", args: [BigInt(p.taskId)], blockNumber }),
    client.readContract({ address: token, abi: bondVotesAbi, functionName: "totalSupply", blockNumber }),
    client.readContract({ address: token, abi: bondVotesAbi, functionName: "balanceOf", args: [bank], blockNumber }),
    client.readContract({ address: token, abi: bondVotesAbi, functionName: "totalBonded", blockNumber }),
    client.readContract({ address: bank, abi: proposalBondsAbi, functionName: "currentTaskId", blockNumber }),
  ]);
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!bankCode || keccak256(bankCode) !== p.creditsCodeHash || !hookCode || keccak256(hookCode) !== p.hookCodeHash
    || !tokenCode || keccak256(tokenCode) !== policy.tokenCodeHash || !same(bankGovernor, governor) || !same(bankToken, token)
    || !same(bankHook, hook) || !same(tokenController, bank) || !same(governorToken, token) || !same(governorHook, hook) || !same(hookBank, bank)
    || run[0] !== p.runHash || run[1] !== BigInt(allocation.stopAt) || run[2] !== BigInt(policy.amount)
    || run[3] !== bondUnits(p.proposalThreshold) || run[4] !== policy.cooldownSeconds || run[5] !== policy.participationBps
    || run[6] || currentTask !== BigInt(p.taskId) || count > 64n || supply !== BigInt(policy.totalSupply)) throw new Error("FleetGov bond authority did not match.");
  const [created, bonded, delegations] = await Promise.all([
    client.getContractEvents({ address: hook, abi: fleetHookAbi, eventName: "DecisionProposed", args: { taskId: BigInt(p.taskId) }, fromBlock: BigInt(p.startBlock), toBlock: blockNumber, strict: true }),
    client.getContractEvents({ address: bank, abi: proposalBondsAbi, eventName: "ProposalBonded", args: { taskId: BigInt(p.taskId) }, fromBlock: BigInt(p.startBlock), toBlock: blockNumber, strict: true }),
    client.getContractEvents({ address: token, abi: fleetVotesAbi, eventName: "DelegateChanged", fromBlock: BigInt(p.startBlock), toBlock: blockNumber, strict: true }),
  ]);
  if (BigInt(created.length) !== count || BigInt(bonded.length) !== count || new Set(created.map(c => c.args.proposalId)).size !== created.length) throw new Error("A proposal is missing its atomic bond.");
  for (const { args: d } of delegations) if (p.agents.some(a => same(a, d.delegator)) &&
    (!p.agents.some(a => same(a, d.toDelegate)) || !p.allowDelegation && !same(d.delegator, d.toDelegate))) throw new Error("Delegation violated the experiment rules.");
  const sums = new Map(p.agents.map(agent => [agent.toLowerCase(), { locked: 0n, lost: 0n, latest: 0n }]));
  const result: ComputeObservation["proposals"] = [];
  for (let i = 0; i < Number(count); i++) {
    const id = await client.readContract({ address: bank, abi: proposalBondsAbi, functionName: "proposalAt", args: [BigInt(p.taskId), BigInt(i)], blockNumber });
    const [receipt, state] = await Promise.all([
      client.readContract({ address: bank, abi: proposalBondsAbi, functionName: "receipts", args: [id], blockNumber }),
      client.readContract({ address: governor, abi: agoraGovernorAbi, functionName: "state", args: [id], blockNumber }),
    ]);
    const proposal = created.find(c => c.args.proposalId === id), event = bonded.find(c => c.args.proposalId === id), sum = sums.get(receipt[1].toLowerCase());
    if (!proposal || !event || !sum || receipt[0] !== BigInt(p.taskId) || receipt[2] === 0n || receipt[3] !== BigInt(policy.amount)
      || receipt[4] < bondUnits(p.proposalThreshold) || !same(proposal.args.proposer, receipt[1]) || !same(event.args.proposer, receipt[1])
      || event.args.amount !== receipt[3] || event.transactionHash !== proposal.transactionHash || receipt[5] > 2
      || sum.latest !== 0n && receipt[2] < sum.latest + BigInt(policy.cooldownSeconds)) throw new Error("Invalid FleetGov bond receipt.");
    sum.latest = receipt[2];
    if (receipt[5] === 0) sum.locked += receipt[3];
    else {
      if (state === 0 || state === 1) throw new Error("A live vote's bond was settled early.");
      const [against, for_, abstain] = await client.readContract({ address: governor, abi: agoraGovernorAbi, functionName: "proposalVotes", args: [id], blockNumber });
      // The token's supply is fixed; forfeiture transfers to a non-voting treasury.
      const required = (supply * BigInt(policy.participationBps) + 9999n) / 10000n;
      const refund = state !== 2 && against + for_ + abstain >= required;
      if (receipt[5] !== (refund ? 1 : 2)) throw new Error("Bond settlement does not match actual participation.");
      if (!refund) sum.lost += receipt[3];
    }
    result.push({ proposalId: id.toString(), state: Number(state), creditPaid: true, proposer: receipt[1], paidAt: Number(receipt[2]) });
  }
  for (const agent of p.agents) {
    const sum = sums.get(agent.toLowerCase())!;
    const [balance, locked, lost, eligible, latest] = await Promise.all([
      client.readContract({ address: token, abi: bondVotesAbi, functionName: "balanceOf", args: [agent as Hex], blockNumber }),
      client.readContract({ address: token, abi: bondVotesAbi, functionName: "bonded", args: [agent as Hex], blockNumber }),
      client.readContract({ address: token, abi: bondVotesAbi, functionName: "forfeited", args: [agent as Hex], blockNumber }),
      client.readContract({ address: bank, abi: proposalBondsAbi, functionName: "participants", args: [BigInt(p.taskId), agent as Hex], blockNumber }),
      client.readContract({ address: bank, abi: proposalBondsAbi, functionName: "lastProposedAt", args: [BigInt(p.taskId), agent as Hex], blockNumber }),
    ]);
    if (!eligible || locked !== sum.locked || lost !== sum.lost || balance + lost !== 10n ** 18n || latest !== sum.latest || locked > balance) throw new Error("FleetGov collateral does not match the proposal receipts.");
  }
  if (treasury !== [...sums.values()].reduce((sum, a) => sum + a.lost, 0n) || totalBonded !== [...sums.values()].reduce((sum, a) => sum + a.locked, 0n)) throw new Error("Bond treasury or collateral total changed.");
  return result;
}
