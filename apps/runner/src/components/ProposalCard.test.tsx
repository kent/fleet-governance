// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { buildDecisionDescription } from "@fleet/sdk";
import type { DecisionV1 } from "@fleet/schemas";
import ProposalCard from "./ProposalCard.js";
import type { ProposalCardProps } from "./ProposalCard.js";

afterEach(() => cleanup());

const DECISION: DecisionV1 = {
  schema: "fleet.decision.v1",
  taskId: "1",
  kind: "GRANT_EXCEPTION",
  expectedVersion: 1,
  payloadHash: `0x${"aa".repeat(32)}`,
  proposerAgentId: 0,
  action: { class: "network_fetch", target: "registry.npmjs.org", argsHash: `0x${"bb".repeat(32)}` },
  summary: "Allow fetching an extra package registry mirror",
  rationale: "The primary registry timed out twice during the task",
  assumptions: ["the mirror serves the same package contents"],
  riskFlags: ["external-network"],
};

const TALLY = { forTokens: "2000000000000000000", againstTokens: "1000000000000000000", abstainTokens: "0", forMembers: 2, againstMembers: 1, abstainMembers: 0 };

function baseProps(overrides: Partial<ProposalCardProps> = {}): ProposalCardProps {
  return {
    proposalId: "555",
    taskId: "1",
    kind: "GRANT_EXCEPTION",
    status: "Active",
    rawDescription: buildDecisionDescription(DECISION, "planner"),
    tally: TALLY,
    votes: [
      { voter: "0xaaa0000000000000000000000000000000000a", agentId: 0, support: 1, reason: "FOR. looks fine [flags: none; confidence: 0.90]" },
      { voter: "0xbbb0000000000000000000000000000000000b", agentId: 1, support: 0, reason: "AGAINST. too risky [flags: external-network; confidence: 0.40]" },
    ],
    agoraLink: "http://localhost:3000/proposals/555",
    ...overrides,
  };
}

describe("ProposalCard", () => {
  it("renders the onchain register (kind, status, tally) separately from the agent-authored register", () => {
    render(<ProposalCard {...baseProps()} />);
    const onchain = screen.getByLabelText("Onchain");
    expect(onchain.textContent).toContain("GRANT_EXCEPTION");
    expect(onchain.textContent).toContain("Active");
    expect(onchain.textContent).toContain("2000000000000000000");

    const agentText = screen.getByLabelText("Agent-authored text");
    expect(agentText.textContent).toContain("Allow fetching an extra package registry mirror");
    expect(agentText.textContent).toContain("The primary registry timed out twice during the task");
    expect(agentText.textContent).toContain("external-network");

    // The onchain register never renders agent prose, and vice versa.
    expect(onchain.textContent).not.toContain("Allow fetching an extra package registry mirror");
    expect(agentText.textContent).not.toContain("Active");
  });

  it('shows "description did not decode" and the raw text when the description does not parse', () => {
    render(<ProposalCard {...baseProps({ rawDescription: "not a decision description at all" })} />);
    expect(screen.getByText(/description did not decode/)).toBeTruthy();
    const agentText = screen.getByLabelText("Agent-authored text");
    expect(agentText.textContent).toContain("not a decision description at all");
  });

  it("labels each vote's parsed fields as parsed from the reason, alongside the raw onchain reason", () => {
    render(<ProposalCard {...baseProps()} />);
    const votes = screen.getByLabelText("Votes");
    expect(votes.textContent).toContain('Onchain reason: "FOR. looks fine [flags: none; confidence: 0.90]"');
    expect(votes.textContent).toContain("parsed from the reason: support FOR");
    expect(votes.textContent).toContain("confidence 0.9");
  });

  it("shows the Agora Next link when agoraLink is set", () => {
    render(<ProposalCard {...baseProps({ agoraLink: "http://localhost:3000/proposals/555" })} />);
    const link = screen.getByRole("link", { name: /view on agora next/i }) as HTMLAnchorElement;
    expect(link.href).toBe("http://localhost:3000/proposals/555");
  });

  it("hides the Agora Next link when agoraLink is null", () => {
    render(<ProposalCard {...baseProps({ agoraLink: null })} />);
    expect(screen.queryByRole("link", { name: /view on agora next/i })).toBeNull();
  });

  it('renders "kind not yet indexed" rather than "unknown" when kind is null (fix round 1, F2)', () => {
    render(<ProposalCard {...baseProps({ kind: null })} />);
    expect(screen.getByLabelText("Onchain").textContent).toContain("kind not yet indexed");
  });
});
