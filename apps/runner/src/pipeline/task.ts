import { createWalletClient, decodeEventLog, defineChain, http, publicActions } from "viem";
import type { Hex, Log } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { taskLedgerAbi } from "@fleet/abi";
import type { CharterV1 } from "@fleet/schemas";
import { canonicalize } from "@fleet/schemas";
import type { FleetAddresses } from "@fleet/sdk";
import type { FleetClient } from "@fleet/sdk";

/**
 * Opens one task (`TaskLedger.openTask`) with the operator's key, a raw viem wallet rather than
 * `FleetSigner` (the operator does not propose, vote, or delegate, so it is outside `FleetSigner`'s
 * policy entirely). Returns the new task's id, decoded from this transaction's own `TaskOpened`
 * log.
 *
 * Final review M4: the id used to come from `TaskLedger.taskCount()` read after the transaction
 * confirmed, so any other task opened between the send and the read (a second runner, a manual
 * `fleet open-task`) yielded the wrong id and every later stage drove the wrong task. A receipt's
 * own logs cannot be raced.
 */
export async function openTask(opts: {
  client: FleetClient;
  addresses: FleetAddresses;
  chainId: number;
  rpcUrl: string;
  operatorKey: Hex;
  charter: CharterV1;
  lifetimeSeconds: number;
}): Promise<{ taskId: bigint; txHash: Hex; charterText: string; blockNumber: bigint }> {
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
  const receipt = await opts.client.publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: opts.chainId === 84532 ? 2 : 1 });
  const taskId = taskIdFromReceiptLogs(receipt.logs, opts.addresses.ledger);

  return { taskId, txHash, charterText, blockNumber: receipt.blockNumber };
}

/** Finds this transaction's own `TaskOpened(uint256 indexed taskId, ...)` log, emitted by the
 *  ledger, and returns its task id. Logs from any other contract, and any ledger log that is not
 *  `TaskOpened`, are skipped. Exported so the decode is directly testable without a chain. */
export function taskIdFromReceiptLogs(logs: readonly Log[], ledger: string): bigint {
  for (const log of logs) {
    if (log.address.toLowerCase() !== ledger.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: taskLedgerAbi, data: log.data, topics: log.topics });
      if (decoded.eventName === "TaskOpened") {
        return decoded.args.taskId;
      }
    } catch {
      // Not an event this ABI knows; keep looking.
    }
  }
  throw new Error("openTask: the transaction receipt carries no TaskOpened log from the ledger");
}
