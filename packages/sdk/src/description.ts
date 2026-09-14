import type { Hex } from "viem";
import { DecisionV1, canonicalize } from "@fleet/schemas";
import type { DecisionKind } from "@fleet/schemas";
import { decodeRecordDecision, payloadHashForAction, payloadHashForCharter } from "./actions.js";
import { payloadHashForExecution } from "./execution.js";

/** The trailing marker the unpatched DAO Node parser requires, spec 8.2. */
export const DESCRIPTION_MARKER = "#proposalTypeId=0";

const MAX_DESCRIPTION_BYTES = 4096;

const KIND_TITLE: Record<DecisionKind, string> = {
  CHOOSE_PATH: "Choose path",
  GRANT_EXCEPTION: "Grant exception",
  AMEND_CHARTER: "Amend charter",
  STOP_TASK: "Stop task",
  ESCALATE_TO_HUMAN: "Escalate to human",
};

/** Thrown by `buildDecisionDescription` when the rendered description would exceed 4,096 bytes. */
export class DescriptionTooLongError extends Error {
  constructor(actualBytes: number) {
    super(`decision description is ${actualBytes} bytes, over the 4096 byte limit`);
    this.name = "DescriptionTooLongError";
  }
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Replaces every triple-backtick fence in user-supplied text with a neutralized, visually
 * identical sequence, so free text (summary, rationale, assumptions, risk flags) can never break
 * out of the description's own Markdown structure. Only applied to the prose copy of the text;
 * the fenced JSON block below carries the original, unescaped bytes, because that block must stay
 * byte-identical to `canonicalize(decision)` for `verifyDescriptionAgainstCalldata` and the ledger
 * hash to line up.
 */
function escapeBacktickFence(text: string): string {
  return text.replaceAll("```", "` ` `");
}

function renderListSection(label: string, items: readonly string[]): string {
  if (items.length === 0) return `**${label}.** None.`;
  const bullets = items.map((item) => `- ${escapeBacktickFence(item)}`);
  return [`**${label}.**`, ...bullets].join("\n");
}

/**
 * Builds the Markdown proposal description for a decision, spec 8.2 exactly: a human-readable
 * header and prose, a fenced canonical JSON block (`canonicalize(decision)`, unescaped), and the
 * DAO Node marker on the last line. Throws `DescriptionTooLongError` if the result exceeds the
 * contract's 4,096 byte bound.
 */
export function buildDecisionDescription(d: DecisionV1, roleLabel: string): string {
  const title = escapeBacktickFence(d.summary);
  const role = escapeBacktickFence(roleLabel);
  const summary = escapeBacktickFence(d.summary);
  const rationale = escapeBacktickFence(d.rationale);

  const lines: string[] = [
    `# ${KIND_TITLE[d.kind]}: ${title}`,
    "",
    `**Task** ${d.taskId} · **Kind** ${d.kind} · **Charter version** ${d.expectedVersion} · **Proposer** agent ${d.proposerAgentId} (${role})`,
    "",
    `**Summary.** ${summary}`,
    "",
    `**Rationale.** ${rationale}`,
    "",
    renderListSection("Assumptions", d.assumptions),
    "",
    renderListSection("Risk flags", d.riskFlags),
    "",
    "```json",
    canonicalize(d),
    "```",
    "",
    DESCRIPTION_MARKER,
  ];

  const description = lines.join("\n");
  const bytes = byteLength(description);
  if (bytes < 1 || bytes > MAX_DESCRIPTION_BYTES) {
    throw new DescriptionTooLongError(bytes);
  }
  return description;
}

/**
 * Extracts and validates the fenced canonical JSON block from a decision proposal description.
 * `markerPresent` reports whether the last line is exactly `DESCRIPTION_MARKER`; older or
 * hand-written descriptions that lack it can still be parsed, matching the DAO Node's own
 * tolerance for a missing marker (docs/compatibility-notes.md).
 */
export function parseDecisionDescription(description: string): { decision: DecisionV1; markerPresent: boolean } {
  const fenceOpen = "```json\n";
  const fenceStart = description.indexOf(fenceOpen);
  if (fenceStart === -1) {
    throw new Error("decision description has no fenced ```json block");
  }
  const contentStart = fenceStart + fenceOpen.length;
  const fenceEnd = description.indexOf("\n```", contentStart);
  if (fenceEnd === -1) {
    throw new Error("decision description's fenced ```json block is never closed");
  }
  const jsonText = description.slice(contentStart, fenceEnd);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`decision description's fenced block is not valid JSON: ${(err as Error).message}`);
  }
  const decision = DecisionV1.parse(parsedJson);

  const lines = description.split("\n");
  const lastLine = lines.at(-1) ?? "";
  return { decision, markerPresent: lastLine === DESCRIPTION_MARKER };
}

function sameHash(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Checks a proposal description's fenced decision against the decoded calldata it accompanies,
 * and against the account that actually proposed it. Spec 8.2: "the fenced JSON block is
 * canonical and its fields must match decoded calldata and the actual proposer, or the SDK
 * refuses to vote For". Reports every mismatch found, not just the first.
 *
 * The five scalar fields (`taskId`, `kind`, `expectedVersion`, `payloadHash`, `proposerAgentId`)
 * are not enough on their own: `action` and `newCharter` are the two fields of that block that
 * carry the payload a voter actually reads, and the ledger only ever sees the payload through
 * `payloadHash`/`newCharterText`. Without the checks below, a description could render a benign
 * charter or a benign action descriptor while the calldata committed to a different one, and this
 * function would still report `ok` (final review C1). So the payload the description shows must
 * hash to exactly the payload hash the calldata commits to:
 *
 * - `AMEND_CHARTER`: the description must carry `newCharter`, its canonical bytes must equal the
 *   calldata's `newCharterText`, and `keccak256(newCharterText)` must equal `payloadHash` (the
 *   same equality `TaskLedger._applyAmendment` enforces onchain);
 * - any decision carrying an `action` descriptor: `payloadHashForAction(action)` must equal
 *   `payloadHash`;
 * - anything that is not an amendment: `newCharterText` must be empty and the description must
 *   carry no `newCharter` (an amendment payload smuggled into a non-amendment kind);
 * - `GRANT_EXCEPTION` and `CHOOSE_PATH`: the description must carry the `action` its payload hash
 *   covers. A grant may instead carry one exact `execution` permit; its hash, task, version and
 *   deployment must match. An escalation may identify the same execution permit to suspend it.
 */
export function verifyDescriptionAgainstCalldata(
  description: string,
  calldata: Hex,
  proposer: { agentId: number },
  deployment?: { chainId: number; ledger: string; executor?: string },
): { ok: true } | { ok: false; mismatches: string[] } {
  const { decision } = parseDecisionDescription(description);
  const decoded = decodeRecordDecision(calldata);
  const mismatches: string[] = [];

  if (decision.taskId !== decoded.taskId.toString()) {
    mismatches.push(`taskId: description says ${decision.taskId}, calldata says ${decoded.taskId.toString()}`);
  }
  if (decision.kind !== decoded.kind) {
    mismatches.push(`kind: description says ${decision.kind}, calldata says ${decoded.kind}`);
  }
  if (decision.expectedVersion !== decoded.expectedVersion) {
    mismatches.push(
      `expectedVersion: description says ${decision.expectedVersion}, calldata says ${decoded.expectedVersion}`,
    );
  }
  if (decision.payloadHash.toLowerCase() !== decoded.payloadHash.toLowerCase()) {
    mismatches.push(`payloadHash: description says ${decision.payloadHash}, calldata says ${decoded.payloadHash}`);
  }
  if (decision.proposerAgentId !== proposer.agentId) {
    mismatches.push(
      `proposer: description names agent ${decision.proposerAgentId}, actual proposer is agent ${proposer.agentId}`,
    );
  }

  if (decoded.kind === "AMEND_CHARTER") {
    if (!decision.newCharter) {
      mismatches.push("newCharter: calldata is an AMEND_CHARTER but the description carries no newCharter object");
    } else {
      const canonicalNewCharter = canonicalize(decision.newCharter);
      if (canonicalNewCharter !== decoded.newCharterText) {
        mismatches.push(
          "newCharter: the description's charter does not canonicalize to the calldata's newCharterText",
        );
      }
    }
    const charterPayloadHash = payloadHashForCharter(decoded.newCharterText);
    if (!sameHash(charterPayloadHash, decoded.payloadHash)) {
      mismatches.push(
        `payloadHash: calldata's newCharterText hashes to ${charterPayloadHash}, calldata says ${decoded.payloadHash}`,
      );
    }
  } else {
    if (decoded.newCharterText !== "") {
      mismatches.push(`newCharterText: calldata carries charter text on a ${decoded.kind} decision, which takes none`);
    }
    if (decision.newCharter) {
      mismatches.push(`newCharter: description carries a charter on a ${decoded.kind} decision, which takes none`);
    }
  }

  if (decision.action) {
    const actionPayloadHash = payloadHashForAction(decision.action);
    if (!sameHash(actionPayloadHash, decoded.payloadHash)) {
      mismatches.push(
        `payloadHash: the description's action hashes to ${actionPayloadHash}, calldata says ${decoded.payloadHash}`,
      );
    }
  }

  if (decision.execution) {
    const permit = decision.execution;
    if (decision.action) mismatches.push("execution: cannot combine an execution permit with an action descriptor");
    if (decoded.kind !== "GRANT_EXCEPTION" && decoded.kind !== "ESCALATE_TO_HUMAN") {
      mismatches.push("execution: only GRANT_EXCEPTION or ESCALATE_TO_HUMAN may carry a permit");
    }
    if (permit.taskId !== decoded.taskId.toString() || permit.charterVersion !== decoded.expectedVersion) {
      mismatches.push("execution: permit task or charter version differs from calldata");
    }
    if (!sameHash(payloadHashForExecution(permit), decoded.payloadHash)) mismatches.push("execution: permit hash differs from calldata");
    if (deployment && (permit.chainId !== deployment.chainId || !sameHash(permit.ledger, deployment.ledger)
      || !deployment.executor || !sameHash(permit.executor, deployment.executor))) {
      mismatches.push("execution: permit belongs to a different chain, ledger or executor");
    }
  }

  if ((decoded.kind === "GRANT_EXCEPTION" && !decision.execution || decoded.kind === "CHOOSE_PATH") && !decision.action) {
    mismatches.push(`action: calldata is a ${decoded.kind} but the description carries no action descriptor`);
  }

  if (mismatches.length > 0) return { ok: false, mismatches };
  return { ok: true };
}
