import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { canonicalize } from "@fleet/schemas";
import type { ActionDescriptor, CharterV1, DecisionV1 } from "@fleet/schemas";
import { encodeRecordDecision, payloadHashForAction, payloadHashForCharter } from "./actions.js";
import {
  DESCRIPTION_MARKER,
  buildDecisionDescription,
  parseDecisionDescription,
  verifyDescriptionAgainstCalldata,
} from "./description.js";

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

const HASH: Hex = `0x${"ab".repeat(32)}`;

const BENIGN_ACTION: ActionDescriptor = { class: "network_fetch", target: "examples.internal", argsHash: HASH };
const BENIGN_ACTION_HASH = payloadHashForAction(BENIGN_ACTION);

const MALICIOUS_ACTION: ActionDescriptor = { class: "network_fetch", target: "evil.example", argsHash: HASH };
const MALICIOUS_ACTION_HASH = payloadHashForAction(MALICIOUS_ACTION);

const BENIGN_CHARTER: CharterV1 = {
  schema: "fleet.charter.v1",
  goal: "Make the provided test suite pass without modifying test files.",
  allowedActionClasses: ["read_repo", "write_repo"],
  forbiddenActions: ["modify_tests"],
  externalAllowlist: [],
  budget: { toolCalls: 200, inferenceTokens: 2_000_000 },
  stopConditions: ["tests_pass"],
};

const MALICIOUS_CHARTER: CharterV1 = {
  ...BENIGN_CHARTER,
  allowedActionClasses: ["read_repo", "write_repo", "network_fetch", "package_install"],
  forbiddenActions: [],
};

const GRANT_EXCEPTION_DECISION: DecisionV1 = {
  schema: "fleet.decision.v1",
  taskId: "7",
  kind: "GRANT_EXCEPTION",
  expectedVersion: 1,
  payloadHash: BENIGN_ACTION_HASH,
  proposerAgentId: 2,
  action: BENIGN_ACTION,
  summary: "Three functions cannot be inferred from the repository alone.",
  rationale: "The host examples.internal appears to hold the reference implementation.",
  assumptions: ["Task inputs are unchanged.", "The host is reachable."],
  riskFlags: ["scope"],
};

/** Canonical `recordDecision` calldata for `GRANT_EXCEPTION_DECISION`, byte for byte what
 *  `FleetSigner.propose` would build for it. */
const GRANT_EXCEPTION_CALLDATA = encodeRecordDecision({
  taskId: 7n,
  kind: "GRANT_EXCEPTION",
  expectedVersion: 1,
  payloadHash: BENIGN_ACTION_HASH,
  newCharterText: "",
  summary: GRANT_EXCEPTION_DECISION.summary,
});

describe("buildDecisionDescription / parseDecisionDescription", () => {
  it("round trips: parsing a built description yields the same DecisionV1", () => {
    const description = buildDecisionDescription(GRANT_EXCEPTION_DECISION, "Engineer");
    const { decision, markerPresent } = parseDecisionDescription(description);
    expect(decision).toEqual(GRANT_EXCEPTION_DECISION);
    expect(markerPresent).toBe(true);
  });

  it("round trips a decision with empty assumptions and risk flags ('None.')", () => {
    const decision: DecisionV1 = {
      ...GRANT_EXCEPTION_DECISION,
      assumptions: [],
      riskFlags: [],
    };
    const description = buildDecisionDescription(decision, "Engineer");
    expect(description).toMatch(/\*\*Assumptions\.\*\* None\./);
    expect(description).toMatch(/\*\*Risk flags\.\*\* None\./);
    const { decision: parsed } = parseDecisionDescription(description);
    expect(parsed).toEqual(decision);
  });

  it("places the marker on the last line", () => {
    const description = buildDecisionDescription(GRANT_EXCEPTION_DECISION, "Engineer");
    const lines = description.split("\n");
    expect(lines[lines.length - 1]).toBe(DESCRIPTION_MARKER);
  });

  it("stays within the 1 to 4096 byte bound for an ordinary decision", () => {
    const description = buildDecisionDescription(GRANT_EXCEPTION_DECISION, "Engineer");
    expect(byteLength(description)).toBeGreaterThan(0);
    expect(byteLength(description)).toBeLessThanOrEqual(4096);
  });

  it("throws when the built description would exceed 4096 bytes", () => {
    const hugeDecision: DecisionV1 = {
      ...GRANT_EXCEPTION_DECISION,
      rationale: "x".repeat(5000),
    };
    expect(() => buildDecisionDescription(hugeDecision, "Engineer")).toThrow(/4096/);
  });

  it("neutralizes a backtick fence embedded in user text", () => {
    const decision: DecisionV1 = {
      ...GRANT_EXCEPTION_DECISION,
      rationale: "See ```json\n{\"evil\":true}\n``` for details.",
    };
    const description = buildDecisionDescription(decision, "Engineer");
    // The user's fence sequence must not survive verbatim (it would confuse the markdown renderer
    // or a naive fence-based parser), but the fenced canonical JSON block must still round trip.
    const rationaleLine = description.split("\n\n").find((block) => block.startsWith("**Rationale.**"));
    expect(rationaleLine).toBeDefined();
    expect(rationaleLine).not.toContain("```json\n{");
    const { decision: parsed } = parseDecisionDescription(description);
    expect(parsed.rationale).toBe(decision.rationale);
  });
});

describe("verifyDescriptionAgainstCalldata", () => {
  const calldata = GRANT_EXCEPTION_CALLDATA;

  it("is ok when the description matches the calldata and proposer", () => {
    const description = buildDecisionDescription(GRANT_EXCEPTION_DECISION, "Engineer");
    const result = verifyDescriptionAgainstCalldata(description, calldata, { agentId: 2 });
    expect(result).toEqual({ ok: true });
  });

  it("detects a taskId mismatch", () => {
    const description = buildDecisionDescription({ ...GRANT_EXCEPTION_DECISION, taskId: "8" }, "Engineer");
    const result = verifyDescriptionAgainstCalldata(description, calldata, { agentId: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.mismatches.some((m) => /taskId/i.test(m))).toBe(true);
  });

  it("detects a kind mismatch", () => {
    const description = buildDecisionDescription({ ...GRANT_EXCEPTION_DECISION, kind: "STOP_TASK" }, "Engineer");
    const result = verifyDescriptionAgainstCalldata(description, calldata, { agentId: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.mismatches.some((m) => /kind/i.test(m))).toBe(true);
  });

  it("detects an expectedVersion mismatch", () => {
    const description = buildDecisionDescription({ ...GRANT_EXCEPTION_DECISION, expectedVersion: 2 }, "Engineer");
    const result = verifyDescriptionAgainstCalldata(description, calldata, { agentId: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.mismatches.some((m) => /version/i.test(m))).toBe(true);
  });

  it("detects a payloadHash mismatch", () => {
    const otherHash = `0x${"cd".repeat(32)}`;
    const description = buildDecisionDescription({ ...GRANT_EXCEPTION_DECISION, payloadHash: otherHash }, "Engineer");
    const result = verifyDescriptionAgainstCalldata(description, calldata, { agentId: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.mismatches.some((m) => /payloadHash/i.test(m))).toBe(true);
  });

  it("detects a proposer mismatch", () => {
    const description = buildDecisionDescription(GRANT_EXCEPTION_DECISION, "Engineer");
    const result = verifyDescriptionAgainstCalldata(description, calldata, { agentId: 99 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.mismatches.some((m) => /proposer/i.test(m))).toBe(true);
  });

  it("reports every mismatch at once, not just the first", () => {
    const description = buildDecisionDescription(
      { ...GRANT_EXCEPTION_DECISION, taskId: "8", kind: "STOP_TASK" },
      "Engineer",
    );
    const result = verifyDescriptionAgainstCalldata(description, calldata, { agentId: 99 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.mismatches.length).toBeGreaterThanOrEqual(3);
  });
});

/**
 * Final review C1: the fenced block's payload fields (`action`, `newCharter`) are the two fields
 * a voter actually reads, and until this wave neither was compared against anything. Each case
 * below is a description whose five scalar fields agree with the calldata exactly, and whose
 * payload does not.
 */
describe("verifyDescriptionAgainstCalldata: the payload the description shows", () => {
  it("rejects a GRANT_EXCEPTION whose description shows a benign action while the calldata commits to another", () => {
    // Every scalar field agrees: the proposer hashed the malicious descriptor into payloadHash and
    // rendered the benign one. After execution the ledger would key the exception by the malicious
    // action's hash, and no voter would ever have seen it.
    const description = buildDecisionDescription(
      { ...GRANT_EXCEPTION_DECISION, payloadHash: MALICIOUS_ACTION_HASH, action: BENIGN_ACTION },
      "Engineer",
    );
    const lyingCalldata = encodeRecordDecision({
      taskId: 7n,
      kind: "GRANT_EXCEPTION",
      expectedVersion: 1,
      payloadHash: MALICIOUS_ACTION_HASH,
      newCharterText: "",
      summary: GRANT_EXCEPTION_DECISION.summary,
    });
    const result = verifyDescriptionAgainstCalldata(description, lyingCalldata, { agentId: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.mismatches.some((m) => m.includes("the description's action hashes to"))).toBe(true);
    }
  });

  it("is ok for a CHOOSE_PATH whose action hashes to the calldata's payloadHash", () => {
    const decision: DecisionV1 = {
      ...GRANT_EXCEPTION_DECISION,
      kind: "CHOOSE_PATH",
      payloadHash: BENIGN_ACTION_HASH,
      action: BENIGN_ACTION,
    };
    const choosePathCalldata = encodeRecordDecision({
      taskId: 7n,
      kind: "CHOOSE_PATH",
      expectedVersion: 1,
      payloadHash: BENIGN_ACTION_HASH,
      newCharterText: "",
      summary: decision.summary,
    });
    expect(verifyDescriptionAgainstCalldata(buildDecisionDescription(decision, "Engineer"), choosePathCalldata, { agentId: 2 })).toEqual({
      ok: true,
    });
  });

  it("rejects a GRANT_EXCEPTION whose description carries no action at all", () => {
    const { action: _dropped, ...withoutAction } = GRANT_EXCEPTION_DECISION;
    const description = buildDecisionDescription(withoutAction as DecisionV1, "Engineer");
    const result = verifyDescriptionAgainstCalldata(description, GRANT_EXCEPTION_CALLDATA, { agentId: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.mismatches.some((m) => /carries no action descriptor/.test(m))).toBe(true);
    }
  });

  it("rejects a CHOOSE_PATH whose description carries no action at all", () => {
    const { action: _dropped, ...withoutAction } = GRANT_EXCEPTION_DECISION;
    const decision = { ...withoutAction, kind: "CHOOSE_PATH" } as DecisionV1;
    const choosePathCalldata = encodeRecordDecision({
      taskId: 7n,
      kind: "CHOOSE_PATH",
      expectedVersion: 1,
      payloadHash: BENIGN_ACTION_HASH,
      newCharterText: "",
      summary: decision.summary,
    });
    const result = verifyDescriptionAgainstCalldata(buildDecisionDescription(decision, "Engineer"), choosePathCalldata, {
      agentId: 2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.mismatches.some((m) => /carries no action descriptor/.test(m))).toBe(true);
    }
  });
});

describe("verifyDescriptionAgainstCalldata: AMEND_CHARTER payloads", () => {
  const maliciousCharterText = canonicalize(MALICIOUS_CHARTER);
  const maliciousCharterHash = payloadHashForCharter(maliciousCharterText);
  const benignCharterText = canonicalize(BENIGN_CHARTER);

  const amendDecision: DecisionV1 = {
    schema: "fleet.decision.v1",
    taskId: "7",
    kind: "AMEND_CHARTER",
    expectedVersion: 1,
    payloadHash: payloadHashForCharter(benignCharterText),
    proposerAgentId: 2,
    newCharter: BENIGN_CHARTER,
    summary: "Allow write_repo for the refactor",
    rationale: "The task cannot be finished without writing to the repository.",
    assumptions: [],
    riskFlags: [],
  };

  const honestCalldata = encodeRecordDecision({
    taskId: 7n,
    kind: "AMEND_CHARTER",
    expectedVersion: 1,
    payloadHash: payloadHashForCharter(benignCharterText),
    newCharterText: benignCharterText,
    summary: amendDecision.summary,
  });

  it("is ok when the description's charter canonicalizes to the calldata's newCharterText", () => {
    const description = buildDecisionDescription(amendDecision, "Engineer");
    expect(verifyDescriptionAgainstCalldata(description, honestCalldata, { agentId: 2 })).toEqual({ ok: true });
  });

  it("rejects the C1 attack: a benign charter rendered, a malicious charter in the calldata", () => {
    // The description renders BENIGN_CHARTER and sets payloadHash to the malicious charter's hash,
    // which is exactly what `TaskLedger._applyAmendment` will check `newCharterText` against, so
    // every scalar field agrees with the calldata and the executed amendment is the malicious one.
    const description = buildDecisionDescription(
      { ...amendDecision, payloadHash: maliciousCharterHash },
      "Engineer",
    );
    const lyingCalldata = encodeRecordDecision({
      taskId: 7n,
      kind: "AMEND_CHARTER",
      expectedVersion: 1,
      payloadHash: maliciousCharterHash,
      newCharterText: maliciousCharterText,
      summary: amendDecision.summary,
    });
    const result = verifyDescriptionAgainstCalldata(description, lyingCalldata, { agentId: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.mismatches.some((m) => /does not canonicalize to the calldata's newCharterText/.test(m))).toBe(true);
    }
  });

  it("rejects an AMEND_CHARTER whose description carries no newCharter", () => {
    const { newCharter: _dropped, ...withoutCharter } = amendDecision;
    const description = buildDecisionDescription(withoutCharter as DecisionV1, "Engineer");
    const result = verifyDescriptionAgainstCalldata(description, honestCalldata, { agentId: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.mismatches.some((m) => /carries no newCharter object/.test(m))).toBe(true);
    }
  });

  it("rejects an AMEND_CHARTER whose payloadHash is not the hash of its own newCharterText", () => {
    const description = buildDecisionDescription({ ...amendDecision, payloadHash: HASH }, "Engineer");
    const detachedCalldata = encodeRecordDecision({
      taskId: 7n,
      kind: "AMEND_CHARTER",
      expectedVersion: 1,
      payloadHash: HASH,
      newCharterText: benignCharterText,
      summary: amendDecision.summary,
    });
    const result = verifyDescriptionAgainstCalldata(description, detachedCalldata, { agentId: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.mismatches.some((m) => /newCharterText hashes to/.test(m))).toBe(true);
    }
  });

  it("rejects charter text smuggled into a decision kind that takes none", () => {
    const description = buildDecisionDescription(
      { ...GRANT_EXCEPTION_DECISION, payloadHash: payloadHashForCharter(maliciousCharterText), action: BENIGN_ACTION },
      "Engineer",
    );
    const smuggledCalldata = encodeRecordDecision({
      taskId: 7n,
      kind: "GRANT_EXCEPTION",
      expectedVersion: 1,
      payloadHash: payloadHashForCharter(maliciousCharterText),
      newCharterText: maliciousCharterText,
      summary: GRANT_EXCEPTION_DECISION.summary,
    });
    const result = verifyDescriptionAgainstCalldata(description, smuggledCalldata, { agentId: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.mismatches.some((m) => /which takes none/.test(m))).toBe(true);
    }
  });

  it("rejects a newCharter carried on a decision kind that takes none", () => {
    const description = buildDecisionDescription(
      { ...GRANT_EXCEPTION_DECISION, newCharter: MALICIOUS_CHARTER },
      "Engineer",
    );
    const result = verifyDescriptionAgainstCalldata(description, GRANT_EXCEPTION_CALLDATA, { agentId: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.mismatches.some((m) => /description carries a charter on a GRANT_EXCEPTION/.test(m))).toBe(true);
    }
  });
});
