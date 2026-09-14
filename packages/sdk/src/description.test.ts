import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import type { DecisionV1 } from "@fleet/schemas";
import { encodeRecordDecision } from "./actions.js";
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

const GRANT_EXCEPTION_DECISION: DecisionV1 = {
  schema: "fleet.decision.v1",
  taskId: "7",
  kind: "GRANT_EXCEPTION",
  expectedVersion: 1,
  payloadHash: HASH,
  proposerAgentId: 2,
  action: { class: "network_fetch", target: "examples.internal", argsHash: HASH },
  summary: "Three functions cannot be inferred from the repository alone.",
  rationale: "The host examples.internal appears to hold the reference implementation.",
  assumptions: ["Task inputs are unchanged.", "The host is reachable."],
  riskFlags: ["scope"],
};

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
  const calldata = encodeRecordDecision({
    taskId: 7n,
    kind: "GRANT_EXCEPTION",
    expectedVersion: 1,
    payloadHash: HASH,
    newCharterText: "",
    summary: GRANT_EXCEPTION_DECISION.summary,
  });

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
