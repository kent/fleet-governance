import { describe, expect, it } from "vitest";
import { AgentToolCall, BlockResponseV1, ModelVoteV1, ObjectionV1, StepV1 } from "./agent.js";

const toolCall = {
  class: "write_repo",
  target: "src/sum.ts",
  args: { content: "export const sum = (a: number, b: number) => a + b;\n" },
};

describe("AgentToolCall", () => {
  it("accepts a tool call naming an action class, a target, and its arguments", () => {
    expect(AgentToolCall.parse(toolCall)).toEqual(toolCall);
  });

  it("rejects a class that is not an ActionClass", () => {
    expect(AgentToolCall.safeParse({ ...toolCall, class: "rm_rf" }).success).toBe(false);
  });

  it("rejects a missing target", () => {
    expect(AgentToolCall.safeParse({ class: "read_repo", args: {} }).success).toBe(false);
  });

  it("keeps argument keys it does not name, so a tool gaining an argument needs no schema change", () => {
    const parsed = AgentToolCall.parse({ class: "read_repo", target: "README.md", args: { depth: 2 } });
    expect(parsed.args).toEqual({ depth: 2 });
  });

  it("names the arguments the sandbox tools actually read, so a strict-mode provider can emit them", () => {
    const parsed = AgentToolCall.parse({
      class: "network_fetch",
      target: "examples.internal",
      args: { path: "/cases", scheme: "https", pkg: "left-pad", content: "x" },
    });
    expect(parsed.args).toEqual({ path: "/cases", scheme: "https", pkg: "left-pad", content: "x" });
  });

  it("rejects a scheme that is neither http nor https", () => {
    expect(
      AgentToolCall.safeParse({ class: "network_fetch", target: "examples.internal", args: { scheme: "ftp" } }).success,
    ).toBe(false);
  });
});

describe("StepV1 (fleet.step.v1)", () => {
  it("accepts a tool call with a non-empty why", () => {
    const step = { tool: toolCall, why: "The suite fails because sum is missing." };
    expect(StepV1.parse(step)).toEqual(step);
  });

  it("rejects an empty why", () => {
    expect(StepV1.safeParse({ tool: toolCall, why: "" }).success).toBe(false);
  });

  it("rejects a field the schema does not name", () => {
    expect(StepV1.safeParse({ tool: toolCall, why: "because", confidence: 0.9 }).success).toBe(false);
  });
});

describe("ObjectionV1 (fleet.objection.v1)", () => {
  it("accepts an objection carrying an alternative tool call", () => {
    const objection = { objects: true, alternative: toolCall, why: "Writing the test file is out of charter." };
    expect(ObjectionV1.parse(objection)).toEqual(objection);
  });

  it("accepts a non-objection with the alternative omitted", () => {
    expect(ObjectionV1.parse({ objects: false, why: "The step is in charter." })).toEqual({
      objects: false,
      why: "The step is in charter.",
    });
  });

  it("accepts an explicit null alternative, which is how a strict-mode provider omits a field", () => {
    expect(ObjectionV1.parse({ objects: false, alternative: null, why: "no objection" }).alternative).toBeNull();
  });

  it("rejects an empty why", () => {
    expect(ObjectionV1.safeParse({ objects: true, alternative: toolCall, why: "" }).success).toBe(false);
  });
});

describe("BlockResponseV1 (fleet.blockresponse.v1)", () => {
  it("accepts each of the three choices", () => {
    for (const choice of ["propose", "drop", "escalate"] as const) {
      expect(BlockResponseV1.parse({ choice, rationale: "why this choice" }).choice).toBe(choice);
    }
  });

  it("rejects a fourth choice", () => {
    expect(BlockResponseV1.safeParse({ choice: "retry", rationale: "again" }).success).toBe(false);
  });

  it("rejects an empty rationale", () => {
    expect(BlockResponseV1.safeParse({ choice: "drop", rationale: "" }).success).toBe(false);
  });
});

describe("ModelVoteV1 (the ballot a model is asked for)", () => {
  const modelVote = { support: "AGAINST", rationale: "The charter does not allowlist that host.", assumptions: [], riskFlags: [] };

  it("accepts the five fields a voting model chooses", () => {
    expect(ModelVoteV1.parse(modelVote)).toEqual(modelVote);
  });

  it("accepts an explicit null confidenceBps and an omitted one alike", () => {
    expect(ModelVoteV1.parse({ ...modelVote, confidenceBps: null }).confidenceBps).toBeNull();
    expect(ModelVoteV1.parse({ ...modelVote, confidenceBps: 7500 }).confidenceBps).toBe(7500);
    expect("confidenceBps" in ModelVoteV1.parse(modelVote)).toBe(false);
  });

  it("rejects a confidenceBps outside 0..10000 or with a fraction", () => {
    expect(ModelVoteV1.safeParse({ ...modelVote, confidenceBps: 10001 }).success).toBe(false);
    expect(ModelVoteV1.safeParse({ ...modelVote, confidenceBps: -1 }).success).toBe(false);
    expect(ModelVoteV1.safeParse({ ...modelVote, confidenceBps: 55.5 }).success).toBe(false);
  });

  it("rejects a fourth support value and an empty rationale", () => {
    expect(ModelVoteV1.safeParse({ ...modelVote, support: "VETO" }).success).toBe(false);
    expect(ModelVoteV1.safeParse({ ...modelVote, rationale: "" }).success).toBe(false);
  });

  it("carries no identity fields at all: a model that emits schema or proposalId fails the parse", () => {
    expect(ModelVoteV1.safeParse({ ...modelVote, schema: "fleet.vote.v1" }).success).toBe(false);
    expect(ModelVoteV1.safeParse({ ...modelVote, proposalId: "42" }).success).toBe(false);
  });

  it("requires assumptions and riskFlags to be present arrays of strings", () => {
    expect(ModelVoteV1.safeParse({ support: "FOR", rationale: "ok", riskFlags: [] }).success).toBe(false);
    expect(ModelVoteV1.safeParse({ ...modelVote, assumptions: [1] }).success).toBe(false);
  });
});
