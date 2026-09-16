import { beforeEach, expect, it, vi } from "vitest";
import { ContractFunctionRevertedError, encodeErrorResult, keccak256, type PublicClient } from "viem";
import { agoraGovernorAbi } from "@fleet/abi";
import { discoverTaskProposals } from "./proposal-discovery.js";
import { ComputeAllocation } from "./compute-policy.js";

const address = (n: number) => `0x${String(n).repeat(40)}`;
const policy = ComputeAllocation.parse({ schema: "fleet.compute-allocation.v1",
  allocationId: "11111111-1111-4111-8111-111111111111", runId: "run-22222222-2222-4222-8222-222222222222",
  project: "fleet-governance", zone: "us-central1-a", instance: "fleet-research", instanceId: "123",
  issuedAt: 1000, approvalDeadline: 3000, stopAt: 3000, chainId: 84532, governor: address(8), governorCodeHash: keccak256("0x6000"),
  requiredProposalIds: [], maxObservationAgeSeconds: 120,
  discovery: { taskId: "9", hook: address(7), hookCodeHash: keccak256("0x6000"), creditsContract: address(6), creditsCodeHash: keccak256("0x6000"),
    runHash: keccak256("0x01"), startBlock: "100", creditsPerAgent: 3, agents: [1, 2, 3, 4, 5].map(address),
    proposalWindowSeconds: 540, publicationWindowSeconds: 120 } });
let paid: bigint[], logs: { args: { proposalId: bigint; proposer: string } }[], states: Record<string, number>;
const readContract = vi.fn(), getContractEvents = vi.fn(), getBytecode = vi.fn();
const client = { readContract, getContractEvents, getBytecode } as unknown as PublicClient;
beforeEach(() => {
  vi.resetAllMocks(); paid = [77n]; logs = [{ args: { proposalId: 77n, proposer: address(1) } }]; states = { "77": 1 };
  getBytecode.mockResolvedValue("0x6000");
  getContractEvents.mockImplementation(async () => logs);
  readContract.mockImplementation(async (input: { functionName: string; args: unknown[] }) => {
    const { functionName: f, args } = input;
    if (f === "governor") return address(8);
    if (f === "token") return address(9);
    if (f === "hooks") return address(7);
    if (f === "runs") return [policy.discovery!.runHash, 3000n, 3];
    if (f === "proposalCount") return BigInt(paid.length);
    if (f === "proposalAt") return paid[Number(args[1])];
    if (f === "receipts") return [9n, address(1), 1050n];
    if (f === "state") {
      const s = states[String(args[0])];
      if (s !== undefined) return s;
      throw new ContractFunctionRevertedError({ abi: agoraGovernorAbi, functionName: "state",
        data: encodeErrorResult({ abi: agoraGovernorAbi, errorName: "GovernorNonexistentProposal", args: [args[0] as bigint] }) });
    }
    throw new Error("Unexpected call");
  });
});
it("uses the task's chain logs and contract credit receipts, not a worker proposal list", async () => {
  expect(await discoverTaskProposals(client, policy, 150n)).toEqual([{ proposalId: "77", state: 1, proposer: address(1), paidAt: 1050, creditPaid: true }]);
  expect(getContractEvents).toHaveBeenCalledWith(expect.objectContaining({ address: address(7), args: { taskId: 9n }, fromBlock: 100n, toBlock: 150n }));
  expect(readContract.mock.calls.every(([input]) => input.blockNumber === 150n)).toBe(true);
});
it("discovers unpaid direct Governor calls as well", async () => {
  logs.push({ args: { proposalId: 78n, proposer: address(2) } }); states["78"] = 1;
  expect((await discoverTaskProposals(client, policy, 150n))[1]).toEqual({ proposalId: "78", state: 1, proposer: address(2), creditPaid: false });
});
it("requires payment by the actual proposer", async () => {
  logs[0]!.args.proposer = address(2);
  expect((await discoverTaskProposals(client, policy, 150n))[0]!.creditPaid).toBe(false);
});
it("sees paid reservations before publication but rejects payments for another task's proposal", async () => {
  logs = []; states = {};
  expect((await discoverTaskProposals(client, policy, 150n))[0]!.state).toBe(-1);
  states["77"] = 7;
  await expect(discoverTaskProposals(client, policy, 150n)).rejects.toThrow("not part of the task");
});
it("rejects mismatched code and unconfirmed discovery ranges", async () => {
  getBytecode.mockResolvedValueOnce("0x6001");
  await expect(discoverTaskProposals(client, policy, 150n)).rejects.toThrow("did not match");
  await expect(discoverTaskProposals(client, policy, 99n)).rejects.toThrow("confirmed discovery range");
});
it("cannot turn an RPC error into an unpublished proposal", async () => {
  logs = []; states = {};
  const original = readContract.getMockImplementation()!;
  readContract.mockImplementation(async input => { if (input.functionName === "state") throw new Error("RPC unavailable"); return original(input); });
  await expect(discoverTaskProposals(client, policy, 150n)).rejects.toThrow("RPC unavailable");
});
