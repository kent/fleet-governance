import { createWalletClient, defineChain, http, keccak256, publicActions, toHex } from "viem";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { taskLedgerAbi, timelockControllerAbi } from "@fleet/abi";
import type { FleetAddresses } from "@fleet/sdk";
import { ZERO_BYTES32, timelockSalt } from "./pipeline/timelock.js";

/**
 * The guardian actions the live run view exposes (spec 12.3: "guardian controls (pause, unpause,
 * cancel queued op) that are clearly labeled as human interventions and logged"). Deliberately
 * mirrors `pipeline/fixture-runner.ts`'s `guardianPauseAndCancel` operation-id computation exactly
 * (task 6 controller notes: "read that function and mirror it exactly"), but as three independent
 * actions rather than one combined pause-cancel-unpause helper, since the guardian route lets an
 * operator invoke each separately. `pipeline/fixture-runner.ts` itself is not imported from or
 * edited: the Part 3 fix wave is editing pipeline files concurrently, and task 7a switches
 * `fixture-runner.ts` to this module afterwards (the duplication is deliberate, recorded in the
 * task 6 report).
 */

/** The read surface `guardian.ts` needs from a chain client: structurally satisfied by a real
 *  `@fleet/sdk` `FleetClient` (production) or a hand-built fake (tests), so a route test never has
 *  to construct a real `FleetClient` against a live RPC. */
export type GuardianChainClient = {
  addresses: FleetAddresses;
  getProposalCreated(proposalId: bigint): Promise<{
    targets: readonly Address[];
    values: readonly bigint[];
    calldatas: readonly Hex[];
    description: string;
  }>;
  publicClient: {
    readContract(args: {
      address: Address;
      abi: typeof timelockControllerAbi;
      functionName: "hashOperationBatch";
      args: readonly [readonly Address[], readonly bigint[], readonly Hex[], Hex, Hex];
    }): Promise<Hex>;
    waitForTransactionReceipt(args: { hash: Hex }): Promise<{ blockNumber: bigint }>;
  };
};

/** The write surface `guardian.ts` needs from a wallet: structurally satisfied by a viem
 *  `WalletClient` (production, via `buildGuardianWallet`) or a fake `writeContract` (tests). */
export type GuardianWallet = {
  writeContract(args: {
    address: Address;
    abi: typeof taskLedgerAbi | typeof timelockControllerAbi;
    functionName: string;
    args?: readonly unknown[];
  }): Promise<Hex>;
};

export type GuardianTxResult = { txHash: Hex; blockNumber: bigint };
export type GuardianCancelResult = GuardianTxResult & { operationId: Hex };

/** Builds a real wallet client for the guardian key, signing and sending against `rpcUrl`/`chainId`
 *  (matches `pipeline/fixture-runner.ts`'s `buildWallet`). Not used by tests, which inject a fake
 *  `GuardianWallet` instead. */
export function buildGuardianWallet(opts: { rpcUrl: string; chainId: number; key: Hex }): GuardianWallet {
  const chain = defineChain({
    id: opts.chainId,
    name: `fleet-guardian-${opts.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [opts.rpcUrl] } },
  });
  const wallet = createWalletClient({ account: privateKeyToAccount(opts.key), chain, transport: http(opts.rpcUrl) }).extend(
    publicActions,
  );
  // viem's own `writeContract` type is generic over the exact ABI passed at each call site, which
  // does not structurally match `GuardianWallet`'s deliberately looser (and therefore fake-able)
  // signature; the underlying runtime call is identical either way, so this narrows the type only,
  // matching `pipeline/fixture-runner.ts`'s `buildWallet` (left untyped for the same reason).
  return wallet as unknown as GuardianWallet;
}

/** Pauses `TaskLedger` (guardian-only). */
export async function guardianPause(client: GuardianChainClient, wallet: GuardianWallet): Promise<GuardianTxResult> {
  const txHash = await wallet.writeContract({ address: client.addresses.ledger, abi: taskLedgerAbi, functionName: "pause" });
  const receipt = await client.publicClient.waitForTransactionReceipt({ hash: txHash });
  return { txHash, blockNumber: receipt.blockNumber };
}

/** Unpauses `TaskLedger` (guardian-only). */
export async function guardianUnpause(client: GuardianChainClient, wallet: GuardianWallet): Promise<GuardianTxResult> {
  const txHash = await wallet.writeContract({ address: client.addresses.ledger, abi: taskLedgerAbi, functionName: "unpause" });
  const receipt = await client.publicClient.waitForTransactionReceipt({ hash: txHash });
  return { txHash, blockNumber: receipt.blockNumber };
}

/**
 * Cancels `proposalId`'s queued timelock operation (guardian-only). Recomputes the operation id
 * independently (`AgoraGovernor`'s `_timelockIds` mapping is private) exactly the way
 * `pipeline/fixture-runner.ts`'s `guardianPauseAndCancel` does: read the proposal's own
 * `ProposalCreated` targets/values/calldatas/description, hash the description, XOR it against the
 * governor address for the timelock salt (`timelockSalt`), then `timelock.hashOperationBatch`.
 */
export async function guardianCancel(
  client: GuardianChainClient,
  wallet: GuardianWallet,
  proposalId: bigint,
): Promise<GuardianCancelResult> {
  const created = await client.getProposalCreated(proposalId);
  const descriptionHash = keccak256(toHex(created.description));
  const salt = timelockSalt(client.addresses.governor, descriptionHash);
  const operationId = await client.publicClient.readContract({
    address: client.addresses.timelock,
    abi: timelockControllerAbi,
    functionName: "hashOperationBatch",
    args: [created.targets as Address[], created.values as bigint[], created.calldatas as Hex[], ZERO_BYTES32, salt],
  });

  const txHash = await wallet.writeContract({
    address: client.addresses.timelock,
    abi: timelockControllerAbi,
    functionName: "cancel",
    args: [operationId],
  });
  const receipt = await client.publicClient.waitForTransactionReceipt({ hash: txHash });
  return { txHash, blockNumber: receipt.blockNumber, operationId };
}
