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
  | { kind: "vote"; vote: VoteV1 }
  | { kind: "absent"; why: string }
  | { kind: "malformed"; raw: string };

/** A pluggable source of ballots. In this part, the only implementation is `ScriptedPolicy`;
 *  model-backed policies arrive in Part 4. */
export interface DecisionPolicy {
  evaluateProposal(input: AnchoredProposal): Promise<PolicyOutput>;
}
