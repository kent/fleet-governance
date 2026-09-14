import { agoraGovernorAbi } from "@fleet/abi";
import type { FleetClient, KeeperResult } from "@fleet/sdk";

/**
 * Reads every `ProposalCreated` log on the governor from `fromBlock` to the chain tip and returns
 * the distinct proposal ids seen. `proposalId` is not an indexed field on this event (see
 * `FleetClient.getProposalCreated`'s own note on this), so there is no narrower filter to apply;
 * this necessarily scans and decodes every log in range.
 */
export async function listProposalIds(client: FleetClient, fromBlock: bigint): Promise<bigint[]> {
  const logs = await client.publicClient.getContractEvents({
    address: client.addresses.governor,
    abi: agoraGovernorAbi,
    eventName: "ProposalCreated",
    fromBlock,
    toBlock: "latest",
  });
  const ids = new Set<bigint>();
  for (const log of logs) {
    if (log.args.proposalId !== undefined) ids.add(log.args.proposalId);
  }
  return [...ids];
}

/** `KeeperResult`s that mean this keeper never has to look at a proposal again. `"queued"`,
 *  `"waiting"`, and `"noop"` are deliberately excluded: each of those means the proposal may
 *  still need another reconciliation pass. */
const TERMINAL_KEEPER_RESULTS: ReadonlySet<KeeperResult> = new Set(["executed", "defeated", "canceled"]);

export type KeeperTickDeps = {
  listProposalIds: (fromBlock: bigint) => Promise<bigint[]>;
  reconcileProposal: (proposalId: bigint) => Promise<KeeperResult>;
  fromBlock: bigint;
  /** Owned by the caller and mutated in place, so it persists across ticks within one process:
   *  a proposal already reconciled to a terminal outcome is never re-fetched or re-reconciled. */
  terminalIds: Set<string>;
  onResult: (proposalId: bigint, result: KeeperResult) => void;
  onError: (proposalId: bigint, error: unknown) => void;
};

/**
 * One discovery-and-reconcile pass: lists every proposal id since `fromBlock`, skips whatever
 * this process already watched to a terminal outcome, and reconciles the rest. A single
 * proposal's failure is reported via `onError` and does not stop the rest of the pass, so one bad
 * RPC read never blocks every other proposal's reconciliation this tick.
 */
export async function keeperTick(deps: KeeperTickDeps): Promise<void> {
  const ids = await deps.listProposalIds(deps.fromBlock);
  for (const id of ids) {
    const key = id.toString();
    if (deps.terminalIds.has(key)) continue;
    try {
      const result = await deps.reconcileProposal(id);
      deps.onResult(id, result);
      if (TERMINAL_KEEPER_RESULTS.has(result)) {
        deps.terminalIds.add(key);
      }
    } catch (err) {
      deps.onError(id, err);
    }
  }
}
