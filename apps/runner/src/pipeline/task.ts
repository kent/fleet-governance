import { createWalletClient, defineChain, http, publicActions } from "viem";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { taskLedgerAbi } from "@fleet/abi";
import type { CharterV1 } from "@fleet/schemas";
import { canonicalize } from "@fleet/schemas";
import type { FleetAddresses } from "@fleet/sdk";
import type { FleetClient } from "@fleet/sdk";

/**
 * Opens one task (`TaskLedger.openTask`) with the operator's key, a raw viem wallet rather than
 * `FleetSigner` (the operator does not propose, vote, or delegate, so it is outside `FleetSigner`'s
 * policy entirely). Returns the new task's id, read back via `TaskLedger.taskCount()` immediately
 * after the transaction confirms (task ids are assigned sequentially starting at 1).
 */
export async function openTask(opts: {
  client: FleetClient;
  addresses: FleetAddresses;
  chainId: number;
  rpcUrl: string;
  operatorKey: Hex;
  charter: CharterV1;
  lifetimeSeconds: number;
}): Promise<{ taskId: bigint; txHash: Hex; charterText: string }> {
  const chain = defineChain({
    id: opts.chainId,
    name: `fleet-runner-${opts.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [opts.rpcUrl] } },
  });
  const wallet = createWalletClient({
    account: privateKeyToAccount(opts.operatorKey),
    chain,
    transport: http(opts.rpcUrl),
  }).extend(publicActions);

  const charterText = canonicalize(opts.charter);
  const txHash = await wallet.writeContract({
    address: opts.addresses.ledger,
    abi: taskLedgerAbi,
    functionName: "openTask",
    args: [charterText, BigInt(opts.lifetimeSeconds)],
  });
  await opts.client.publicClient.waitForTransactionReceipt({ hash: txHash });

  const taskId = await opts.client.publicClient.readContract({
    address: opts.addresses.ledger,
    abi: taskLedgerAbi,
    functionName: "taskCount",
  });

  return { taskId, txHash, charterText };
}
