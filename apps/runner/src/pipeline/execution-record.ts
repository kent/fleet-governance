import { fleetExecutorAbi, governedArtifactStoreAbi } from "@fleet/abi";
import type { ManifestV1 } from "@fleet/schemas";
import type { FleetClient } from "@fleet/sdk";

export type ExecutionRecord = {
  blockNumber: string;
  blockHash: string;
  events: (Record<string, unknown> & { type: string; txHash: string; blockHash: string; blockNumber: string; logIndex: number })[];
  artifacts: { taskId: string; digest: string; revision: string }[];
};

/** Rebuild at one chain block, never from a local claim of success. Historical deployments
 * without an executor have no contract execution evidence. Log or state read failures propagate. */
export async function captureExecutionRecord(client: FleetClient, manifest: ManifestV1,
  taskIds: readonly string[], payloadHashes: readonly string[]): Promise<ExecutionRecord | undefined> {
  const { executor, artifactStore } = manifest.addresses;
  if (!executor && !artifactStore) return undefined;
  if (!executor || !artifactStore || executor.toLowerCase() !== client.addresses.executor?.toLowerCase()
    || artifactStore.toLowerCase() !== client.addresses.artifactStore?.toLowerCase()) throw new Error("execution evidence deployment mismatch");
  const rpc = client.publicClient;
  const block = await rpc.getBlock({ blockTag: "latest" });
  const range = { fromBlock: BigInt(manifest.deploymentBlock), toBlock: block.number, strict: true } as const;
  const [executions, revocations, publications] = await Promise.all([
    rpc.getContractEvents({ address: client.addresses.executor!, abi: fleetExecutorAbi, eventName: "PermitExecuted", ...range }),
    rpc.getContractEvents({ address: client.addresses.executor!, abi: fleetExecutorAbi, eventName: "PermitRevocation", ...range }),
    rpc.getContractEvents({ address: client.addresses.artifactStore!, abi: governedArtifactStoreAbi, eventName: "ArtifactPublished", ...range }),
  ]);
  const tasks = new Set(taskIds);
  const hashes = new Set(payloadHashes.map(value => value.toLowerCase()));
  const relevantExecutions = executions.filter(log => tasks.has(log.args.taskId.toString()));
  for (const log of relevantExecutions) hashes.add(log.args.payloadHash.toLowerCase());
  const logs = [...relevantExecutions, ...revocations.filter(log => hashes.has(log.args.payloadHash.toLowerCase())),
    ...publications.filter(log => tasks.has(log.args.taskId.toString()))];
  const events = logs.map(log => ({ ...log.args, type: log.eventName, txHash: log.transactionHash,
    blockHash: log.blockHash, blockNumber: log.blockNumber.toString(), logIndex: log.logIndex }));
  events.sort((a, b) => BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : BigInt(a.blockNumber) > BigInt(b.blockNumber) ? 1 : a.logIndex - b.logIndex);
  const artifacts = [];
  for (const taskId of tasks) {
    const [digest, revision] = await rpc.readContract({ address: client.addresses.artifactStore!, abi: governedArtifactStoreAbi,
      functionName: "artifacts", args: [BigInt(taskId)], blockNumber: block.number });
    artifacts.push({ taskId, digest, revision: revision.toString() });
  }
  // Detect a reorg during the multi-query capture rather than mixing two histories.
  if ((await rpc.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error("execution evidence block changed during capture");
  return { blockNumber: block.number.toString(), blockHash: block.hash, events, artifacts };
}
