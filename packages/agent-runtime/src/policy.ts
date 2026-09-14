import type { Hex } from "viem";
import type { CharterV1, DecisionV1, VoteV1 } from "@fleet/schemas";
import type { ProposalCreatedView, TaskView } from "@fleet/sdk";

/**
 * One proposal, anchored to a specific chain state, ready for a policy to reason about. Read
 * together at one block (spec 10.4 "READ_ANCHORED_STATE"), so a policy never sees a mix of state
 * from different points in chain history.
 *
 * `decision` is `null` when the proposal's description does not parse as a fenced
 * `fleet.decision.v1` block (`parseDecisionDescription` threw); `verificationOk` is `false`
 * whenever the decision cannot be parsed, the proposer cannot be resolved to a registered member,
 * or `verifyDescriptionAgainstCalldata` reports a mismatch. `charter` is the anchored task's own
 * charter (never null: a task whose charter text will not parse is a worker failure, handled
 * before a policy ever sees it).
 */
export type AnchoredProposal = {
  blockNumber: bigint;
  blockHash: Hex;
  proposal: ProposalCreatedView;
  decision: DecisionV1 | null;
  task: TaskView;
  charter: CharterV1;
  member: { agentId: number; role: string; manifest: string };
  verificationOk: boolean;
};

/**
 * What a `DecisionPolicy` decides for one agent on one proposal. `"vote"` carries the ballot to
 * cast; `"absent"` means the policy deliberately declines to vote (nothing is cast, and this is
 * not an error); `"malformed"` means the policy's own output could not be turned into a valid
 * vote (a worker failure, never a For, never a synthesized Abstain, spec 10.6).
 */
export type PolicyOutput =
  | { kind: "vote"; vote: VoteV1; meta?: PolicyMeta }
  | { kind: "absent"; why: string; meta?: PolicyMeta }
  | { kind: "malformed"; raw: string; meta?: PolicyMeta };

/**
 * What a model-backed policy can tell the `Worker` about the inference behind its output, so the
 * job record's provider, model, prompt version, latency and usage columns (spec 10.4) carry real
 * values instead of the `null`s a scripted policy leaves. Present on every `PolicyOutput` variant,
 * including the failures: a timeout or a malformed reply still cost tokens and latency, and a
 * record that hides that cannot be used to compute spec 15.5's metrics honestly.
 *
 * Optional everywhere. `ScriptedPolicy` has no provider or model and leaves it undefined, and the
 * `Worker` writes nothing for an output that does not carry it.
 */
export type PolicyMeta = {
  provider: string;
  model: string;
  promptVersion: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
};

/** A pluggable source of ballots: `ScriptedPolicy` for fixture runs, `ModelPolicy` for the
 *  model-driven ones. */
export interface DecisionPolicy {
  evaluateProposal(input: AnchoredProposal): Promise<PolicyOutput>;
}
