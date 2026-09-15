import { beforeEach, expect, it, vi } from "vitest";
import { createPublicClient, keccak256 } from "viem";
import { observeComputeApproval } from "./compute-observer.js";
import { ComputeAllocation } from "./compute-policy.js";

vi.mock("viem", async () => ({ ...await vi.importActual<typeof import("viem")>("viem"), createPublicClient: vi.fn() }));
const policy = ComputeAllocation.parse({
  schema: "fleet.compute-allocation.v1", allocationId: "00000000-0000-4000-8000-000000000001",
  runId: "run-00000000-0000-4000-8000-000000000001", project: "fleet-governance", zone: "us-central1-a",
  instance: "fleet-research", instanceId: "123", issuedAt: 1000, approvalDeadline: 1300, stopAt: 1600,
  chainId: 84532, governor: `0x${"11".repeat(20)}`, governorCodeHash: keccak256("0x6000"),
  requiredProposalIds: ["123", "456"], maxObservationAgeSeconds: 30,
});
const client = {
  getChainId: vi.fn(), getBlockNumber: vi.fn(), getBlock: vi.fn(), getBytecode: vi.fn(), readContract: vi.fn(),
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(createPublicClient).mockReturnValue(client as never);
  client.getChainId.mockResolvedValue(84532);
  client.getBlockNumber.mockResolvedValue(102n);
  client.getBlock.mockResolvedValue({ hash: `0x${"33".repeat(32)}`, timestamp: 1100n });
  client.getBytecode.mockResolvedValue("0x6000");
  client.readContract.mockResolvedValue(7);
});
it("reads all required states and bytecode at one confirmed block, then verifies its hash again", async () => {
  const result = await observeComputeApproval(policy, "https://rpc.example.invalid");
  expect(result).toMatchObject({ blockNumber: "100", governorCodeHash: policy.governorCodeHash,
    proposals: [{ proposalId: "123", state: 7 }, { proposalId: "456", state: 7 }] });
  expect(client.getBlock).toHaveBeenCalledTimes(2);
  expect(client.getBlock).toHaveBeenNthCalledWith(2, { blockNumber: 100n });
  expect(client.getBytecode).toHaveBeenCalledWith({ address: policy.governor, blockNumber: 100n });
  expect(client.readContract.mock.calls.map(([arg]) => ({ address: arg.address, id: arg.args[0], block: arg.blockNumber })))
    .toEqual([{ address: policy.governor, id: 123n, block: 100n }, { address: policy.governor, id: 456n, block: 100n }]);
});
it("rejects a reorganisation during observation instead of combining incompatible states", async () => {
  client.getBlock.mockResolvedValueOnce({ hash: `0x${"44".repeat(32)}`, timestamp: 1100n });
  await expect(observeComputeApproval(policy, "https://rpc.example.invalid")).rejects.toThrow("changed");
});
it("rejects another chain before reading its apparent approval", async () => {
  client.getChainId.mockResolvedValue(1);
  await expect(observeComputeApproval(policy, "https://rpc.example.invalid")).rejects.toThrow("chain");
  expect(client.readContract).not.toHaveBeenCalled();
});
it("does not treat an absent Governor or failed state read as approval", async () => {
  client.getBytecode.mockResolvedValueOnce(undefined);
  await expect(observeComputeApproval(policy, "https://rpc.example.invalid")).rejects.toThrow("no code");
  client.readContract.mockRejectedValueOnce(new Error("RPC read failed"));
  await expect(observeComputeApproval(policy, "https://rpc.example.invalid")).rejects.toThrow("RPC read failed");
});
