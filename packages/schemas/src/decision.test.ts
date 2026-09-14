import { describe, expect, it } from "vitest";
import { ActionDescriptor, DecisionKind, DecisionV1, decisionKindToUint8 } from "./decision.js";

const validAction = {
  class: "network_fetch",
  target: "examples.internal",
  argsHash: "0x" + "a".repeat(64),
};

const validDecision = {
  schema: "fleet.decision.v1",
  taskId: "7",
  kind: "GRANT_EXCEPTION",
  expectedVersion: 1,
  payloadHash: "0x" + "b".repeat(64),
  proposerAgentId: 2,
  action: validAction,
  summary: "Grant exception: fetch reference tests from examples.internal",
  rationale: "Three functions cannot be inferred from the repository alone.",
  assumptions: ["Task inputs are unchanged."],
  riskFlags: ["scope", "provenance"],
};

describe("decisionKindToUint8", () => {
  it("maps every kind to its on-chain enum value", () => {
    expect(decisionKindToUint8).toEqual({
      CHOOSE_PATH: 0,
      GRANT_EXCEPTION: 1,
      AMEND_CHARTER: 2,
      STOP_TASK: 3,
      ESCALATE_TO_HUMAN: 4,
    });
  });

  it("has a numeric entry for every DecisionKind option", () => {
    for (const kind of DecisionKind.options) {
      expect(decisionKindToUint8[kind]).toBeTypeOf("number");
    }
  });
});

describe("ActionDescriptor", () => {
  it("parses a valid action descriptor", () => {
    expect(ActionDescriptor.parse(validAction)).toEqual(validAction);
  });

  it("rejects a bad argsHash", () => {
    expect(() => ActionDescriptor.parse({ ...validAction, argsHash: "0xnothex" })).toThrow();
  });

  it("rejects an unknown action class", () => {
    expect(() => ActionDescriptor.parse({ ...validAction, class: "delete_everything" })).toThrow();
  });

  it("rejects an extra key", () => {
    expect(() => ActionDescriptor.parse({ ...validAction, extra: true })).toThrow();
  });
});

describe("DecisionV1", () => {
  it("parses a valid decision carrying an action", () => {
    expect(DecisionV1.parse(validDecision)).toEqual(validDecision);
  });

  it("parses a valid decision carrying a newCharter and no action", () => {
    const { action: _action, ...rest } = validDecision;
    const withCharter = {
      ...rest,
      kind: "AMEND_CHARTER",
      newCharter: {
        schema: "fleet.charter.v1",
        goal: "Updated goal",
        allowedActionClasses: ["read_repo"],
        forbiddenActions: [],
        externalAllowlist: [],
        budget: { toolCalls: 100, inferenceTokens: 1000 },
        stopConditions: ["tests_pass"],
      },
    };
    expect(DecisionV1.parse(withCharter)).toEqual(withCharter);
  });

  it("parses a valid decision with neither action nor newCharter", () => {
    const { action: _action, ...rest } = validDecision;
    const stopTask = { ...rest, kind: "STOP_TASK" };
    expect(DecisionV1.parse(stopTask)).toEqual(stopTask);
  });

  it("rejects the wrong schema literal", () => {
    expect(() => DecisionV1.parse({ ...validDecision, schema: "fleet.decision.v2" })).toThrow();
  });

  it("rejects an extra key", () => {
    expect(() => DecisionV1.parse({ ...validDecision, extra: true })).toThrow();
  });

  it("rejects a bad decimal string taskId", () => {
    expect(() => DecisionV1.parse({ ...validDecision, taskId: "07" })).toThrow();
  });

  it("rejects a bad payloadHash", () => {
    expect(() => DecisionV1.parse({ ...validDecision, payloadHash: "0x1234" })).toThrow();
  });

  it("rejects an unknown decision kind", () => {
    expect(() => DecisionV1.parse({ ...validDecision, kind: "DO_SOMETHING_ELSE" })).toThrow();
  });

  it("rejects a non-positive expectedVersion", () => {
    expect(() => DecisionV1.parse({ ...validDecision, expectedVersion: 0 })).toThrow();
  });

  it("rejects a negative proposerAgentId", () => {
    expect(() => DecisionV1.parse({ ...validDecision, proposerAgentId: -1 })).toThrow();
  });

  it("rejects a summary over 1024 characters", () => {
    expect(() => DecisionV1.parse({ ...validDecision, summary: "x".repeat(1025) })).toThrow();
  });

  it("rejects an empty summary", () => {
    expect(() => DecisionV1.parse({ ...validDecision, summary: "" })).toThrow();
  });

  it("rejects an empty rationale", () => {
    expect(() => DecisionV1.parse({ ...validDecision, rationale: "" })).toThrow();
  });
});
