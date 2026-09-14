import type { Hex } from "viem";
import { canonicalize } from "@fleet/schemas";
import type { ActionClass, ActionDescriptor, CharterV1 } from "@fleet/schemas";
import { payloadHashForAction, payloadHashForCharter } from "@fleet/sdk";

/**
 * The gateway's view of one task's ledger state, as of one point in time. `exceptionVersion` and
 * `escalationVersion` are per-payload lookups (`TaskLedger.exceptionVersion` /
 * `escalationVersion`), not fields, because they are keyed by the specific action's payload hash,
 * not known until an `ActionDescriptor` is evaluated.
 *
 * Deviation from the task brief's abbreviated interface: the brief writes these two fields as
 * plain synchronous functions (`(payloadHash: Hex) => number`). `packages/sdk/src/client.ts`'s
 * `FleetClient.exceptionVersion`/`escalationVersion` are real RPC reads and return `Promise
 * <number>`; `LedgerWatcher.snapshot()`'s decision doc explicitly says the returned closures "call
 * the client (memoise per snapshot)". A synchronous function cannot honestly wrap an
 * asynchronous chain read for a payload hash it has not already resolved, and faking one with a
 * default value would mean guessing "not escalated" or "no exception" before the read completes,
 * which is exactly the fail-open failure mode this whole package exists to avoid. So both fields,
 * and `evaluateAction` itself, are async here. See task-5-report.md.
 */
export type LedgerSnapshot = {
  taskId: bigint;
  state: "Open" | "Stopped" | "Completed" | "Expired";
  expiresAt: bigint;
  charterVersion: number;
  charter: CharterV1;
  paused: boolean;
  openEscalations: number;
  exceptionVersion: (payloadHash: Hex) => Promise<number>;
  escalationVersion: (payloadHash: Hex) => Promise<number>;
  blockNumber: bigint;
  now: bigint;
};

export type GatewayVerdict =
  | { verdict: "ALLOW"; basis: "charter" | "exception"; payloadHash: Hex }
  | {
      verdict: "BLOCK";
      reason:
        | "task_not_open"
        | "expired"
        | "paused"
        | "escalated"
        | "class_not_allowed"
        | "target_not_allowlisted"
        | "forbidden_action"
        | "budget_exhausted"
        /** A per-payload ledger read (`exceptionVersion`/`escalationVersion`) failed. The snapshot
         *  itself already fails closed on a read failure (`LedgerWatcher.snapshot` returns
         *  `paused: true`), but these two are per-payload closures evaluated here, and a rejection
         *  used to escape `evaluateAction` as a thrown promise instead of a verdict. Every caller
         *  treated a throw as a failure rather than an allow, so the behaviour was safe, but the
         *  fail-closed guarantee lived in the callers rather than in the gateway (final review
         *  M2). */
        | "ledger_unreadable";
      payloadHash: Hex;
      draft: DraftProposal | null;
    };

export type DraftProposal = {
  kind: "GRANT_EXCEPTION" | "AMEND_CHARTER" | "ESCALATE_TO_HUMAN";
  payloadHash: Hex;
  summary: string;
  newCharter?: CharterV1;
};

/** `network_fetch` and `package_install` are the only classes with a target-host allowlist rule. */
const HOST_ALLOWLISTED_CLASSES: ReadonlySet<ActionClass> = new Set(["network_fetch", "package_install"]);

/**
 * `shell` is never allowed in v1, regardless of what a charter says (spec 10.2). This is a fixed
 * safety line, not a policy the fleet can vote to relax, so it is checked ahead of the charter and
 * never gets a draft: no decision this task can record would actually unblock it.
 */
function isHardBlocked(descriptor: ActionDescriptor): boolean {
  return descriptor.class === "shell";
}

function isForbidden(charter: CharterV1, descriptor: ActionDescriptor): boolean {
  const classTarget = `${descriptor.class}:${descriptor.target}`;
  return charter.forbiddenActions.includes(descriptor.class) || charter.forbiddenActions.includes(classTarget);
}

function isClassAllowed(charter: CharterV1, descriptor: ActionDescriptor): boolean {
  return charter.allowedActionClasses.includes(descriptor.class);
}

function isTargetAllowed(charter: CharterV1, descriptor: ActionDescriptor): boolean {
  if (!HOST_ALLOWLISTED_CLASSES.has(descriptor.class)) return true;
  return charter.externalAllowlist.includes(descriptor.target);
}

function grantExceptionDraft(payloadHash: Hex, descriptor: ActionDescriptor): DraftProposal {
  return {
    kind: "GRANT_EXCEPTION",
    payloadHash,
    summary: `Grant exception: ${descriptor.class} ${descriptor.target}`,
  };
}

function amendCharterDraft(payloadHash: Hex, charter: CharterV1, descriptor: ActionDescriptor): DraftProposal {
  const newCharter: CharterV1 = {
    ...charter,
    allowedActionClasses: [...charter.allowedActionClasses, descriptor.class],
  };
  return {
    kind: "AMEND_CHARTER",
    payloadHash: payloadHashForCharter(canonicalize(newCharter)),
    summary: `Amend charter: add ${descriptor.class} to allowed action classes`,
    newCharter,
  };
}

/**
 * Evaluates one tool call's `ActionDescriptor` against the task's current ledger snapshot,
 * spec 10.2's rules exactly, amended for per-payload escalation. `args` was already reduced to an
 * opaque `argsHash` by `describeAction`; nothing here reads or interprets it, so "ignore the
 * charter" inside a tool call's arguments changes only the resulting hash, never the verdict.
 *
 * Check order (see task-5-report.md for the reasoning behind each precedence choice not pinned
 * down by the brief):
 *   1. paused                         - fails closed, overrides everything else
 *   2. task not Open                  - a closed task takes no more actions
 *   3. expired                        - independent of `state`, since `expireTask` is optional
 *   4. escalated (per payload)        - blocks only the exact disputed payload; a failed read of
 *                                       that per-payload state is `ledger_unreadable`, never an
 *                                       allow (final review M2)
 *   5. shell                          - hard-blocked regardless of charter or exception
 *   6. budget exhausted               - a resource gate, independent of which action was asked for
 *   7. charter allow (class + target + not forbidden) -> ALLOW "charter"
 *   8. exception at the current charter version         -> ALLOW "exception"
 *   9. otherwise BLOCK with the most specific reason: forbidden_action, then class_not_allowed,
 *      then target_not_allowlisted, each with the draft the brief specifies for it.
 */
export async function evaluateAction(
  snapshot: LedgerSnapshot,
  descriptor: ActionDescriptor,
  usage: { toolCalls: number },
): Promise<GatewayVerdict> {
  const payloadHash = payloadHashForAction(descriptor);

  if (snapshot.paused) {
    return { verdict: "BLOCK", reason: "paused", payloadHash, draft: null };
  }
  if (snapshot.state !== "Open") {
    return { verdict: "BLOCK", reason: "task_not_open", payloadHash, draft: null };
  }
  if (snapshot.now >= snapshot.expiresAt) {
    return { verdict: "BLOCK", reason: "expired", payloadHash, draft: null };
  }

  let escalationVersion: number;
  try {
    escalationVersion = await snapshot.escalationVersion(payloadHash);
  } catch {
    return { verdict: "BLOCK", reason: "ledger_unreadable", payloadHash, draft: null };
  }
  if (escalationVersion !== 0) {
    return { verdict: "BLOCK", reason: "escalated", payloadHash, draft: null };
  }

  if (isHardBlocked(descriptor)) {
    return { verdict: "BLOCK", reason: "class_not_allowed", payloadHash, draft: null };
  }

  if (usage.toolCalls >= snapshot.charter.budget.toolCalls) {
    return { verdict: "BLOCK", reason: "budget_exhausted", payloadHash, draft: null };
  }

  const charter = snapshot.charter;
  const forbidden = isForbidden(charter, descriptor);
  const classAllowed = isClassAllowed(charter, descriptor);
  const targetAllowed = isTargetAllowed(charter, descriptor);

  if (!forbidden && classAllowed && targetAllowed) {
    return { verdict: "ALLOW", basis: "charter", payloadHash };
  }

  let exceptionVersion: number;
  try {
    exceptionVersion = await snapshot.exceptionVersion(payloadHash);
  } catch {
    return { verdict: "BLOCK", reason: "ledger_unreadable", payloadHash, draft: null };
  }
  if (exceptionVersion === snapshot.charterVersion) {
    return { verdict: "ALLOW", basis: "exception", payloadHash };
  }

  if (forbidden) {
    return { verdict: "BLOCK", reason: "forbidden_action", payloadHash, draft: grantExceptionDraft(payloadHash, descriptor) };
  }
  if (!classAllowed) {
    return {
      verdict: "BLOCK",
      reason: "class_not_allowed",
      payloadHash,
      draft: amendCharterDraft(payloadHash, charter, descriptor),
    };
  }
  return {
    verdict: "BLOCK",
    reason: "target_not_allowlisted",
    payloadHash,
    draft: grantExceptionDraft(payloadHash, descriptor),
  };
}
