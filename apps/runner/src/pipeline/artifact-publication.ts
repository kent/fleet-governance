import { decodeEventLog, decodeFunctionData, keccak256 } from "viem";
import type { Hex } from "viem";
import { governedArtifactStoreAbi } from "@fleet/abi";
import { artifactPublicationPermit, payloadHashForExecution } from "@fleet/sdk";
import type { FleetClient, FleetSigner } from "@fleet/sdk";
import type { ArtifactPublisher } from "@fleet/agent-runtime";

/** No generic contract call is exposed to the model. This adapter only builds publication of
 * the bytes the workspace reader hashed and waits for the resource's actual publication event. */
export function artifactPublisher(client: FleetClient, signer: FleetSigner): ArtifactPublisher | undefined {
  const { artifactStore, executor } = client.addresses;
  if (!artifactStore || !executor) return undefined;
  return {
    async prepare(digest, snapshot) {
      const code = await client.publicClient.getCode({ address: artifactStore, blockNumber: snapshot.blockNumber });
      if (!code || code === "0x") throw new Error("artifact store has no code at the recorded block");
      return artifactPublicationPermit({ chainId: client.chainId, addresses: client.addresses,
        actor: signer.address, taskId: snapshot.taskId, charterVersion: snapshot.charterVersion,
        digest, targetCodeHash: keccak256(code), expiresAt: snapshot.expiresAt });
    },
    async execute(permit) {
      const expected = decodeFunctionData({ abi: governedArtifactStoreAbi, data: permit.data as Hex });
      if (expected.functionName !== "publish" || permit.target.toLowerCase() !== artifactStore.toLowerCase()) {
        throw new Error("publication adapter accepts only the configured store's publish call");
      }
      const { txHash } = await signer.executePermit(permit);
      const receipt = await client.publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") throw new Error(`artifact publication reverted: ${txHash}`);
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== artifactStore.toLowerCase()) continue;
        try {
          const event = decodeEventLog({ abi: governedArtifactStoreAbi, data: log.data, topics: log.topics });
          if (event.eventName === "ArtifactPublished" && event.args.taskId === BigInt(permit.taskId)
            && event.args.digest === expected.args[0]) {
            return JSON.stringify({ taskId: permit.taskId, digest: event.args.digest,
              revision: event.args.revision.toString(), txHash, payloadHash: payloadHashForExecution(permit),
              blockNumber: receipt.blockNumber.toString() });
          }
        } catch { /* Other events are not publication evidence. */ }
      }
      throw new Error(`publication receipt has no matching artifact event: ${txHash}`);
    },
  };
}
