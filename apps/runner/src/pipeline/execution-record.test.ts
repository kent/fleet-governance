import { describe, expect, it, vi } from "vitest";
import type { FleetClient } from "@fleet/sdk";
import type { ManifestV1 } from "@fleet/schemas";
import { captureExecutionRecord } from "./execution-record.js";

const executor = `0x${"11".repeat(20)}` as const;
const artifactStore = `0x${"22".repeat(20)}` as const;
const hash = `0x${"aa".repeat(32)}`;
const otherHash = `0x${"bb".repeat(32)}`;
const manifest = { deploymentBlock: 3, addresses: { executor, artifactStore } } as ManifestV1;
const log = (eventName: string, args: Record<string, unknown>, logIndex: number) => ({ eventName, args, logIndex,
  transactionHash: hash, blockHash: hash, blockNumber: 10n });

function fakeClient() {
  const publicClient = {
    getBlock: vi.fn(async () => ({ number: 10n, hash })),
    getContractEvents: vi.fn(async ({ eventName }: { eventName: string }) => {
      if (eventName === "PermitExecuted") return [log(eventName, { taskId: 2n, payloadHash: hash }, 2), log(eventName, { taskId: 9n, payloadHash: otherHash }, 4)];
      if (eventName === "ArtifactPublished") return [log(eventName, { taskId: 2n, digest: hash, revision: 1n }, 1)];
      return [log(eventName, { payloadHash: hash }, 3), log(eventName, { payloadHash: otherHash }, 5)];
    }),
    readContract: vi.fn(async ({ args }: { args: [bigint] }) => args[0] === 1n ? [`0x${"00".repeat(32)}`, 0n] : [hash, 1n]),
  };
  return { client: { addresses: { executor, artifactStore }, publicClient } as unknown as FleetClient, rpc: publicClient };
}

describe("contract execution evidence", () => {
  it("reads resource state at one block and retains only the requested tasks and related revocations", async () => {
    const { client, rpc } = fakeClient();
    const evidence = await captureExecutionRecord(client, manifest, ["1", "2", "2"], []);
    expect(evidence?.events.map(event => event.type)).toEqual(["ArtifactPublished", "PermitExecuted", "PermitRevocation"]);
    expect(evidence?.artifacts.map(artifact => artifact.revision)).toEqual(["0", "1"]);
    expect(evidence?.blockHash).toBe(hash);
    expect(rpc.getContractEvents).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 3n, toBlock: 10n, strict: true }));
    expect(rpc.readContract).toHaveBeenCalledTimes(2);
    expect(rpc.readContract).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 10n, args: [1n] }));
  });

  it("does not invent execution support for historical manifests", async () => {
    const { client, rpc } = fakeClient();
    expect(await captureExecutionRecord(client, { addresses: {} } as ManifestV1, ["1"], [])).toBeUndefined();
    expect(rpc.getBlock).not.toHaveBeenCalled();
  });

  it("propagates failed chain reads and rejects mixed histories or deployments", async () => {
    const { client, rpc } = fakeClient();
    rpc.getContractEvents.mockRejectedValueOnce(new Error("RPC unavailable"));
    await expect(captureExecutionRecord(client, manifest, ["1"], [])).rejects.toThrow("RPC unavailable");
    rpc.getBlock.mockResolvedValueOnce({ number: 10n, hash }).mockResolvedValueOnce({ number: 10n, hash: otherHash });
    await expect(captureExecutionRecord(client, manifest, ["1"], [])).rejects.toThrow("block changed");
    await expect(captureExecutionRecord(client, { ...manifest, addresses: { ...manifest.addresses, executor: artifactStore } }, ["1"], [])).rejects.toThrow("deployment mismatch");
  });
});
