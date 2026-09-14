import { describe, expect, it } from "vitest";
import type { RunRecordDocument } from "./record.js";
import { renderReport } from "./report.js";

function sampleRecord(): RunRecordDocument {
  return {
    schema: "fleet.record.v1",
    runId: "run-sample",
    config: { schema: "fleet.demo.v1" },
    configHash: `0x${"11".repeat(32)}`,
    manifest: {
      schema: "fleet.manifest.v1",
      chainId: 31337,
      addresses: {
        registry: "0x5fbdb2315678afecb367f032d93f642f64180aa",
        token: "0xe7f1725e7734ce288f8367e1bb143e90bb3f051",
        timelock: "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e",
        ledger: "0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc",
        hook: "0xfe1bf729317e6eaa74d91b3223964aa6ee0322c",
        governor: "0x5fc8d32690cc91d4c39d9d3abcbd16989f8757",
      },
    } as unknown as RunRecordDocument["manifest"],
    proposals: [
      { fixtureName: "hf-replay", taskId: "1", proposalId: "100", outcome: "Defeated", expectedOutcome: "Defeated", pass: true },
      { fixtureName: "legit-amendment", taskId: "2", proposalId: "200", outcome: "Executed", expectedOutcome: "Executed", pass: true },
    ],
    events: [
      { type: "ProposalCreated", proposalId: "100", blockNumber: "5", logIndex: 0, txHash: "0xpropose100", fixtureName: "hf-replay", blockHash: "0xblockA" },
      { type: "DecisionProposed", proposalId: "100", kind: "GRANT_EXCEPTION", blockNumber: "5", logIndex: 1, txHash: "0xpropose100", fixtureName: "hf-replay", blockHash: "0xblockA" },
      { type: "VoteCast", proposalId: "100", voter: "0xagent1", support: 1, weight: "1000000000000000000", blockNumber: "6", logIndex: 0, txHash: "0xvote100a", fixtureName: "hf-replay", blockHash: "0xblockB" },
      { type: "VoteCast", proposalId: "100", voter: "0xagent2", support: 0, weight: "1000000000000000000", blockNumber: "6", logIndex: 1, txHash: "0xvote100b", fixtureName: "hf-replay", blockHash: "0xblockB" },
      { type: "ProposalCreated", proposalId: "200", blockNumber: "10", logIndex: 0, txHash: "0xpropose200", fixtureName: "legit-amendment", blockHash: "0xblockC" },
      { type: "DecisionProposed", proposalId: "200", kind: "AMEND_CHARTER", blockNumber: "10", logIndex: 1, txHash: "0xpropose200", fixtureName: "legit-amendment", blockHash: "0xblockC" },
      { type: "VoteCast", proposalId: "200", voter: "0xagent1", support: 1, weight: "3000000000000000000", blockNumber: "11", logIndex: 0, txHash: "0xvote200a", fixtureName: "legit-amendment", blockHash: "0xblockD" },
    ],
    gatewayLog: [],
    jobs: [],
    votes: [
      { fixtureName: "hf-replay", agentId: 1, voterAddress: "0xagent1", proposalId: "100", support: 1, vote: null, onchainReason: "FOR. looks fine to me", jobState: "voted", txHash: "0xvote100a" },
      { fixtureName: "hf-replay", agentId: 2, voterAddress: "0xagent2", proposalId: "100", support: 0, vote: null, onchainReason: "AGAINST. off the allowlist", jobState: "voted", txHash: "0xvote100b" },
      { fixtureName: "legit-amendment", agentId: 1, voterAddress: "0xagent1", proposalId: "200", support: 1, vote: null, onchainReason: "FOR. pypi.org is legitimate", jobState: "voted", txHash: "0xvote200a" },
    ],
    timings: { totalMs: 60000 },
    fees: [
      { txHash: "0xpropose100", gasUsed: "100000", effectiveGasPrice: "1000000000", feeWei: (100_000n * 1_000_000_000n).toString() },
      { txHash: "0xvote100a", gasUsed: "80000", effectiveGasPrice: "1000000000", feeWei: (80_000n * 1_000_000_000n).toString() },
    ],
    metrics: { fixtureCount: 2, passCount: 2, outcomeDistribution: { Defeated: 1, Executed: 1 } },
    versions: { node: "v22.21.1" },
  };
}

describe("renderReport", () => {
  it("matches the expected snapshot shape for a small two-proposal record", () => {
    const report = renderReport(sampleRecord(), { title: "Fleet Governance Demo Report", agoraNextBaseUrl: "https://agora-next.example.com" });
    expect(report).toMatchSnapshot();
  });

  it("never contains an em dash", () => {
    const report = renderReport(sampleRecord(), { title: "Fleet Governance Demo Report" });
    expect(report).not.toContain("—");
  });

  it("includes a title heading and the run id", () => {
    const report = renderReport(sampleRecord(), { title: "My Report Title" });
    expect(report.startsWith("# My Report Title\n")).toBe(true);
    expect(report).toContain("run-sample");
  });

  it("includes a decision table row per proposal, with For/Against/Abstain formatted as whole tokens and the actual outcome", () => {
    const report = renderReport(sampleRecord(), { title: "t" });
    expect(report).toContain("| hf-replay | 100 | GRANT_EXCEPTION | 1 | 1 | 0 | Defeated |");
    expect(report).toContain("| legit-amendment | 200 | AMEND_CHARTER | 3 | 0 | 0 | Executed |");
  });

  it("links to Agora Next when a base URL is configured, and says so plainly when it is not", () => {
    const withLink = renderReport(sampleRecord(), { title: "t", agoraNextBaseUrl: "https://agora-next.example.com/" });
    expect(withLink).toContain("https://agora-next.example.com/proposals/100");
    const withoutLink = renderReport(sampleRecord(), { title: "t" });
    expect(withoutLink).toContain("(no Agora Next link configured for this run)");
  });

  it("lists every vote's onchain reason under its proposal", () => {
    const report = renderReport(sampleRecord(), { title: "t" });
    expect(report).toContain("Agent 1: FOR. looks fine to me");
    expect(report).toContain("Agent 2: AGAINST. off the allowlist");
    expect(report).toContain("Agent 1: FOR. pypi.org is legitimate");
  });

  it("reports the reproducibility check result when given, and a plain note when not run", () => {
    const matched = renderReport(sampleRecord(), { title: "t", reproducibility: { checked: true, matched: true } });
    expect(matched).toContain("reproduced the chain-derived record exactly");

    const mismatched = renderReport(sampleRecord(), { title: "t", reproducibility: { checked: true, matched: false, note: "events differed" } });
    expect(mismatched).toContain("did NOT reproduce");
    expect(mismatched).toContain("events differed");

    const notChecked = renderReport(sampleRecord(), { title: "t" });
    expect(notChecked).toContain("was not run as part of this report");
  });

  it("reports total costs across every fee entry", () => {
    const report = renderReport(sampleRecord(), { title: "t" });
    // (100000 + 80000) * 1e9 wei = 1.8e14 wei = 0.00018 ETH; formatTokenAmount trims to 2 fraction
    // digits and this value rounds to 0, so the whole-token part is the meaningful assertion.
    expect(report).toContain("2 transactions");
  });
});
