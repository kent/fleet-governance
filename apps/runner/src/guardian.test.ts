import { describe, expect, it, vi } from "vitest";
import { keccak256, toHex } from "viem";
import type { Address, Hex } from "viem";
import { taskLedgerAbi, timelockControllerAbi } from "@fleet/abi";
import type { FleetAddresses } from "@fleet/sdk";
import { guardianCancel, guardianPause, guardianUnpause } from "./guardian.js";
import type { GuardianChainClient, GuardianWallet } from "./guardian.js";
import { ZERO_BYTES32, timelockSalt } from "./pipeline/timelock.js";

const ADDRESSES: FleetAddresses = {
  registry: "0x1000000000000000000000000000000000000001",
  token: "0x1000000000000000000000000000000000000002",
  timelock: "0x1000000000000000000000000000000000000003",
  ledger: "0x1000000000000000000000000000000000000004",
  hook: "0x1000000000000000000000000000000000000005",
  governor: "0x1000000000000000000000000000000000000006",
};

function fakeClient(overrides: Partial<GuardianChainClient> = {}): GuardianChainClient {
  return {
    addresses: ADDRESSES,
    getProposalCreated: vi.fn(async () => ({
      targets: [ADDRESSES.ledger] as readonly Address[],
      values: [0n] as readonly bigint[],
      calldatas: ["0xabcdef" as Hex] as readonly Hex[],
      description: "# Grant exception\n\n#proposalTypeId=0",
    })),
    publicClient: {
      readContract: vi.fn(async () => "0xoperation" as Hex),
      waitForTransactionReceipt: vi.fn(async () => ({ blockNumber: 999n })),
    },
    ...overrides,
  };
}

function fakeWallet(txHash: Hex = "0xtxhash" as Hex): { wallet: GuardianWallet; writeContract: ReturnType<typeof vi.fn> } {
  const writeContract = vi.fn(async () => txHash);
  return { wallet: { writeContract }, writeContract };
}

describe("guardianPause", () => {
  it("calls TaskLedger.pause and waits for the receipt", async () => {
    const client = fakeClient();
    const { wallet, writeContract } = fakeWallet("0xpausetx" as Hex);

    const result = await guardianPause(client, wallet);

    expect(writeContract).toHaveBeenCalledWith({ address: ADDRESSES.ledger, abi: taskLedgerAbi, functionName: "pause" });
    expect(client.publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: "0xpausetx" });
    expect(result).toEqual({ txHash: "0xpausetx", blockNumber: 999n });
  });
});

describe("guardianUnpause", () => {
  it("calls TaskLedger.unpause and waits for the receipt", async () => {
    const client = fakeClient();
    const { wallet, writeContract } = fakeWallet("0xunpausetx" as Hex);

    const result = await guardianUnpause(client, wallet);

    expect(writeContract).toHaveBeenCalledWith({ address: ADDRESSES.ledger, abi: taskLedgerAbi, functionName: "unpause" });
    expect(result).toEqual({ txHash: "0xunpausetx", blockNumber: 999n });
  });
});

describe("guardianCancel", () => {
  it("recomputes the timelock operation id exactly like fixture-runner's guardianPauseAndCancel and cancels it", async () => {
    const client = fakeClient();
    const { wallet, writeContract } = fakeWallet("0xcanceltx" as Hex);

    const result = await guardianCancel(client, wallet, 42n);

    const created = await client.getProposalCreated(42n);
    const descriptionHash = keccak256(toHex(created.description));
    const expectedSalt = timelockSalt(ADDRESSES.governor, descriptionHash);

    expect(client.publicClient.readContract).toHaveBeenCalledWith({
      address: ADDRESSES.timelock,
      abi: timelockControllerAbi,
      functionName: "hashOperationBatch",
      args: [created.targets, created.values, created.calldatas, ZERO_BYTES32, expectedSalt],
    });
    expect(writeContract).toHaveBeenCalledWith({
      address: ADDRESSES.timelock,
      abi: timelockControllerAbi,
      functionName: "cancel",
      args: ["0xoperation"],
    });
    expect(result).toEqual({ txHash: "0xcanceltx", blockNumber: 999n, operationId: "0xoperation" });
  });

  it("propagates a readContract failure (e.g. no ProposalCreated log) without calling the wallet", async () => {
    const client = fakeClient({
      getProposalCreated: vi.fn(async () => {
        throw new Error("no ProposalCreated log found for proposalId 1");
      }),
    });
    const { wallet, writeContract } = fakeWallet();

    await expect(guardianCancel(client, wallet, 1n)).rejects.toThrow("no ProposalCreated log found");
    expect(writeContract).not.toHaveBeenCalled();
  });
});
