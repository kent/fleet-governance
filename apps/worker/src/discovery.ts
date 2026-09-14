import { agoraGovernorAbi } from "@fleet/abi";
import { ProposalState } from "@fleet/sdk";
import type { FleetClient } from "@fleet/sdk";
import type { JobRecord, JobState } from "@fleet/agent-runtime";

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

/** Mirrors the private `TERMINAL_STATES` set in `@fleet/agent-runtime`'s `worker.ts` (spec 10.4),
 *  which is not exported from that package. This app uses it only to decide when it can stop
 *  polling a proposal id at all; the job state machine's own terminality is that package's to
 *  own, and every value here is a `JobState` its `Worker.handleProposal` can actually return. */
const TERMINAL_JOB_STATES: ReadonlySet<JobState> = new Set([
  "voted",
  "absent",
  "worker_failed",
  "refused_for_on_mismatch",
  "missed",
  "already_voted",
]);

/** Every `ProposalState` besides `Pending` and `Active`: once a proposal leaves those two states
 *  it can never become votable again, so this worker has nothing further to do for it regardless
 *  of whether its own job ever reached a terminal state (e.g. the proposal was discovered only
 *  after its voting window had already closed). */
const NON_VOTABLE_STATES: ReadonlySet<ProposalState> = new Set([
  ProposalState.Canceled,
  ProposalState.Defeated,
  ProposalState.Succeeded,
  ProposalState.Queued,
  ProposalState.Expired,
  ProposalState.Executed,
]);

export type WorkerTickDeps = {
  listProposalIds: (fromBlock: bigint) => Promise<bigint[]>;
  getProposalState: (proposalId: bigint) => Promise<ProposalState>;
  handleProposal: (proposalId: bigint) => Promise<JobRecord>;
  fromBlock: bigint;
  /** Owned by the caller and mutated in place, so it persists across ticks within one process:
   *  a proposal id this worker will never act on again is never re-fetched. */
  terminalIds: Set<string>;
  onResult: (proposalId: bigint, state: ProposalState, job: JobRecord | null) => void;
  onError: (proposalId: bigint, error: unknown) => void;
};

/**
 * One discovery-and-handle pass: lists every proposal id since `fromBlock`, skips whatever this
 * process already knows it is done with, and for the rest reads the proposal's current governor
 * state. Only an `Active` proposal is handed to `handleProposal` (per this app's brief: "discover
 * Active proposals ... and handleProposal"); every other state is reported but otherwise a no-op
 * this tick. A single proposal's failure is reported via `onError` and does not stop the rest of
 * the pass.
 */
export async function workerTick(deps: WorkerTickDeps): Promise<void> {
  const ids = await deps.listProposalIds(deps.fromBlock);
  for (const id of ids) {
    const key = id.toString();
    if (deps.terminalIds.has(key)) continue;
    try {
      const state = await deps.getProposalState(id);
      if (state === ProposalState.Active) {
        const job = await deps.handleProposal(id);
        deps.onResult(id, state, job);
        if (TERMINAL_JOB_STATES.has(job.state)) {
          deps.terminalIds.add(key);
        }
      } else {
        deps.onResult(id, state, null);
        if (NON_VOTABLE_STATES.has(state)) {
          deps.terminalIds.add(key);
        }
      }
    } catch (err) {
      deps.onError(id, err);
    }
  }
}
