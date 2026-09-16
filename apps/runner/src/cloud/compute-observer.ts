import { BaseError, ContractFunctionRevertedError, createPublicClient, http, keccak256, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { agoraGovernorAbi } from "@fleet/abi";
import { logBoundedHttp } from "@fleet/sdk";
import { discoverTaskProposals } from "./proposal-discovery.js";
import type { ComputeAllocation, ComputeObservation } from "./compute-policy.js";

/** Independent of the worker, its manifest, Agora and model-generated claims. The
 * human-issued allocation supplies the contract and exact proposal IDs to observe. */
export async function observeComputeApproval(allocation: ComputeAllocation, rpcUrl: string): Promise<ComputeObservation> {
  const client = createPublicClient({ chain: baseSepolia, transport: allocation.discovery
    ? logBoundedHttp(rpcUrl, BigInt(allocation.discovery.startBlock)) : http(rpcUrl, { timeout: 10_000, retryCount: 1 }) });
  const chainId = await client.getChainId();
  if (chainId !== allocation.chainId) throw new Error("Compute policy chain did not match.");
  const head = await client.getBlockNumber();
  if (head < 2n) throw new Error("No confirmed compute policy observation is available.");
  const blockNumber = head - 2n;
  const block = await client.getBlock({ blockNumber });
  if (!block.hash) throw new Error("Unconfirmed compute policy observation.");
  const bytecode = await client.getBytecode({ address: allocation.governor as Hex, blockNumber });
  if (!bytecode || bytecode === "0x") throw new Error("Compute policy Governor has no code.");
  const proposals: ComputeObservation["proposals"] = [];
  if (allocation.discovery) proposals.push(...await discoverTaskProposals(client, allocation, blockNumber));
  // Bound RPC concurrency independently of agent count and of worker requests.
  for (let index = 0; index < allocation.requiredProposalIds.length; index += 4) {
    proposals.push(...await Promise.all(allocation.requiredProposalIds.slice(index, index + 4).map(async proposalId => {
      try {
        return { proposalId, state: Number(await client.readContract({ address: allocation.governor as Hex, abi: agoraGovernorAbi,
          functionName: "state", args: [BigInt(proposalId)], blockNumber })) };
      } catch (error) {
        const reverted = error instanceof BaseError ? error.walk(cause => cause instanceof ContractFunctionRevertedError) : undefined;
        if (allocation.checkpoints && reverted instanceof ContractFunctionRevertedError
          && reverted.data?.errorName === "GovernorNonexistentProposal" && reverted.data.args?.[0] === BigInt(proposalId)) {
          return { proposalId, state: -1 };
        }
        throw error;
      }
    })));
  }
  const confirmed = await client.getBlock({ blockNumber });
  if (confirmed.hash !== block.hash) throw new Error("Compute policy observation changed during verification.");
  return { chainId, governor: allocation.governor, governorCodeHash: keccak256(bytecode),
    blockNumber: blockNumber.toString(), blockHash: block.hash, blockTimestamp: Number(block.timestamp), proposals,
    ...(allocation.discovery ? { discoveryVerified: true } : {}) };
}
