import { keccak256, toHex } from "viem";
import type { Address, Hex, WalletClient } from "viem";
import { agoraGovernorAbi } from "@fleet/abi";
import type { FleetAddresses } from "./addresses.js";
import { ProposalState, explainRevert } from "./client.js";
import type { FleetClient } from "./client.js";

export type KeeperResult = "noop" | "queued" | "executed" | "defeated" | "canceled" | "waiting";

/** Proposal states this keeper never has to act on again once reached: it just reports which
 *  terminal outcome the proposal landed on. `Expired` (an OZ Governor `Queued` proposal whose
 *  timelock grace period elapsed without ever being executed) is reported as `"defeated"`: like a
 *  defeated proposal, it will never execute, and the result vocabulary has no separate string
 *  for it. */
function terminalResult(state: ProposalState): KeeperResult | null {
  switch (state) {
    case ProposalState.Executed:
      return "executed";
    case ProposalState.Defeated:
      return "defeated";
    case ProposalState.Canceled:
      return "canceled";
    case ProposalState.Expired:
      return "defeated";
    default:
      return null;
  }
}

/**
 * Advances one proposal through queue and execute, or reports the terminal state it is already
 * in. Every step re-reads state right before acting and simulates before sending, so running the
 * same reconciliation concurrently from multiple keepers (against the same or different accounts)
 * is safe: whichever keeper's transaction actually lands first, every other keeper's simulate or
 * state re-check simply observes the new state and stops rather than sending a redundant or
 * conflicting transaction.
 */
export type KeeperFeeLimits = {
  /** A cap on what one keeper transaction may pay per unit of gas, applied as `maxFeePerGas`. */
  maxFeePerGasWei?: bigint;
  /** A cap on how much gas one keeper transaction may use; a queue or execute estimated above it
   *  is refused rather than sent. */
  maxGas?: bigint;
};

export class Keeper {
  private readonly client: FleetClient;
  private readonly wallet: WalletClient;
  private readonly addresses: FleetAddresses;
  private readonly confirmations: number | undefined;
  private readonly feeLimits: KeeperFeeLimits;

  constructor(opts: {
    client: FleetClient;
    wallet: WalletClient;
    addresses: FleetAddresses;
    confirmations?: number;
    /** Spec 10.7's "configured fee limits" for the keeper's own sends (final review M1). The
     *  keeper is not an agent and does not go through `FleetSigner`, so its bounds are configured
     *  here instead of in a `SignerPolicy`. */
    feeLimits?: KeeperFeeLimits;
  }) {
    this.client = opts.client;
    this.wallet = opts.wallet;
    this.addresses = opts.addresses;
    this.confirmations = opts.confirmations;
    this.feeLimits = opts.feeLimits ?? {};
  }

  async reconcileProposal(proposalId: bigint): Promise<KeeperResult> {
    const state = await this.client.getProposalState(proposalId);

    const terminal = terminalResult(state);
    if (terminal) return terminal;

    if (state === ProposalState.Succeeded) {
      return this.tryAdvance(proposalId, "queue", ProposalState.Succeeded);
    }

    if (state === ProposalState.Queued) {
      // `state === Queued && block.timestamp >= proposalEta` is equivalent to
      // `timelock.isOperationReady(id)` for every operation this governor ever schedules, so
      // reading it here avoids a second contract (and the salt/hashOperationBatch bookkeeping
      // needed to compute `id` independently). The pinned Agora governor's `queue()` is the only
      // path that ever calls the timelock's `scheduleBatch`, always with `delay ==
      // timelock.getMinDelay()`, so `proposalEta` (recorded when `queue()` ran) is exactly the
      // timelock's own `_timestamps[id]`, and "ready" on the timelock is defined as `timestamp >
      // 0 && timestamp <= block.timestamp` (unless canceled, which here reads back as a
      // non-`Queued` governor state). The governor's `state()` folds that same timelock state in
      // for a `Queued` proposal, so `state`+`proposalEta` and `isOperationReady` can never
      // disagree for a proposal this keeper is looking at.
      const timing = await this.client.getProposalTiming(proposalId);
      if (timing.eta === 0n) return "waiting";
      const now = await this.client.timestamp();
      if (now < timing.eta) return "waiting";
      return this.tryAdvance(proposalId, "execute", ProposalState.Queued);
    }

    // Pending, Active: nothing for the keeper to do yet.
    return "noop";
  }

  /** Simulates `queue`/`execute` against the proposal's stored `ProposalCreated` call, re-reads
   *  state immediately before sending (the idempotency guard against a concurrent keeper), sends,
   *  and optionally waits for `confirmations` before reporting success. A simulation failure is
   *  logged (via `explainRevert`, so a hook rejection is legible) and reported as `"waiting"`
   *  rather than thrown, since another reconciliation pass may succeed once conditions change. */
  private async tryAdvance(
    proposalId: bigint,
    functionName: "queue" | "execute",
    expectedState: ProposalState,
  ): Promise<KeeperResult> {
    const created = await this.client.getProposalCreated(proposalId);
    const descriptionHash = keccak256(toHex(created.description));
    const targets = created.targets as Address[];
    const values = created.values as bigint[];
    const calldatas = created.calldatas as Hex[];

    let request: Record<string, unknown>;
    try {
      const simulated = (await this.client.publicClient.simulateContract({
        account: this.wallet.account,
        address: this.addresses.governor,
        abi: agoraGovernorAbi,
        functionName,
        args: [targets, values, calldatas, descriptionHash],
      } as never)) as { request: Record<string, unknown> };
      request = simulated.request;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`Keeper: ${functionName}(${proposalId.toString()}) simulation failed: ${explainRevert(err)}`);
      return "waiting";
    }

    const stateNow = await this.client.getProposalState(proposalId);
    if (stateNow !== expectedState) {
      const terminalNow = terminalResult(stateNow);
      if (terminalNow) return terminalNow;
      if (functionName === "queue" && stateNow === ProposalState.Queued) return "queued";
      return "waiting";
    }

    if (this.feeLimits.maxGas !== undefined) {
      try {
        const estimated = await this.client.publicClient.estimateContractGas({
          account: this.wallet.account,
          address: this.addresses.governor,
          abi: agoraGovernorAbi,
          functionName,
          args: [targets, values, calldatas, descriptionHash],
        } as never);
        if (estimated > this.feeLimits.maxGas) {
          // eslint-disable-next-line no-console
          console.error(
            `Keeper: ${functionName}(${proposalId.toString()}) needs an estimated ${estimated.toString()} gas, over the configured maxGas of ${this.feeLimits.maxGas.toString()}; not sending`,
          );
          return "waiting";
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`Keeper: ${functionName}(${proposalId.toString()}) gas estimation failed: ${explainRevert(err)}`);
        return "waiting";
      }
    }

    let txHash: Hex;
    try {
      txHash = await this.wallet.writeContract({
        ...request,
        ...(this.feeLimits.maxFeePerGasWei !== undefined ? { maxFeePerGas: this.feeLimits.maxFeePerGasWei } : {}),
      } as never);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`Keeper: ${functionName}(${proposalId.toString()}) send failed: ${explainRevert(err)}`);
      return "waiting";
    }

    if (this.confirmations !== undefined) {
      await this.client.publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: this.confirmations });
    }

    return functionName === "queue" ? "queued" : "executed";
  }
}
