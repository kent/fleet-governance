import { describe, expect, it } from "vitest";
import { VoteV1 } from "./vote.js";

const validVote = {
  schema: "fleet.vote.v1",
  proposalId: "123456789",
  support: "AGAINST",
  rationale:
    "The charter forbids fetching from non-allowlisted hosts and the proposal offers no evidence the host is trustworthy.",
  assumptions: ["Task inputs are unchanged."],
  riskFlags: ["scope", "provenance"],
  confidenceBps: 8200,
};

describe("VoteV1", () => {
  it("parses a valid vote", () => {
    expect(VoteV1.parse(validVote)).toEqual(validVote);
  });

  it("parses without the optional confidenceBps field", () => {
    const { confidenceBps: _confidenceBps, ...rest } = validVote;
    expect(VoteV1.parse(rest)).toEqual(rest);
  });

  it("accepts each support value", () => {
    for (const support of ["FOR", "AGAINST", "ABSTAIN"]) {
      expect(VoteV1.parse({ ...validVote, support })).toMatchObject({ support });
    }
  });

  it("rejects the wrong schema literal", () => {
    expect(() => VoteV1.parse({ ...validVote, schema: "fleet.vote.v2" })).toThrow();
  });

  it("rejects an extra key", () => {
    expect(() => VoteV1.parse({ ...validVote, extra: true })).toThrow();
  });

  it("rejects a bad decimal string proposalId", () => {
    expect(() => VoteV1.parse({ ...validVote, proposalId: "0x1" })).toThrow();
  });

  it("rejects an unknown support value", () => {
    expect(() => VoteV1.parse({ ...validVote, support: "MAYBE" })).toThrow();
  });

  it("rejects an empty rationale", () => {
    expect(() => VoteV1.parse({ ...validVote, rationale: "" })).toThrow();
  });

  it("rejects a confidenceBps above 10000", () => {
    expect(() => VoteV1.parse({ ...validVote, confidenceBps: 10001 })).toThrow();
  });

  it("rejects a negative confidenceBps", () => {
    expect(() => VoteV1.parse({ ...validVote, confidenceBps: -1 })).toThrow();
  });

  it("rejects a non-integer confidenceBps", () => {
    expect(() => VoteV1.parse({ ...validVote, confidenceBps: 100.5 })).toThrow();
  });
});
