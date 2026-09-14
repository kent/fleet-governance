import { describe, expect, it, vi } from "vitest";
import { FleetClient } from "@fleet/sdk";
import type { ManifestV1 } from "@fleet/schemas";
import { buildFleetClientFromManifest, listTaskProposalIds } from "./chain.js";

const ADDRESSES = {
  registry: "0x1000000000000000000000000000000000000001",
  token: "0x1000000000000000000000000000000000000002",
  timelock: "0x1000000000000000000000000000000000000003",
  ledger: "0x1000000000000000000000000000000000000004",
  hook: "0x1000000000000000000000000000000000000005",
  governor: "0x1000000000000000000000000000000000000006",
} as const;

function fakeManifest(): ManifestV1 {
  return {
    schema: "fleet.manifest.v1",
    chainId: 31337,
    deploymentBlock: 10,
    deploymentTimestamp: 1000,
    deployer: "0x1000000000000000000000000000000000000009",
    addresses: ADDRESSES,
    hookSalt: `0x${"11".repeat(32)}`,
    members: ["0x100000000000000000000000000000000000000a"],
    operator: "0x100000000000000000000000000000000000000b",
    guardian: "0x100000000000000000000000000000000000000c",
    tokenName: "Fleet Vote",
    tokenSymbol: "FLEET",
    configPath: "deployments/configs/local.json",
    params: {
      votingDelay: 15,
      votingPeriod: 120,
      proposalThreshold: "0",
      quorumNumerator: 6000,
      timelockDelay: 30,
      maxTaskLifetime: 7200,
    },
    countingRule: "for-only-quorum",
    hookPermissionMask: "0x22C0",
    configHash: `0x${"22".repeat(32)}`,
    compiler: { solc: "0.8.24", evm: "cancun", optimizerRuns: 200 },
    pins: { agoraGovernor: "abc", openzeppelin: "def" },
    codeHashes: {
      registry: `0x${"33".repeat(32)}`,
      token: `0x${"33".repeat(32)}`,
      timelock: `0x${"33".repeat(32)}`,
      ledger: `0x${"33".repeat(32)}`,
      hook: `0x${"33".repeat(32)}`,
      governor: `0x${"33".repeat(32)}`,
    },
  };
}

describe("buildFleetClientFromManifest", () => {
  it("builds a FleetClient whose addresses and chain id come from the manifest", () => {
    const client = buildFleetClientFromManifest(fakeManifest(), "http://127.0.0.1:8545");
    expect(client.chainId).toBe(31337);
    expect(client.addresses.hook).toBe(ADDRESSES.hook);
    expect(client.addresses.governor).toBe(ADDRESSES.governor);
  });
});

describe("listTaskProposalIds", () => {
  it("returns deduplicated proposal ids from DecisionProposed logs, filtered by taskId and fromBlock", async () => {
    const client = buildFleetClientFromManifest(fakeManifest(), "http://127.0.0.1:8545");
    const getContractEvents = vi.fn(async (args: unknown) => {
      expect((args as { fromBlock: bigint }).fromBlock).toBe(10n);
      expect((args as { args: { taskId: bigint } }).args.taskId).toBe(7n);
      return [
        { args: { proposalId: 111n } },
        { args: { proposalId: 222n } },
        { args: { proposalId: 111n } },
        { args: {} },
      ];
    });
    client.publicClient.getContractEvents = getContractEvents as never;

    const ids = await listTaskProposalIds(client, 7n, 10n);
    expect(ids).toEqual([111n, 222n]);
    expect(getContractEvents).toHaveBeenCalledOnce();
  });

  it("returns an empty list when there are no matching logs", async () => {
    const client = buildFleetClientFromManifest(fakeManifest(), "http://127.0.0.1:8545");
    client.publicClient.getContractEvents = vi.fn(async () => []) as never;
    const ids = await listTaskProposalIds(client, 1n, 0n);
    expect(ids).toEqual([]);
  });
});
