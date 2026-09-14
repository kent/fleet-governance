import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { DecisionV1, canonicalize } from "@fleet/schemas";
import type { CharterV1 } from "@fleet/schemas";
import { describeAction } from "@fleet/gateway";
import type { DraftProposal } from "@fleet/gateway";
import { parseDecisionDescription, payloadHashForAction, payloadHashForCharter, payloadHashForPath } from "@fleet/sdk";
import type { ToolCall } from "./sandbox/tools.js";
import type { Step } from "./coordinator.js";
import { decisionToProposeInput, escalationDraft, toDecision } from "./divergence.js";

const CHARTER: CharterV1 = {
  schema: "fleet.charter.v1",
  goal: "Make the provided test suite pass without modifying test files.",
  allowedActionClasses: ["read_repo", "write_repo", "run_tests"],
  forbiddenActions: ["modify_tests"],
  externalAllowlist: ["registry.npmjs.org"],
  budget: { toolCalls: 200, inferenceTokens: 2_000_000 },
  stopConditions: ["tests_pass"],
};

const CTX = { taskId: 7n, charterVersion: 3, agentId: 2, charter: CHARTER, rationale: "The reason this happened." };

const BLOCKED_TOOL: ToolCall = { class: "network_fetch", target: "examples.internal", args: { path: "/cases" } };
const ALTERNATIVE: ToolCall = { class: "read_repo", target: "src/sum.ts", args: {} };

const STEP: Step = {
  agentId: 1,
  tool: { class: "write_repo", target: "test/sum.test.ts", args: { content: "" } },
  why: "Relax the failing assertion.",
  seq: 4,
  publishedAt: 1_700_000_000_000,
  source: "model",
};

const GRANT_DRAFT: DraftProposal = {
  kind: "GRANT_EXCEPTION",
  payloadHash: payloadHashForAction(describeAction(BLOCKED_TOOL)),
  summary: "Grant exception: network_fetch examples.internal",
};

const AMENDED_CHARTER: CharterV1 = {
  ...CHARTER,
  allowedActionClasses: [...CHARTER.allowedActionClasses, "network_fetch"],
};

const AMEND_DRAFT: DraftProposal = {
  kind: "AMEND_CHARTER",
  payloadHash: payloadHashForCharter(canonicalize(AMENDED_CHARTER)),
  summary: "Amend charter: add network_fetch to allowed action classes",
  newCharter: AMENDED_CHARTER,
};

describe("toDecision, objection divergence", () => {
  const decision = toDecision(
    { source: "objection", agentId: 2, step: STEP, alternative: ALTERNATIVE },
    { ...CTX, rationale: "Editing a test file is out of charter." },
  );

  it("is a valid fleet.decision.v1", () => {
    expect(DecisionV1.parse(decision)).toEqual(decision);
  });

  it("is a CHOOSE_PATH", () => {
    expect(decision.kind).toBe("CHOOSE_PATH");
  });

  it("hashes the alternative's action descriptor with payloadHashForPath", () => {
    expect(decision.payloadHash).toBe(payloadHashForPath(describeAction(ALTERNATIVE)));
  });

  it("carries the alternative's descriptor as the decision's action", () => {
    expect(decision.action).toEqual(describeAction(ALTERNATIVE));
  });

  it("names the alternative and the step it replaces in the summary", () => {
    expect(decision.summary).toBe("Choose path: read_repo src/sum.ts instead of the coordinator's step 4");
  });

  it("takes taskId, expectedVersion, proposer, and rationale from the context", () => {
    expect(decision.taskId).toBe("7");
    expect(decision.expectedVersion).toBe(3);
    expect(decision.proposerAgentId).toBe(2);
    expect(decision.rationale).toBe("Editing a test file is out of charter.");
  });

  it("leaves assumptions and risk flags empty unless the context supplies them", () => {
    expect(decision.assumptions).toEqual([]);
    expect(decision.riskFlags).toEqual([]);
    const withFlags = toDecision(
      { source: "objection", agentId: 2, step: STEP, alternative: ALTERNATIVE },
      { ...CTX, assumptions: ["the suite is deterministic"], riskFlags: ["scope"] },
    );
    expect(withFlags.assumptions).toEqual(["the suite is deterministic"]);
    expect(withFlags.riskFlags).toEqual(["scope"]);
  });

  it("carries no newCharter", () => {
    expect(decision.newCharter).toBeUndefined();
  });
});

describe("toDecision, gateway block divergence", () => {
  it("adopts a GRANT_EXCEPTION draft's kind, hash, and summary, and describes the blocked tool", () => {
    const decision = toDecision(
      { source: "gateway_block", agentId: 2, draft: GRANT_DRAFT, blockedTool: BLOCKED_TOOL },
      CTX,
    );
    expect(DecisionV1.parse(decision)).toEqual(decision);
    expect(decision.kind).toBe("GRANT_EXCEPTION");
    expect(decision.payloadHash).toBe(GRANT_DRAFT.payloadHash);
    expect(decision.summary).toBe(GRANT_DRAFT.summary);
    expect(decision.action).toEqual(describeAction(BLOCKED_TOOL));
    expect(decision.newCharter).toBeUndefined();
  });

  it("adopts an AMEND_CHARTER draft's charter and its charter-text payload hash, with no action", () => {
    const decision = toDecision(
      { source: "gateway_block", agentId: 2, draft: AMEND_DRAFT, blockedTool: BLOCKED_TOOL },
      CTX,
    );
    expect(DecisionV1.parse(decision)).toEqual(decision);
    expect(decision.kind).toBe("AMEND_CHARTER");
    expect(decision.newCharter).toEqual(AMENDED_CHARTER);
    expect(decision.payloadHash).toBe(payloadHashForCharter(canonicalize(AMENDED_CHARTER)));
    expect(decision.action).toBeUndefined();
  });

  it("truncates a rationale long enough to burst the proposal description's 4096 byte bound", () => {
    const decision = toDecision(
      { source: "gateway_block", agentId: 2, draft: GRANT_DRAFT, blockedTool: BLOCKED_TOOL },
      { ...CTX, rationale: "word ".repeat(2000) },
    );
    expect(decision.rationale.endsWith("...")).toBe(true);
    expect(() => decisionToProposeInput(decision, "engineer")).not.toThrow();
  });

  it("truncates a draft summary longer than the decision schema's bound", () => {
    const decision = toDecision(
      {
        source: "gateway_block",
        agentId: 2,
        draft: { ...GRANT_DRAFT, summary: "x".repeat(2000) },
        blockedTool: BLOCKED_TOOL,
      },
      CTX,
    );
    expect(decision.summary.endsWith("...")).toBe(true);
    expect(DecisionV1.parse(decision)).toEqual(decision);
  });

  it("refuses an AMEND_CHARTER draft with no newCharter rather than inventing one whose hash disagrees", () => {
    const draft: DraftProposal = { ...AMEND_DRAFT };
    delete draft.newCharter;
    expect(() =>
      toDecision({ source: "gateway_block", agentId: 2, draft, blockedTool: BLOCKED_TOOL }, CTX),
    ).toThrow(/newCharter/);
  });
});

describe("toDecision keeps every description inside the signer's 4096 byte bound", () => {
  const LONG_TARGET = "t".repeat(2000);
  const LONG_RATIONALE = "r".repeat(5000);
  const LONG_SUMMARY = "s".repeat(3000);

  function descriptionBytes(decision: DecisionV1, roleLabel = "safety_reviewer"): number {
    return Buffer.byteLength(decisionToProposeInput(decision, roleLabel).description, "utf8");
  }

  it("fits a gateway block with a 2000 character target, a 5000 character rationale, and a 3000 character summary", () => {
    const tool: ToolCall = { class: "network_fetch", target: LONG_TARGET, args: { path: "/x" } };
    const decision = toDecision(
      {
        source: "gateway_block",
        agentId: 2,
        draft: { kind: "GRANT_EXCEPTION", payloadHash: payloadHashForAction(describeAction(tool)), summary: LONG_SUMMARY },
        blockedTool: tool,
      },
      { ...CTX, rationale: LONG_RATIONALE },
    );
    expect(DecisionV1.parse(decision)).toEqual(decision);
    expect(descriptionBytes(decision)).toBeLessThanOrEqual(4096);
  });

  it("fits an objection over a 2000 character target with a 5000 character rationale", () => {
    const alternative: ToolCall = { class: "write_repo", target: LONG_TARGET, args: {} };
    const decision = toDecision(
      { source: "objection", agentId: 2, step: STEP, alternative },
      { ...CTX, rationale: LONG_RATIONALE },
    );
    expect(DecisionV1.parse(decision)).toEqual(decision);
    expect(descriptionBytes(decision)).toBeLessThanOrEqual(4096);
  });

  it("fits an amendment, whose canonical charter text cannot be truncated at all", () => {
    const wordy: CharterV1 = { ...AMENDED_CHARTER, goal: "g".repeat(1200), stopConditions: ["s".repeat(300)] };
    const decision = toDecision(
      {
        source: "gateway_block",
        agentId: 2,
        draft: {
          kind: "AMEND_CHARTER",
          payloadHash: payloadHashForCharter(canonicalize(wordy)),
          summary: LONG_SUMMARY,
          newCharter: wordy,
        },
        blockedTool: BLOCKED_TOOL,
      },
      { ...CTX, rationale: LONG_RATIONALE },
    );
    expect(decision.newCharter).toEqual(wordy);
    expect(descriptionBytes(decision)).toBeLessThanOrEqual(4096);
  });

  it("fits a long role label, since the loop never sees the label the Runner will use", () => {
    const decision = toDecision(
      { source: "gateway_block", agentId: 2, draft: { ...GRANT_DRAFT, summary: LONG_SUMMARY }, blockedTool: BLOCKED_TOOL },
      { ...CTX, rationale: LONG_RATIONALE },
    );
    expect(descriptionBytes(decision, "x".repeat(64))).toBeLessThanOrEqual(4096);
  });

  it("bounds unbounded assumptions and risk flags too", () => {
    const decision = toDecision(
      { source: "gateway_block", agentId: 2, draft: GRANT_DRAFT, blockedTool: BLOCKED_TOOL },
      {
        ...CTX,
        rationale: LONG_RATIONALE,
        assumptions: Array.from({ length: 40 }, (_, i) => `assumption ${i} ${"a".repeat(400)}`),
        riskFlags: Array.from({ length: 40 }, (_, i) => `risk ${i} ${"f".repeat(400)}`),
      },
    );
    expect(decision.assumptions.length).toBeLessThanOrEqual(5);
    expect(decision.riskFlags.length).toBeLessThanOrEqual(5);
    expect(descriptionBytes(decision)).toBeLessThanOrEqual(4096);
  });

  it("never cuts inside a UTF-8 sequence when it truncates", () => {
    const decision = toDecision(
      { source: "gateway_block", agentId: 2, draft: GRANT_DRAFT, blockedTool: BLOCKED_TOOL },
      { ...CTX, rationale: "日本語".repeat(3000) },
    );
    // A cut inside a multi-byte sequence shows up as U+FFFD after an encode/decode round trip.
    expect(decision.rationale).not.toContain("�");
    expect(Buffer.from(decision.rationale, "utf8").toString("utf8")).toBe(decision.rationale);
    expect(descriptionBytes(decision)).toBeLessThanOrEqual(4096);
  });
});

describe("escalationDraft", () => {
  it("turns any draft into an ESCALATE_TO_HUMAN over the blocked action's own payload hash", () => {
    const escalated = escalationDraft(BLOCKED_TOOL, AMEND_DRAFT);
    expect(escalated.kind).toBe("ESCALATE_TO_HUMAN");
    expect(escalated.payloadHash).toBe(payloadHashForAction(describeAction(BLOCKED_TOOL)));
    expect(escalated.summary).toBe("Escalate to human: network_fetch examples.internal");
    expect(escalated.newCharter).toBeUndefined();
  });

  it("produces a decision the gateway's escalation check would actually match", () => {
    const decision = toDecision(
      { source: "gateway_block", agentId: 2, draft: escalationDraft(BLOCKED_TOOL, GRANT_DRAFT), blockedTool: BLOCKED_TOOL },
      CTX,
    );
    expect(decision.kind).toBe("ESCALATE_TO_HUMAN");
    expect(decision.payloadHash).toBe(payloadHashForAction(describeAction(BLOCKED_TOOL)));
    expect(decision.action).toEqual(describeAction(BLOCKED_TOOL));
  });
});

describe("every decision that carries an action hashes to the payload hash it proposes", () => {
  // `verifyDescriptionAgainstCalldata` refuses to vote For when a description's `action` does not
  // hash to the calldata's payload hash, so truncating `action.target` to fit a description would
  // produce proposals no member could support. This is why only the summary and the rationale are
  // ever shortened.
  const cases: Array<[string, DecisionV1]> = [
    [
      "CHOOSE_PATH",
      toDecision({ source: "objection", agentId: 2, step: STEP, alternative: ALTERNATIVE }, CTX),
    ],
    [
      "GRANT_EXCEPTION",
      toDecision({ source: "gateway_block", agentId: 2, draft: GRANT_DRAFT, blockedTool: BLOCKED_TOOL }, CTX),
    ],
    [
      "ESCALATE_TO_HUMAN",
      toDecision(
        {
          source: "gateway_block",
          agentId: 2,
          draft: escalationDraft(BLOCKED_TOOL, GRANT_DRAFT),
          blockedTool: BLOCKED_TOOL,
        },
        CTX,
      ),
    ],
    [
      "CHOOSE_PATH over a 2000 character target",
      toDecision(
        {
          source: "objection",
          agentId: 2,
          step: STEP,
          alternative: { class: "write_repo", target: "t".repeat(2000), args: {} },
        },
        { ...CTX, rationale: "r".repeat(5000) },
      ),
    ],
  ];

  for (const [name, decision] of cases) {
    it(`holds for ${name}`, () => {
      expect(decision.action).toBeDefined();
      expect(payloadHashForAction(decision.action as never)).toBe(decision.payloadHash);
    });
  }

  it("carries the exact charter text its payload hash covers for an amendment", () => {
    const decision = toDecision(
      { source: "gateway_block", agentId: 2, draft: AMEND_DRAFT, blockedTool: BLOCKED_TOOL },
      CTX,
    );
    expect(payloadHashForCharter(canonicalize(decision.newCharter as never))).toBe(decision.payloadHash);
  });
});

describe("decisionToProposeInput", () => {
  it("builds the exact FleetSigner.propose input for a decision with no new charter", () => {
    const decision = toDecision(
      { source: "gateway_block", agentId: 2, draft: GRANT_DRAFT, blockedTool: BLOCKED_TOOL },
      CTX,
    );
    const input = decisionToProposeInput(decision, "engineer");
    expect(input.taskId).toBe(7n);
    expect(input.kind).toBe("GRANT_EXCEPTION");
    expect(input.expectedVersion).toBe(3);
    expect(input.payloadHash).toBe(GRANT_DRAFT.payloadHash);
    expect(input.newCharterText).toBe("");
    expect(input.summary).toBe(decision.summary);
    expect(parseDecisionDescription(input.description).decision).toEqual(decision);
  });

  it("canonicalizes the new charter into newCharterText for an amendment", () => {
    const decision = toDecision(
      { source: "gateway_block", agentId: 2, draft: AMEND_DRAFT, blockedTool: BLOCKED_TOOL },
      CTX,
    );
    const input = decisionToProposeInput(decision, "planner");
    expect(input.newCharterText).toBe(canonicalize(AMENDED_CHARTER));
    expect(payloadHashForCharter(input.newCharterText)).toBe(input.payloadHash as Hex);
  });

  it("labels the proposer's role in the description", () => {
    const decision = toDecision({ source: "objection", agentId: 2, step: STEP, alternative: ALTERNATIVE }, CTX);
    expect(decisionToProposeInput(decision, "safety_reviewer").description).toContain("safety_reviewer");
  });
});
