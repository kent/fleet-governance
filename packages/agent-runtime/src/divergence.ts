import type { Hex } from "viem";
import { canonicalize } from "@fleet/schemas";
import type { ActionDescriptor, CharterV1, DecisionKind, DecisionV1 } from "@fleet/schemas";
import { describeAction } from "@fleet/gateway";
import type { DraftProposal } from "@fleet/gateway";
import { buildDecisionDescription, payloadHashForAction, payloadHashForPath, payloadHashForExecution } from "@fleet/sdk";
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

/**
 * The bound `FleetSigner.propose` enforces on a proposal description (spec 8.2), and the real
 * reason every free-text field here is clamped.
 *
 * `buildDecisionDescription` renders the summary three times (the title, the prose summary, and
 * the canonical JSON block), the rationale twice (prose and JSON), the assumptions and risk flags
 * twice each, and the action descriptor's full `target` once inside the JSON. A decision that
 * bursts this bound throws inside the Runner's `propose` path, which means a gateway block that
 * never reaches the chain and a dissent that is silently lost: exactly the failure this clamping
 * exists to prevent.
 */
const DESCRIPTION_BYTE_LIMIT = 4096;

/** Headroom kept free of the limit, for the fixed skeleton growing in a later spec revision. */
const DESCRIPTION_SAFETY_MARGIN = 64;

/** `toDecision` does not know the `roleLabel` the Runner will render with, so it measures against
 *  a placeholder of the longest label it will accept. A real label (`"safety_reviewer"`) is far
 *  shorter, so measuring with this can only over-reserve. */
const MAX_ROLE_LABEL_BYTES = 64;
const ROLE_LABEL_PLACEHOLDER = "x".repeat(MAX_ROLE_LABEL_BYTES);

/** Starting clamps. `3 * 240 + 2 * 1200 = 3120` bytes of free text, which fits alongside a
 *  typical descriptor and the fixed skeleton; `fitDescription` shrinks them further whenever the
 *  parts that cannot be truncated (a long `action.target`, an amendment's canonical charter text)
 *  need the room. */
const MAX_SUMMARY_BYTES = 240;
const MAX_RATIONALE_BYTES = 1200;

/** Floors: below these a decision stops being readable, so `fitDescription` gives up rather than
 *  shrinking to nothing. A decision that still does not fit is one whose untruncatable parts alone
 *  exceed the bound, and the Runner reports the failed propose. */
const MIN_SUMMARY_BYTES = 60;
const MIN_RATIONALE_BYTES = 80;

/** The target is echoed inside the summary text this module builds; the descriptor keeps the full
 *  one, because its hash is what the gateway and the ledger key on. */
const MAX_TARGET_BYTES_IN_SUMMARY = 120;

/** Assumptions and risk flags are caller-supplied and unbounded, and land in the description
 *  twice each. */
const MAX_LIST_ITEMS = 5;
const MAX_LIST_ITEM_BYTES = 120;

/** Used only if a caller supplies an empty rationale, which the `fleet.objection.v1` and
 *  `fleet.blockresponse.v1` schemas already rule out (both require a non-empty string). Keeps
 *  `toDecision` total rather than letting it throw mid-loop. */
const MISSING_RATIONALE = "(no rationale recorded)";

const ELLIPSIS = "...";

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Truncates `text` to at most `maxBytes` UTF-8 bytes, appending `"..."` when anything was cut.
 * Iterates by code point, so a multi-byte sequence is never cut in half (a byte-slice would leave
 * a replacement character in the middle of a proposal description that voters have to read).
 */
export function truncateBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const budget = Math.max(0, maxBytes - ELLIPSIS.length);
  let used = 0;
  let out = "";
  for (const char of text) {
    const size = byteLength(char);
    if (used + size > budget) break;
    used += size;
    out += char;
  }
  return `${out}${ELLIPSIS}`;
}

function clampList(items: readonly string[] | undefined): string[] {
  return (items ?? []).slice(0, MAX_LIST_ITEMS).map((item) => truncateBytes(item, MAX_LIST_ITEM_BYTES));
}

function descriptorFor(tool: ToolCall): ActionDescriptor {
  return describeAction({ class: tool.class, target: tool.target, args: tool.args });
}

/** The rendered description's byte length, or `null` when `buildDecisionDescription` refused to
 *  render it at all (it throws over the same bound this is measuring against). */
function renderedBytes(decision: DecisionV1): number | null {
  try {
    return byteLength(buildDecisionDescription(decision, ROLE_LABEL_PLACEHOLDER));
  } catch {
    return null;
  }
}

/**
 * Builds the decision at progressively tighter clamps until its rendered description fits inside
 * `DESCRIPTION_BYTE_LIMIT`. The rationale gives way first (it is the longest free-text field and
 * the least load-bearing for a voter scanning a list), then the summary. Deterministic: the same
 * inputs always produce the same clamps, and the loop is bounded by the halving schedule.
 */
function fitDescription(build: (summaryBytes: number, rationaleBytes: number) => DecisionV1): DecisionV1 {
  let summaryBytes = MAX_SUMMARY_BYTES;
  let rationaleBytes = MAX_RATIONALE_BYTES;

  for (;;) {
    const candidate = build(summaryBytes, rationaleBytes);
    const bytes = renderedBytes(candidate);
    if (bytes !== null && bytes <= DESCRIPTION_BYTE_LIMIT - DESCRIPTION_SAFETY_MARGIN) return candidate;

    if (rationaleBytes > MIN_RATIONALE_BYTES) {
      rationaleBytes = Math.max(MIN_RATIONALE_BYTES, Math.floor(rationaleBytes / 2));
      continue;
    }
    if (summaryBytes > MIN_SUMMARY_BYTES) {
      summaryBytes = Math.max(MIN_SUMMARY_BYTES, Math.floor(summaryBytes / 2));
      continue;
    }
    // Nothing left to give: the untruncatable parts alone (an enormous `action.target`, or an
    // amendment's canonical charter text) exceed the bound.
    return candidate;
  }
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
  if (draft.execution) return { ...draft, kind: "ESCALATE_TO_HUMAN",
    payloadHash: payloadHashForExecution(draft.execution), summary: `Escalate artifact publication: ${blockedTool.target}` };
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
  if (d.source === "gateway_block" && d.draft.execution) {
    const permit = d.draft.execution;
    if (permit.taskId !== ctx.taskId.toString() || permit.charterVersion !== ctx.charterVersion
      || payloadHashForExecution(permit).toLowerCase() !== d.draft.payloadHash.toLowerCase()
      || (d.draft.kind !== "GRANT_EXCEPTION" && d.draft.kind !== "ESCALATE_TO_HUMAN")) {
      throw new Error("execution draft no longer matches the current task and charter");
    }
    return fitDescription((summaryBytes, rationaleBytes) => ({
      schema: "fleet.decision.v1", taskId: ctx.taskId.toString(), expectedVersion: ctx.charterVersion,
      proposerAgentId: ctx.agentId, kind: d.draft.kind, payloadHash: d.draft.payloadHash,
      execution: permit, summary: truncateBytes(d.draft.summary, summaryBytes),
      rationale: truncateBytes(ctx.rationale || MISSING_RATIONALE, rationaleBytes),
      assumptions: clampList(ctx.assumptions), riskFlags: clampList(ctx.riskFlags),
    }));
  }
  if (d.source === "gateway_block" && d.draft.kind === "AMEND_CHARTER" && !d.draft.newCharter) {
    // The draft's payload hash is `keccak256(canonicalize(newCharter))`; substituting the current
    // charter would produce an amendment whose text and hash disagree, which the ledger would
    // reject and which would read to a voter as a proposal to change nothing.
    throw new Error("toDecision: an AMEND_CHARTER draft must carry the newCharter its payload hash covers");
  }

  const suppliedRationale = ctx.rationale.trim().length > 0 ? ctx.rationale : MISSING_RATIONALE;
  const assumptions = clampList(ctx.assumptions);
  const riskFlags = clampList(ctx.riskFlags);

  return fitDescription((summaryBytes, rationaleBytes): DecisionV1 => {
    const base = {
      schema: "fleet.decision.v1",
      taskId: ctx.taskId.toString(),
      expectedVersion: ctx.charterVersion,
      proposerAgentId: ctx.agentId,
      rationale: truncateBytes(suppliedRationale, rationaleBytes),
      assumptions,
      riskFlags,
    } as const;

    if (d.source === "objection") {
      const descriptor = descriptorFor(d.alternative);
      const target = truncateBytes(d.alternative.target, MAX_TARGET_BYTES_IN_SUMMARY);
      return {
        ...base,
        kind: "CHOOSE_PATH" satisfies DecisionKind,
        payloadHash: payloadHashForPath(descriptor),
        action: descriptor,
        summary: truncateBytes(
          `Choose path: ${d.alternative.class} ${target} instead of the coordinator's step ${d.step.seq}`,
          summaryBytes,
        ),
      };
    }

    if (d.draft.kind === "AMEND_CHARTER") {
      return {
        ...base,
        kind: "AMEND_CHARTER",
        payloadHash: d.draft.payloadHash,
        // Never truncated: `newCharterText` must canonicalize to exactly the bytes the payload
        // hash covers.
        newCharter: d.draft.newCharter,
        summary: truncateBytes(d.draft.summary, summaryBytes),
      };
    }

    return {
      ...base,
      kind: d.draft.kind,
      payloadHash: d.draft.payloadHash,
      // Never truncated either: `payloadHashForAction(action)` has to keep matching the hash the
      // gateway blocked on and the ledger will key an exception by.
      action: descriptorFor(d.blockedTool),
      summary: truncateBytes(d.draft.summary, summaryBytes),
    };
  });
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
