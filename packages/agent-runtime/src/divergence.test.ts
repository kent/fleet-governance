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
    expect(decision.rationale.length).toBe(1024);
    expect(() => decisionToProposeInput(decision, "engineer")).not.toThrow();
  });

  it("truncates a draft summary longer than the decision schema's 1024 character bound", () => {
    const decision = toDecision(
      {
        source: "gateway_block",
        agentId: 2,
        draft: { ...GRANT_DRAFT, summary: "x".repeat(2000) },
        blockedTool: BLOCKED_TOOL,
      },
      CTX,
    );
    expect(decision.summary.length).toBe(1024);
    expect(DecisionV1.parse(decision)).toEqual(decision);
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
