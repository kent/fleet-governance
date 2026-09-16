import { beforeEach, expect, it, vi } from "vitest";
import { keccak256, type PublicClient } from "viem";
import { discoverTaskProposals } from "./proposal-discovery.js";
import { ComputeAllocation, evaluateComputeAllocation } from "./compute-policy.js";
const address = (n: number) => `0x${String(n).repeat(40)}`;
const one = 10n ** 18n, amount = one / 10n;
const allocation = ComputeAllocation.parse({ schema: "fleet.compute-allocation.v1", allocationId: "11111111-1111-4111-8111-111111111111",
  runId: "run-22222222-2222-4222-8222-222222222222", project: "fleet-governance", zone: "us-central1-a", instance: "fleet-research", instanceId: "123",
  issuedAt: 1000, approvalDeadline: 3000, stopAt: 3000, chainId: 84532, governor: address(8), governorCodeHash: keccak256("0x6000"),
  requiredProposalIds: [], maxObservationAgeSeconds: 120,
  discovery: { taskId: "9", hook: address(7), hookCodeHash: keccak256("0x6000"), creditsContract: address(6), creditsCodeHash: keccak256("0x6000"),
    runHash: keccak256("0x01"), startBlock: "100", creditsPerAgent: 1, agents: [1,2,3,4,5].map(address), proposalWindowSeconds: 540, publicationWindowSeconds: 120,
    proposalBonds: { token: address(9), tokenCodeHash: keccak256("0x6000"), totalSupply: String(5n * one), amount: String(amount), cooldownSeconds: 60, participationBps: 6000 } } });
let settlement: number, state: number, votes: bigint[];
const readContract = vi.fn(), getContractEvents = vi.fn(), getBytecode = vi.fn();
const client = { readContract, getContractEvents, getBytecode } as unknown as PublicClient;
beforeEach(() => {
  vi.resetAllMocks(); settlement = 0; state = 1; votes = [0n,0n,0n]; getBytecode.mockResolvedValue("0x6000");
  getContractEvents.mockImplementation(async i => i.eventName === "DelegateChanged" ? [] : [{ args: { taskId: 9n, proposalId: 77n, proposer: address(1), amount }, transactionHash: "0xtransaction" }]);
  readContract.mockImplementation(async i => {
    const fixed: Record<string, unknown> = { governor: address(8), token: address(9), hook: address(7), hooks: address(7), bondController: address(6), proposalBonds: address(6),
      runs: [allocation.discovery!.runHash,3000n,amount,one,60,6000,false], proposalCount: 1n, proposalAt: 77n, totalSupply: 5n * one, currentTaskId: 9n,
      state, proposalVotes: votes, receipts: [9n,address(1),1050n,amount,one,settlement], participants: true, totalBonded: settlement === 0 ? amount : 0n };
    if (i.functionName in fixed) return fixed[i.functionName];
    const proposer = i.args[0] === address(1);
    if (i.functionName === "balanceOf") return i.args[0] === address(6) ? settlement === 2 ? amount : 0n : proposer && settlement === 2 ? one - amount : one;
    if (i.functionName === "bonded") return proposer && settlement === 0 ? amount : 0n;
    if (i.functionName === "forfeited") return proposer && settlement === 2 ? amount : 0n;
    if (i.functionName === "lastProposedAt") return i.args[1] === address(1) ? 1050n : 0n;
    throw new Error(`Unexpected read ${i.functionName}`);
  });
});
it("pins real collateral and the complete proposal transaction at one confirmed block", async () => {
  expect(await discoverTaskProposals(client, allocation, 150n)).toEqual([{ proposalId: "77", state: 1, creditPaid: true, proposer: address(1), paidAt: 1050 }]);
  expect(readContract.mock.calls.every(([i]) => i.blockNumber === 150n)).toBe(true);
});
it("recognises a refund on an all-AGAINST vote and still halts the compute", async () => {
  settlement = 1; state = 3; votes = [5n * one, 0n, 0n];
  const proposals = await discoverTaskProposals(client, allocation, 150n);
  const observation = { governor: allocation.governor, blockHash: keccak256("0x01"), chainId: 84532, governorCodeHash: allocation.governorCodeHash, observedAt: 1200, blockTimestamp: 1200, blockNumber: "150", discoveryVerified: true, proposals };
  expect(evaluateComputeAllocation(allocation, null, observation, 1200)).toMatchObject({ phase: "halted", reason: "vote_failed" });
});
it.each([[one,one,one], [0n,0n,3n*one]])("counts all three ballot choices toward a returned bond", async (against, for_, abstain) => {
  settlement = 1; state = 3; votes = [against,for_,abstain];
  expect(await discoverTaskProposals(client, allocation, 150n)).toHaveLength(1);
});
it("verifies a low-participation forfeiture against the treasury and future voting balance", async () => {
  settlement = 2; state = 3; votes = [one,0n,0n];
  expect(await discoverTaskProposals(client, allocation, 150n)).toHaveLength(1);
});
it.each(["bondController", "proposalBonds", "totalSupply", "balanceOf", "totalBonded"])("rejects altered bond authority or accounting: %s", async field => {
  const original = readContract.getMockImplementation()!;
  readContract.mockImplementation(i => i.functionName === field ? field === "bondController" || field === "proposalBonds" ? address(2) : 99n : original(i));
  await expect(discoverTaskProposals(client, allocation, 150n)).rejects.toThrow();
});
it("rejects early settlement and a refund unsupported by actual participation", async () => {
  settlement = 1;
  await expect(discoverTaskProposals(client, allocation, 150n)).rejects.toThrow("settled early");
  state = 3; votes = [one,0n,0n];
  await expect(discoverTaskProposals(client, allocation, 150n)).rejects.toThrow("actual participation");
});
it("cancellation forfeits even if participation would have been enough", async () => {
  settlement = 2; state = 2; votes = [5n*one,0n,0n];
  expect(await discoverTaskProposals(client, allocation, 150n)).toHaveLength(1);
  settlement = 1;
  await expect(discoverTaskProposals(client, allocation, 150n)).rejects.toThrow("actual participation");
});
it("rejects a bond event detached from the proposal transaction", async () => {
  getContractEvents.mockImplementation(async i => i.eventName === "DelegateChanged" ? [] : [{ args: { proposalId: 77n, proposer: address(1), amount }, transactionHash: i.eventName }]);
  await expect(discoverTaskProposals(client, allocation, 150n)).rejects.toThrow("Invalid FleetGov bond receipt");
});
