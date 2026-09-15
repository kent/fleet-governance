import { fleetHookAbi } from "@fleet/abi";
import type { ManifestV1 } from "@fleet/schemas";
import { FleetClient, addressesFromManifest } from "@fleet/sdk";

/**
 * Builds a read-only `FleetClient` for `manifest`, pointed at `rpcUrl`. A manifest carries chain
 * id and contract addresses but not an RPC endpoint (task 6 controller notes: "FleetClient from
 * the run's manifest (addressesFromManifest)"); the caller supplies the endpoint from the run's
 * experiment config (`target.rpcHttp`).
 */
export function buildFleetClientFromManifest(manifest: ManifestV1, rpcUrl: string): FleetClient {
  return new FleetClient({ rpcUrl, chainId: manifest.chainId, deploymentBlock: BigInt(manifest.deploymentBlock), addresses: addressesFromManifest(manifest) });
}

/**
 * Scans `FleetHook.DecisionProposed` logs for every proposal id raised against `taskId`, from
 * `fromBlock` (a manifest's `deploymentBlock`) to the chain tip. Task 6 controller notes' fallback
 * when a run's stage payload does not already name its proposal ids: "otherwise scan
 * DecisionProposed logs on the ledger from manifest.deploymentBlock for the run's taskId." Kept
 * here rather than in `@fleet/sdk` per the same notes ("add a small ... helper to
 * src/lib/chain.ts; do not put it in @fleet/sdk"). Returns ids in the order their
 * `DecisionProposed` log was found, deduplicated.
 */
export async function listTaskProposalIds(
  client: FleetClient,
  taskId: bigint,
  fromBlock: bigint,
): Promise<bigint[]> {
  const logs = await client.publicClient.getContractEvents({
    address: client.addresses.hook,
    abi: fleetHookAbi,
    eventName: "DecisionProposed",
    args: { taskId },
    fromBlock,
    toBlock: "latest",
  });
  const ids: bigint[] = [];
  const seen = new Set<string>();
  for (const log of logs) {
    const id = log.args.proposalId;
    if (id === undefined) continue;
    const key = id.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(id);
  }
  return ids;
}
