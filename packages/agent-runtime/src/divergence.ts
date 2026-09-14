import type { Hex } from "viem";
import { canonicalize } from "@fleet/schemas";
import type { ActionDescriptor, CharterV1, DecisionKind, DecisionV1 } from "@fleet/schemas";
import { describeAction } from "@fleet/gateway";
import type { DraftProposal } from "@fleet/gateway";
import { buildDecisionDescription, payloadHashForAction, payloadHashForPath } from "@fleet/sdk";
import type { ToolCall } from "./sandbox/tools.js";
import type { Step } from "./coordinator.js";

/**
 * The two divergence triggers of spec 10.3, and the only two: a gateway block the agent wants to
 * do something about, and an explicit objection to the coordinator's published step. There is no
 * third trigger, and no free-form proposal: everything an agent can put on chain goes through
 * `toDecision` below, which is deterministic code, not model output.
 */
export type Divergence =
  | { source: "gateway_block"; agentId: number; draft: DraftProposal; blockedTool: ToolCall }
  | { source: "objection"; agentId: number; step: Step; alternative: ToolCall };

/**
 * The task-level facts a divergence needs to become a decision. `rationale` is the model's own
 * words (an objection's `why`, a block response's `rationale`): the only model-authored text in
 * the decision, and it lands in `rationale`, never in a field the chain reads.
 */
export type DivergenceContext = {
  taskId: bigint;
  charterVersion: number;
  agentId: number;
  charter: CharterV1;
  rationale: string;
  assumptions?: string[];
  riskFlags?: string[];
};

/** `DecisionV1.summary`'s upper bound. A draft summary is short in practice; this clamp exists so
 *  a long one can never make an otherwise valid decision fail its own schema. */
const MAX_SUMMARY_LENGTH = 1024;

/**
 * `DecisionV1` puts no bound on `rationale`, but the proposal description built from it does: spec
 * 8.2 caps a description at 4,096 bytes, and the rationale lands in it twice (once as prose, once
 * inside the canonical JSON block). A model that answers at length would otherwise produce a
 * decision that can never be proposed. Clamped to the same bound as the summary, which leaves room
 * for both copies plus the summary and the scaffolding.
 */
const MAX_RATIONALE_LENGTH = 1024;

/** Used only if a caller supplies an empty rationale, which the `fleet.objection.v1` and
 *  `fleet.blockresponse.v1` schemas already rule out (both require a non-empty string). Keeps
 *  `toDecision` total rather than letting it throw mid-loop. */
const MISSING_RATIONALE = "(no rationale recorded)";

function clampSummary(summary: string): string {
  return summary.length > MAX_SUMMARY_LENGTH ? summary.slice(0, MAX_SUMMARY_LENGTH) : summary;
}

function descriptorFor(tool: ToolCall): ActionDescriptor {
  return describeAction({ class: tool.class, target: tool.target, args: tool.args });
}

/**
 * Rewrites any gateway draft as an `ESCALATE_TO_HUMAN` over the blocked action itself, for the
 * `"escalate"` branch of `fleet.blockresponse.v1`.
 *
 * The payload hash is deliberately the blocked action's (`payloadHashForAction(describeAction
 * (blockedTool))`), not whatever the draft carried. Escalation is per payload and the gateway
 * checks it as `escalationVersion(payloadHashForAction(descriptor))` (`evaluate.ts`), so an
 * escalation recorded against some other hash would block nothing at all. For a `GRANT_EXCEPTION`
 * draft the two are already the same hash; they differ only for `AMEND_CHARTER`, whose draft hash
 * covers the proposed charter text rather than the action.
 */
export function escalationDraft(blockedTool: ToolCall, draft: DraftProposal): DraftProposal {
  const descriptor = descriptorFor(blockedTool);
  if (draft.kind === "ESCALATE_TO_HUMAN") {
    return { kind: "ESCALATE_TO_HUMAN", payloadHash: payloadHashForAction(descriptor), summary: draft.summary };
  }
  return {
    kind: "ESCALATE_TO_HUMAN",
    payloadHash: payloadHashForAction(descriptor),
    summary: `Escalate to human: ${blockedTool.class} ${blockedTool.target}`,
  };
}

/**
 * Turns one divergence into the `fleet.decision.v1` object that will be proposed. Every field the
 * chain reads (kind, expected charter version, payload hash, new charter text) comes from code and
 * from the gateway's own draft; the model contributes the rationale and nothing else.
 *
 * - A gateway block becomes the draft's own kind. `GRANT_EXCEPTION` and `ESCALATE_TO_HUMAN` carry
 *   the blocked action's descriptor as `action` and the draft's payload hash (which, for both, is
 *   that descriptor's hash). `AMEND_CHARTER` carries `newCharter` and the draft's charter-text
 *   hash instead, and no `action`: its payload is the charter, not one call.
 * - An objection becomes a `CHOOSE_PATH` over the alternative's descriptor, hashed with
 *   `payloadHashForPath`, so the payload hash covers exactly the path being chosen.
 */
export function toDecision(d: Divergence, ctx: DivergenceContext): DecisionV1 {
  const supplied = ctx.rationale.trim().length > 0 ? ctx.rationale : MISSING_RATIONALE;
  const rationale = supplied.length > MAX_RATIONALE_LENGTH ? supplied.slice(0, MAX_RATIONALE_LENGTH) : supplied;
  const base = {
    schema: "fleet.decision.v1",
    taskId: ctx.taskId.toString(),
    expectedVersion: ctx.charterVersion,
    proposerAgentId: ctx.agentId,
    rationale,
    assumptions: ctx.assumptions ?? [],
    riskFlags: ctx.riskFlags ?? [],
  } as const;

  if (d.source === "objection") {
    const descriptor = descriptorFor(d.alternative);
    return {
      ...base,
      kind: "CHOOSE_PATH" satisfies DecisionKind,
      payloadHash: payloadHashForPath(descriptor),
      action: descriptor,
      summary: clampSummary(
        `Choose path: ${d.alternative.class} ${d.alternative.target} instead of the coordinator's step ${d.step.seq}`,
      ),
    };
  }

  if (d.draft.kind === "AMEND_CHARTER") {
    return {
      ...base,
      kind: "AMEND_CHARTER",
      payloadHash: d.draft.payloadHash,
      newCharter: d.draft.newCharter ?? ctx.charter,
      summary: clampSummary(d.draft.summary),
    };
  }

  return {
    ...base,
    kind: d.draft.kind,
    payloadHash: d.draft.payloadHash,
    action: descriptorFor(d.blockedTool),
    summary: clampSummary(d.draft.summary),
  };
}

/** Exactly `FleetSigner.propose`'s input. Kept as its own type so the Runner (Task 7) can hand a
 *  decision straight to a signer without rebuilding any of it. */
export type ProposeInput = {
  taskId: bigint;
  kind: DecisionKind;
  expectedVersion: number;
  payloadHash: Hex;
  newCharterText: string;
  summary: string;
  description: string;
};

/**
 * Converts a decision into the call `FleetSigner.propose` takes. `newCharterText` is the canonical
 * JSON of `newCharter` when there is one and `""` otherwise, matching how the gateway hashes an
 * `AMEND_CHARTER` draft (`payloadHashForCharter(canonicalize(newCharter))`) and what
 * `TaskLedger._applyAmendment` hashes on chain, so the proposal's payload hash and its charter
 * text agree. `description` is the spec 8.2 markdown, fenced canonical decision included.
 */
export function decisionToProposeInput(d: DecisionV1, roleLabel: string): ProposeInput {
  return {
    taskId: BigInt(d.taskId),
    kind: d.kind,
    expectedVersion: d.expectedVersion,
    payloadHash: d.payloadHash as Hex,
    newCharterText: d.newCharter ? canonicalize(d.newCharter) : "",
    summary: d.summary,
    description: buildDecisionDescription(d, roleLabel),
  };
}
