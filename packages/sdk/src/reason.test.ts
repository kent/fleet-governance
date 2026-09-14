import { describe, expect, it } from "vitest";
import type { VoteV1 } from "@fleet/schemas";
import { ReasonTooLongError, parseVoteReason, renderVoteReason } from "./reason.js";

const BASE_VOTE: VoteV1 = {
  schema: "fleet.vote.v1",
  proposalId: "123",
  support: "AGAINST",
  rationale:
    "The charter forbids fetching from non-allowlisted hosts and the proposal offers no evidence the host is trustworthy.",
  assumptions: ["Task inputs are unchanged."],
  riskFlags: ["scope", "provenance"],
  confidenceBps: 8200,
};

describe("renderVoteReason", () => {
  it("renders the spec 8.3 example exactly", () => {
    const rendered = renderVoteReason(BASE_VOTE);
    expect(rendered).toBe(
      "AGAINST. The charter forbids fetching from non-allowlisted hosts and the proposal offers no evidence the host is trustworthy. [flags: scope, provenance; confidence: 0.82]",
    );
  });

  it("omits the flags/confidence bracket when there are no flags and no confidence", () => {
    const vote: VoteV1 = { ...BASE_VOTE, support: "FOR", riskFlags: [], confidenceBps: undefined };
    const rendered = renderVoteReason(vote);
    expect(rendered).toBe(`FOR. ${vote.rationale}`);
    expect(rendered).not.toContain("[flags");
  });

  it("throws ReasonTooLongError for a reason that encodes over 1024 bytes, never truncating", () => {
    const vote: VoteV1 = { ...BASE_VOTE, rationale: "x".repeat(1025) };
    expect(() => renderVoteReason(vote)).toThrow(ReasonTooLongError);
  });

  it("counts multi-byte UTF-8 characters in bytes, not code units", () => {
    // Each "é" is 2 bytes in UTF-8 but 1 UTF-16 code unit; 600 of them is 1200 bytes, over the limit,
    // even though vote.rationale.length (600) alone looks well under 1024.
    const vote: VoteV1 = { ...BASE_VOTE, rationale: "é".repeat(600), riskFlags: [], confidenceBps: undefined };
    expect(vote.rationale.length).toBeLessThan(1024);
    expect(() => renderVoteReason(vote)).toThrow(ReasonTooLongError);
  });
});

describe("parseVoteReason", () => {
  it("round trips render then parse for a reason with flags and confidence", () => {
    const rendered = renderVoteReason(BASE_VOTE);
    const parsed = parseVoteReason(rendered);
    expect(parsed).toEqual({
      support: "AGAINST",
      rationale: BASE_VOTE.rationale,
      flags: ["scope", "provenance"],
      confidence: 0.82,
    });
  });

  it("round trips a reason with no flags and no confidence", () => {
    const vote: VoteV1 = { ...BASE_VOTE, support: "FOR", riskFlags: [], confidenceBps: undefined };
    const rendered = renderVoteReason(vote);
    const parsed = parseVoteReason(rendered);
    expect(parsed).toEqual({ support: "FOR", rationale: vote.rationale, flags: [], confidence: null });
  });

  it("returns a null support for text that does not start with FOR/AGAINST/ABSTAIN", () => {
    const parsed = parseVoteReason("Not a structured reason at all.");
    expect(parsed.support).toBeNull();
  });
});
