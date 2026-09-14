import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FixtureV1, ManifestV1 } from "@fleet/schemas";
import { ProposalState } from "@fleet/sdk";
import type { DecisionTrace, FleetClient } from "@fleet/sdk";
import type { FixtureRunResult } from "./fixture-runner.js";
import { buildRecord, captureFromChain, readJsonRecord, writeJsonRecord } from "./record.js";
import type { RunRecordDocument } from "./record.js";

const manifest = {
  schema: "fleet.manifest.v1",
  chainId: 31337,
  deploymentBlock: 1,
  deploymentTimestamp: 1_700_000_000,
  deployer: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb9226",
  addresses: {
    registry: "0x5fbdb2315678afecb367f032d93f642f64180aa",
    token: "0xe7f1725e7734ce288f8367e1bb143e90bb3f051",
    timelock: "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e",
    ledger: "0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc",
    hook: "0xfe1bf729317e6eaa74d91b3223964aa6ee0322c",
    governor: "0x5fc8d32690cc91d4c39d9d3abcbd16989f8757",
  },
  hookSalt: `0x${"00".repeat(32)}`,
  members: [],
  operator: "0x976ea74026e726554db657fa54763abd0c3a0aa",
  guardian: "0x14dc79964da2c08b23698b3d3cc7ca32193d995",
  tokenName: "Fleet Vote",
  tokenSymbol: "FLEET",
  configPath: "deployments/configs/local-5.json",
  params: { votingDelay: 15, votingPeriod: 120, proposalThreshold: "0", quorumNumerator: 6000, timelockDelay: 30, maxTaskLifetime: 7200 },
  countingRule: "for-only-quorum",
  hookPermissionMask: "0x22C0",
  configHash: `0x${"11".repeat(32)}`,
  compiler: { solc: "0.8.29", evm: "cancun", optimizerRuns: 200 },
  pins: { agoraGovernor: "abc", openzeppelin: "def" },
  codeHashes: {
    registry: `0x${"22".repeat(32)}`,
    token: `0x${"22".repeat(32)}`,
    timelock: `0x${"22".repeat(32)}`,
    ledger: `0x${"22".repeat(32)}`,
    hook: `0x${"22".repeat(32)}`,
    governor: `0x${"22".repeat(32)}`,
  },
} as unknown as ManifestV1;

const fixture: FixtureV1 = {
  schema: "fleet.fixture.v1",
  name: "hf-replay",
  description: "test fixture",
  trigger: {
    agentId: 1,
    kind: "GRANT_EXCEPTION",
    action: { class: "network_fetch", target: "examples.internal", args: {} },
    summary: "test",
  },
  script: { "1": "FOR", "2": "AGAINST" },
  expected: { outcome: "Defeated", decisionCount: 0, gatewayAfter: "BLOCK" },
};

function fakeTrace(): DecisionTrace {
  return {
    proposalId: 100n,
    actionId: `0x${"33".repeat(32)}`,
    taskId: 1n,
    events: [
      {
        type: "ProposalCreated",
        proposalId: 100n,
        proposer: "0xagent1",
        targets: [manifest.addresses.ledger],
        values: [0n],
        calldatas: ["0xdead"],
        description: "desc",
        blockNumber: 5n,
        logIndex: 0,
        txHash: "0xpropose",
      } as never,
      {
        type: "VoteCast",
        voter: "0xagent1voter",
        proposalId: 100n,
        support: 1,
        weight: 1_000_000_000_000_000_000n,
        reason: "FOR. because reasons",
        blockNumber: 6n,
        logIndex: 0,
        txHash: "0xvote1",
      } as never,
      {
        type: "VoteCast",
        voter: "0xagent2voter",
        proposalId: 100n,
        support: 0,
        weight: 1_000_000_000_000_000_000n,
        reason: "AGAINST. because other reasons",
        blockNumber: 6n,
        logIndex: 1,
        txHash: "0xvote2",
      } as never,
    ],
  };
}

function fakeFixtureRunResult(): FixtureRunResult {
  return {
    fixture,
    taskId: 1n,
    proposalId: 100n,
    proposeTxHash: "0xpropose",
    description: "desc",
    decision: {
      schema: "fleet.decision.v1",
      taskId: "1",
      kind: "GRANT_EXCEPTION",
      expectedVersion: 1,
      payloadHash: `0x${"44".repeat(32)}`,
      proposerAgentId: 1,
      summary: "test",
      rationale: "test fixture",
      assumptions: [],
      riskFlags: [],
    },
    trace: fakeTrace(),
    votes: [
      {
        agentId: 1,
        voterAddress: "0xagent1voter",
        directive: "FOR",
        jobState: "voted",
        vote: {
          schema: "fleet.vote.v1",
          proposalId: "100",
          support: "FOR",
          rationale: "because reasons",
          assumptions: [],
          riskFlags: [],
        },
        txHash: "0xvote1",
        lastError: null,
      },
      {
        agentId: 2,
        voterAddress: "0xagent2voter",
        directive: "AGAINST",
        jobState: "voted",
        vote: {
          schema: "fleet.vote.v1",
          proposalId: "100",
          support: "AGAINST",
          rationale: "because other reasons",
          assumptions: [],
          riskFlags: [],
        },
        txHash: "0xvote2",
        lastError: null,
      },
    ],
    missingVotes: 0,
    gatewayBefore: null,
    gatewayAfter: {
      ts: "2026-01-01T00:00:00.000Z",
      blockNumber: "7",
      taskId: "1",
      agentId: 1,
      charterVersion: 1,
      descriptor: { class: "network_fetch", target: "examples.internal", argsHash: `0x${"55".repeat(32)}` },
      payloadHash: `0x${"44".repeat(32)}`,
      verdict: "BLOCK",
      reason: "target_not_allowlisted",
    },
    guardian: null,
    impostor: null,
    finalState: ProposalState.Defeated,
    finalStateName: "Defeated",
    decisionCount: 0,
    charterVersionAfter: 1,
    fees: [
      { txHash: "0xpropose", gasUsed: "100000", effectiveGasPrice: "1000000000", feeWei: (100_000n * 1_000_000_000n).toString() },
      { txHash: "0xvote1", gasUsed: "80000", effectiveGasPrice: "1000000000", feeWei: (80_000n * 1_000_000_000n).toString() },
      { txHash: "0xvote2", gasUsed: "80000", effectiveGasPrice: "1000000000", feeWei: (80_000n * 1_000_000_000n).toString() },
    ],
    pass: true,
    mismatches: [],
    timings: { startedAt: "t0", activeAt: "t1", votingClosedAt: "t2", finishedAt: "t3" },
  };
}

type FakeReceipt = { blockHash: string; gasUsed: bigint; effectiveGasPrice: bigint };

function fakeClient(receipts: Record<string, FakeReceipt>): FleetClient {
  return {
    publicClient: {
      getTransactionReceipt: async ({ hash }: { hash: string }) => {
        const r = receipts[hash.toLowerCase()];
        if (!r) throw new Error(`no fake receipt for ${hash}`);
        return r;
      },
    },
  } as unknown as FleetClient;
}

const RECEIPTS: Record<string, FakeReceipt> = {
  "0xpropose": { blockHash: "0xblockA", gasUsed: 100_000n, effectiveGasPrice: 1_000_000_000n },
  "0xvote1": { blockHash: "0xblockB", gasUsed: 80_000n, effectiveGasPrice: 1_000_000_000n },
  "0xvote2": { blockHash: "0xblockB", gasUsed: 80_000n, effectiveGasPrice: 1_000_000_000n },
  // The guardian's pause/cancel/unpause and the delegation pre-steps emit no proposal event, so
  // they appear in `fees[]` and nowhere in a decision trace (final review I7).
  "0xguardianpause": { blockHash: "0xblockC", gasUsed: 50_000n, effectiveGasPrice: 1_000_000_000n },
  "0xguardiancancel": { blockHash: "0xblockC", gasUsed: 60_000n, effectiveGasPrice: 1_000_000_000n },
  // The same logical events, re-fetched after the Runner's database was deleted and the chain
  // re-read: different transaction hashes and block numbers, same shape (M10).
  "0xpropose-refetched": { blockHash: "0xblockA2", gasUsed: 111_000n, effectiveGasPrice: 2_000_000_000n },
  "0xvote1-refetched": { blockHash: "0xblockB2", gasUsed: 88_000n, effectiveGasPrice: 2_000_000_000n },
  "0xvote2-refetched": { blockHash: "0xblockB2", gasUsed: 88_000n, effectiveGasPrice: 2_000_000_000n },
};

/** `fakeTrace()`'s logical events as a different node would report them after a re-org-free
 *  re-read from a fresh archive: same proposal, same voters, same reasons, different transaction
 *  hashes and block numbers. Used to prove `captureFromChain` really re-derives rather than
 *  echoing the record it was handed (final review M10). */
function refetchedTrace(): DecisionTrace {
  const base = fakeTrace();
  return {
    ...base,
    events: base.events.map((e) => ({
      ...e,
      blockNumber: (e as { blockNumber: bigint }).blockNumber + 100n,
      txHash: `${(e as { txHash: string }).txHash}-refetched`,
    })) as DecisionTrace["events"],
  };
}

describe("buildRecord", () => {
  it("assembles events with attached block hashes, votes with onchain reasons, fees, and metrics from fake fixture results", async () => {
    const client = fakeClient(RECEIPTS);
    const record = await buildRecord({
      client,
      runId: "run-1",
      config: { schema: "fleet.demo.v1" },
      configHash: `0x${"66".repeat(32)}`,
      manifest,
      results: [fakeFixtureRunResult()],
      timings: { totalMs: 1234 },
      versions: { node: "v22" },
    });

    expect(record.schema).toBe("fleet.record.v1");
    expect(record.proposals).toEqual([
      { fixtureName: "hf-replay", taskId: "1", proposalId: "100", outcome: "Defeated", expectedOutcome: "Defeated", pass: true },
    ]);

    expect(record.events.length).toBe(3);
    for (const e of record.events) {
      expect(e.blockHash).toBeTruthy();
      expect(e.fixtureName).toBe("hf-replay");
    }
    const proposeEvent = record.events.find((e) => e.type === "ProposalCreated");
    expect(proposeEvent?.blockHash).toBe("0xblockA");

    expect(record.votes.length).toBe(2);
    const forVote = record.votes.find((v) => v.agentId === 1);
    expect(forVote?.onchainReason).toBe("FOR. because reasons");
    expect(forVote?.support).toBe(1);
    const againstVote = record.votes.find((v) => v.agentId === 2);
    expect(againstVote?.onchainReason).toBe("AGAINST. because other reasons");

    expect(record.gatewayLog.length).toBe(1);

    expect(record.fees.length).toBe(3);
    const voteFee = record.fees.find((f) => f.txHash === "0xvote1");
    expect(voteFee?.feeWei).toBe((80_000n * 1_000_000_000n).toString());

    expect(record.metrics["fixtureCount"]).toBe(1);
    expect(record.metrics["passCount"]).toBe(1);
    expect((record.metrics["outcomeDistribution"] as Record<string, number>)["Defeated"]).toBe(1);
  });

  it("never places a number where the chain uses uint256: every bigint-derived field round-trips through JSON as a string", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fleet-record-"));
    try {
      const client = fakeClient(RECEIPTS);
      const record = await buildRecord({
        client,
        runId: "run-1",
        config: {},
        configHash: `0x${"66".repeat(32)}`,
        manifest,
        results: [fakeFixtureRunResult()],
        timings: {},
        versions: {},
      });
      const file = path.join(dir, "record.json");
      writeJsonRecord(file, record);
      const raw = readFileSync(file, "utf8");
      // A bigint written unsafely would either throw during JSON.stringify or (if manually
      // .toString()-ed inconsistently) show up as a bare numeric literal for a field this test
      // knows is chain-scale; spot check a couple of fields that started life as `bigint` in the
      // fake data (weight, blockNumber) are quoted strings in the file, not bare JSON numbers.
      expect(raw).toContain('"weight": "1000000000000000000"');
      expect(raw).toContain('"blockNumber": "6"');
      const reparsed = readJsonRecord<RunRecordDocument>(file);
      expect(reparsed.runId).toBe("run-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("captureFromChain", () => {
  it("rebuilds events and votes' onchainReason purely from a re-fetched trace, keeping everything else", async () => {
    const client = fakeClient(RECEIPTS);
    const original = await buildRecord({
      client,
      runId: "run-1",
      config: { note: "original" },
      configHash: `0x${"66".repeat(32)}`,
      manifest,
      results: [fakeFixtureRunResult()],
      timings: { totalMs: 1234 },
      versions: { node: "v22" },
    });

    // A different (but chain-consistent) trace object, simulating a fresh fetch: same logical
    // events, freshly constructed, to prove captureFromChain does not just echo the original.
    const refetched = await captureFromChain(client, original, async () => fakeTrace());

    expect(refetched.config).toEqual(original.config);
    expect(refetched.manifest).toEqual(original.manifest);
    expect(refetched.gatewayLog).toEqual(original.gatewayLog);
    expect(refetched.jobs).toEqual(original.jobs);

    const sortEvents = (arr: typeof original.events) =>
      [...arr].sort((a, b) => `${a["type"]}:${a["txHash"]}:${a["logIndex"]}`.localeCompare(`${b["type"]}:${b["txHash"]}:${b["logIndex"]}`));
    expect(sortEvents(refetched.events)).toEqual(sortEvents(original.events));

    const sortVotes = (arr: typeof original.votes) => [...arr].sort((a, b) => a.voterAddress.localeCompare(b.voterAddress));
    expect(sortVotes(refetched.votes).map((v) => v.onchainReason)).toEqual(sortVotes(original.votes).map((v) => v.onchainReason));
  });

  it("preserves an original vote entry unchanged when the agent never cast an onchain vote (absent/missed)", async () => {
    const client = fakeClient(RECEIPTS);
    const resultWithAbsent: FixtureRunResult = {
      ...fakeFixtureRunResult(),
      votes: [
        ...fakeFixtureRunResult().votes,
        { agentId: 3, voterAddress: "0xagent3voter", directive: "ABSENT", jobState: "absent", vote: null, txHash: null, lastError: "scripted absent" },
      ],
    };
    const original = await buildRecord({
      client,
      runId: "run-1",
      config: {},
      configHash: `0x${"66".repeat(32)}`,
      manifest,
      results: [resultWithAbsent],
      timings: {},
      versions: {},
    });
    const absentOriginal = original.votes.find((v) => v.agentId === 3);
    expect(absentOriginal?.onchainReason).toBeNull();

    const refetched = await captureFromChain(client, original, async () => fakeTrace());
    const absentRefetched = refetched.votes.find((v) => v.agentId === 3);
    expect(absentRefetched).toEqual(absentOriginal);
  });
});

describe("captureFromChain: fees and re-derivation", () => {
  it("keeps fee receipts for transactions no proposal event mentions (final review I7)", async () => {
    // The guardian's pause and cancel are real, chain-derived fees on the live record, and they
    // emit nothing a decision trace carries. Rebuilding `fees[]` from the trace alone dropped
    // them, so `fleet capture --from-chain` did not reproduce the chain-derived record and the
    // report's total transaction fees fell accordingly (spec 12.4).
    const client = fakeClient(RECEIPTS);
    const guardianFees = [
      { txHash: "0xguardianpause" as const, gasUsed: "50000", effectiveGasPrice: "1000000000", feeWei: (50_000n * 1_000_000_000n).toString() },
      { txHash: "0xguardiancancel" as const, gasUsed: "60000", effectiveGasPrice: "1000000000", feeWei: (60_000n * 1_000_000_000n).toString() },
    ];
    const resultWithGuardian: FixtureRunResult = {
      ...fakeFixtureRunResult(),
      fees: [...fakeFixtureRunResult().fees, ...guardianFees] as FixtureRunResult["fees"],
    };
    const original = await buildRecord({
      client,
      runId: "run-1",
      config: {},
      configHash: `0x${"66".repeat(32)}`,
      manifest,
      results: [resultWithGuardian],
      timings: {},
      versions: {},
    });
    expect(original.fees.length).toBe(5);

    const refetched = await captureFromChain(client, original, async () => fakeTrace());

    const sortHashes = (arr: typeof original.fees) => arr.map((f) => f.txHash).sort();
    expect(sortHashes(refetched.fees)).toEqual(sortHashes(original.fees));
    const guardianFee = refetched.fees.find((f) => f.txHash === "0xguardiancancel");
    expect(guardianFee?.feeWei).toBe((60_000n * 1_000_000_000n).toString());
  });

  it("re-derives events, votes and fees from the trace it is given, never echoing the record", async () => {
    // Final review M10: both sides of the old assertion came from the same `fakeTrace()` factory,
    // so an implementation that copied `existing` verbatim would have passed. This one hands the
    // re-capture the same logical events with different transaction hashes and block numbers.
    const client = fakeClient(RECEIPTS);
    const original = await buildRecord({
      client,
      runId: "run-1",
      config: {},
      configHash: `0x${"66".repeat(32)}`,
      manifest,
      results: [fakeFixtureRunResult()],
      timings: {},
      versions: {},
    });

    const refetched = await captureFromChain(client, original, async () => refetchedTrace());

    expect(refetched.events.map((e) => e["txHash"]).sort()).toEqual(
      ["0xpropose-refetched", "0xvote1-refetched", "0xvote2-refetched"].sort(),
    );
    expect(refetched.events.map((e) => String(e["blockNumber"])).sort()).toEqual(["105", "106", "106"].sort());
    expect(refetched.events.find((e) => e["type"] === "ProposalCreated")?.blockHash).toBe("0xblockA2");

    // Votes are re-keyed by voter, so the onchain reasons survive while the tx hashes move.
    const vote1 = refetched.votes.find((v) => v.voterAddress === "0xagent1voter");
    expect(vote1?.txHash).toBe("0xvote1-refetched");
    expect(vote1?.onchainReason).toBe("FOR. because reasons");
    expect(vote1?.agentId).toBe(1);

    // Fees come from the re-fetched receipts, not from the record's own numbers.
    const refetchedFee = refetched.fees.find((f) => f.txHash === "0xvote1-refetched");
    expect(refetchedFee?.effectiveGasPrice).toBe("2000000000");
    expect(refetchedFee?.feeWei).toBe((88_000n * 2_000_000_000n).toString());
    // The original three transactions are still represented: their hashes are in `existing.fees`.
    expect(refetched.fees.map((f) => f.txHash).sort()).toEqual(
      ["0xpropose", "0xpropose-refetched", "0xvote1", "0xvote1-refetched", "0xvote2", "0xvote2-refetched"].sort(),
    );
  });
});
