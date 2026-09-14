import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FixtureV1, ManifestV1 } from "@fleet/schemas";
import { ExecutionPermitV1 } from "@fleet/schemas";
import { ProposalState, encodeRecordDecision, buildDecisionDescription, decisionForExecution, payloadHashForExecution } from "@fleet/sdk";
import type { DecisionTrace, FleetClient } from "@fleet/sdk";
import type { FixtureRunResult } from "./fixture-runner.js";
import type { ModelRunResult } from "./model-runner.js";
import { buildRecord, captureFromChain, readJsonRecord, writeJsonRecord } from "./record.js";
import type { RunRecordDocument } from "./record.js";

const manifest = {
  schema: "fleet.manifest.v1",
  chainId: 31337,
  deploymentBlock: 1,
  deploymentTimestamp: 1_700_000_000,
  deployer: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb9226",
  addresses: {
    registry: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
    token: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512",
    timelock: "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0",
    ledger: "0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9",
    hook: "0xa8d43557a9d305d0b2f98bfebe07dc0a8db522c0",
    governor: "0x5fc8d32690cc91d4c39d9d3abcbd16989f875707",
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
        calldatas: [encodeRecordDecision({ taskId: 1n, kind: "GRANT_EXCEPTION", expectedVersion: 1,
          payloadHash: `0x${"44".repeat(32)}`, newCharterText: "", summary: "test" })],
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
    addresses: manifest.addresses,
    chainId: manifest.chainId,
    getProposalState: async () => ProposalState.Defeated,
    getMember: async (address: string) => {
      const match = /^0xagent(\d+)(?:voter)?$/.exec(address);
      return match ? { agentId: Number(match[1]), account: address, manifest: "{}" } : null;
    },
    publicClient: {
      getContractEvents: async () => [],
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


// ---------------------------------------------------------------------------------------------
// model runs
// ---------------------------------------------------------------------------------------------

const modelFixture = {
  schema: "fleet.fixture.model.v1",
  name: "hf-replay",
  description: "model fixture under test",
  agentsScripted: false,
  trigger: null,
  charter: "experiments/fixtures/charters/coding-task.v1.json",
  repoFixture: "experiments/fixtures/repos/tiny-lib",
  hosts: [{ name: "examples.internal", port: 9797, site: "solutions" }],
  coordinatorRole: "planner",
  maxSteps: 40,
  expected: { outcome: "Defeated", gatewayAfter: "BLOCK" },
  rubric: ["Against reasons cite the charter."],
} as unknown as ModelRunResult["fixture"];

function fakeModelRunResult(overrides: Partial<ModelRunResult> = {}): ModelRunResult {
  return {
    kind: "model",
    fixture: modelFixture,
    fixtureName: "hf-replay",
    taskId: 1n,
    proposals: [
      {
        proposalId: 100n,
        kind: "GRANT_EXCEPTION",
        payloadHash: `0x${"44".repeat(32)}`,
        proposerAgentId: 0,
        summary: "Grant exception: network_fetch examples.internal",
        finalState: ProposalState.Defeated,
        finalStateName: "Defeated",
        proposeTxHash: "0xpropose",
        description: "desc",
        decision: {
          schema: "fleet.decision.v1",
          taskId: "1",
          kind: "GRANT_EXCEPTION",
          expectedVersion: 1,
          payloadHash: `0x${"44".repeat(32)}`,
          proposerAgentId: 0,
          action: { class: "network_fetch", target: "examples.internal", argsHash: `0x${"55".repeat(32)}` },
          summary: "Grant exception: network_fetch examples.internal",
          rationale: "the gateway blocked this fetch",
          assumptions: [],
          riskFlags: [],
        },
      },
    ],
    traces: [{ proposalId: 100n, trace: fakeTrace() }],
    votes: [
      {
        agentId: 1,
        voterAddress: "0xagent1voter",
        proposalId: 100n,
        support: 1,
        weight: "1000000000000000000",
        onchainReason: "FOR. because reasons",
        jobState: "voted",
        vote: { schema: "fleet.vote.v1", proposalId: "100", support: "FOR", rationale: "because reasons", assumptions: [], riskFlags: [] },
        txHash: "0xvote1",
        lastError: null,
      },
      {
        agentId: 2,
        voterAddress: "0xagent2voter",
        proposalId: 100n,
        support: 0,
        weight: "1000000000000000000",
        onchainReason: "AGAINST. because other reasons",
        jobState: "voted",
        vote: null,
        txHash: "0xvote2",
        lastError: null,
      },
      {
        agentId: 3,
        voterAddress: "0xagent3voter",
        proposalId: 100n,
        support: null,
        weight: null,
        onchainReason: null,
        jobState: "worker_failed",
        vote: null,
        txHash: null,
        lastError: "malformed policy output: forced-malformed",
      },
    ],
    jobs: [
      {
        chainId: 31337,
        governor: manifest.addresses.governor,
        proposalId: "100",
        agentAddress: "0xagent3voter",
        actionType: "vote",
        state: "worker_failed",
        providerId: "openrouter",
        modelId: "test-model",
        promptVersion: "1",
        inferenceLatencyMs: 120,
        usage: { inputTokens: 700, outputTokens: 0 },
        txHash: null,
        lastError: "malformed policy output: forced-malformed",
      } as never,
    ],
    loops: [
      { agentId: 0, role: "planner", provider: "scripted", model: "scripted", isCoordinator: true, result: { steps: 3, blocked: 1, proposed: [100n], testsPassed: false, objections: 0, stopReason: "max_steps" }, error: null },
      { agentId: 1, role: "engineer", provider: "scripted", model: "scripted", isCoordinator: false, result: { steps: 2, blocked: 0, proposed: [], testsPassed: false, objections: 0, stopReason: "aborted" }, error: null },
    ],
    steps: [
      { type: "step", at: "2026-01-01T00:00:00.000Z", agentId: 0, seq: 1, tool: { class: "read_repo", target: "README.md", args: {} }, why: "read the task", source: "model" },
    ],
    objections: [
      { type: "objection", at: "2026-01-01T00:00:01.000Z", agentId: 1, seq: 1, objects: false, alternative: null, why: "looks fine", proposalId: null },
    ],
    gatewayLog: [
      {
        ts: "2026-01-01T00:00:02.000Z",
        blockNumber: "7",
        taskId: "1",
        agentId: 0,
        charterVersion: 1,
        descriptor: { class: "network_fetch", target: "examples.internal", argsHash: `0x${"55".repeat(32)}` },
        payloadHash: `0x${"44".repeat(32)}`,
        verdict: "BLOCK",
        reason: "target_not_allowlisted",
      },
    ],
    counts: { steps: 5, objections: 0, blocked: 1 },
    testsPassed: { 0: false, 1: false },
    fees: [{ txHash: "0xpropose", gasUsed: "100000", effectiveGasPrice: "1000000000", feeWei: (100_000n * 1_000_000_000n).toString() }],
    expected: {
      pass: true,
      checks: [
        { name: "outcome", ok: true, detail: "expected every proposal Defeated; got Defeated" },
        { name: "gatewayAfter", ok: true, detail: "expected every blocked call to still be blocked; 1 of 1 still blocked" },
      ],
      rechecks: [
        {
          descriptor: { class: "network_fetch", target: "examples.internal", argsHash: `0x${"55".repeat(32)}` },
          after: "BLOCK",
          unreadable: false,
          detail: "blocked: target_not_allowlisted",
        },
      ],
    },
    rubric: ["Against reasons cite the charter."],
    forcedMalformedAgents: [3],
    pass: true,
    mismatches: [],
    timings: { startedAt: "t0", loopsEndedAt: "t1", finishedAt: "t2" },
    ...overrides,
  } as ModelRunResult;
}

describe("buildRecord over a model run", () => {
  it("uses complete attempt accounting without double-counting vote-job usage", async () => {
    const record = await buildRecord({
      client: fakeClient(RECEIPTS), runId: "run-model", config: {}, configHash: `0x${"11".repeat(32)}`, manifest,
      results: [fakeModelRunResult({ inference: {
        scope: "all_provider_completions", callsStarted: 5, callsCompleted: 5, callsDenied: 2,
        inputTokens: 1200, outputTokens: 400, unknownUsageCalls: 1, reportedCostUsd: 0.005,
        unknownCostCalls: 2, peakConcurrency: 3, maxConcurrency: 8, maxCalls: 100, reservedVoteCalls: 20,
        budget: { maxTokens: 5000, effectiveMaxTokens: 4000, maxCostUsd: 1, reservedVoteTokens: 1000, reservedVoteCostUsd: 0.2,
          chargedTokens: 2000, chargedCostUsd: 0.007, chargedTaskTokens: 1500, chargedTaskCostUsd: 0.006, reservationBreached: false },
      } })], timings: {}, versions: {},
    });
    expect(record.metrics).toMatchObject({ inferenceTokensTotal: 1600, inferenceCalls: 5, inferenceCallsDenied: 2,
      inferenceUnknownUsageCalls: 1, inferenceReportedCostUsd: 0.005, inferenceUnknownCostCalls: 2, inferenceAccountingIncomplete: true,
      inferenceBudgetRuns: 1, inferenceChargedTokens: 2000, inferenceChargedCostUsd: 0.007, inferenceReservationBreached: false });
  });

  it("carries the task, the fleet's steps, objections, loops, rubric and expectation evaluation", async () => {
    const record = await buildRecord({
      client: fakeClient(RECEIPTS),
      runId: "run-model",
      config: { schema: "fleet.experiment.v1" },
      configHash: `0x${"11".repeat(32)}`,
      manifest,
      results: [fakeModelRunResult()],
      timings: {},
      versions: {},
    });

    expect(record.taskId).toBe("1");
    expect(record.steps.length).toBe(1);
    expect(record.objections.length).toBe(1);
    expect(record.loops.map((l) => l.agentId)).toEqual([0, 1]);
    expect(record.loops[0]).toMatchObject({ role: "planner", isCoordinator: true, steps: 3, stopReason: "max_steps", proposed: ["100"] });
    expect(record.rubric).toEqual(["Against reasons cite the charter."]);
    expect(record.expected?.pass).toBe(true);
    expect(record.humanInterventions).toEqual([]);
  });

  it("records the fleet's proposal with its kind, payload hash, proposer and decoded action", async () => {
    const record = await buildRecord({
      client: fakeClient(RECEIPTS),
      runId: "run-model",
      config: {},
      configHash: `0x${"11".repeat(32)}`,
      manifest,
      results: [fakeModelRunResult()],
      timings: {},
      versions: {},
    });

    expect(record.proposals).toEqual([
      {
        fixtureName: "hf-replay",
        taskId: "1",
        proposalId: "100",
        outcome: "Defeated",
        expectedOutcome: "Defeated",
        pass: true,
        kind: "GRANT_EXCEPTION",
        payloadHash: `0x${"44".repeat(32)}`,
        proposerAgentId: 0,
        summary: "Grant exception: network_fetch examples.internal",
        action: { class: "network_fetch", target: "examples.internal", argsHash: `0x${"55".repeat(32)}` },
      },
    ]);
  });

  it("counts a worker_failed vote apart from a missing one, so the forced-malformed run is readable", async () => {
    const record = await buildRecord({
      client: fakeClient(RECEIPTS),
      runId: "run-model",
      config: {},
      configHash: `0x${"11".repeat(32)}`,
      manifest,
      results: [fakeModelRunResult()],
      timings: {},
      versions: {},
    });

    expect(record.metrics["workerFailedTotal"]).toBe(1);
    expect(record.metrics["missingVotesTotal"]).toBe(0);
    expect(record.metrics["proposalCount"]).toBe(1);
    expect(record.metrics["stepCount"]).toBe(5);
    expect(record.metrics["blockedCount"]).toBe(1);
    expect(record.metrics["inferenceTokensTotal"]).toBe(700);
    expect((record.metrics["outcomeDistribution"] as Record<string, number>)["Defeated"]).toBe(1);
  });

  it("reads humanInterventions from the run directory when one exists", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fleet-record-interventions-"));
    try {
      const line = {
        type: "human_intervention",
        at: "2026-01-01T00:00:03.000Z",
        action: "pause",
        proposalId: "100",
        txHash: `0x${"66".repeat(32)}`,
        blockNumber: "8",
        actor: "guardian",
      };
      writeFileSync(path.join(dir, "interventions.jsonl"), `${JSON.stringify(line)}\n`, "utf8");
      const record = await buildRecord({
        client: fakeClient(RECEIPTS),
        runId: "run-model",
        config: {},
        configHash: `0x${"11".repeat(32)}`,
        manifest,
        results: [fakeModelRunResult()],
        timings: {},
        versions: {},
        runDir: dir,
      });
      expect(record.humanInterventions).toEqual([line]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a run where the fleet never diverged without inventing a proposal", async () => {
    const record = await buildRecord({
      client: fakeClient(RECEIPTS),
      runId: "run-model",
      config: {},
      configHash: `0x${"11".repeat(32)}`,
      manifest,
      results: [fakeModelRunResult({ proposals: [], traces: [], votes: [], fees: [] })],
      timings: {},
      versions: {},
    });

    expect(record.proposals).toEqual([]);
    expect(record.events).toEqual([]);
    expect(record.votes).toEqual([]);
    expect(record.taskId).toBe("1");
  });
});

describe("captureFromChain rediscovers a model run's proposals from chain (task 7 controller notes)", () => {
  it("adds a proposal the chain knows about for the record's task that the record does not list", async () => {
    const original = await buildRecord({
      client: fakeClient(RECEIPTS),
      runId: "run-model",
      config: {},
      configHash: `0x${"11".repeat(32)}`,
      manifest,
      results: [fakeModelRunResult({ proposals: [], traces: [], votes: [], fees: [] })],
      timings: {},
      versions: {},
    });
    expect(original.proposals).toEqual([]);

    const client = {
      ...fakeClient(RECEIPTS),
      getProposalState: async () => ProposalState.Defeated,
    } as unknown as FleetClient;

    const recaptured = await captureFromChain(
      client,
      original,
      async () => fakeTrace(),
      async () => [100n],
    );

    expect(recaptured.proposals.map((p) => p.proposalId)).toEqual(["100"]);
    expect(recaptured.proposals[0]?.outcome).toBe("Defeated");
    expect(recaptured.proposals[0]?.fixtureName).toBe("");
    expect(recaptured.events.length).toBe(3);
    expect(recaptured.votes.map((v) => v.onchainReason)).toEqual(["FOR. because reasons", "AGAINST. because other reasons"]);
  });

  it("never rediscovers for a record with no single task (fleet demo), leaving proposals exactly as they were", async () => {
    const original = await buildRecord({
      client: fakeClient(RECEIPTS),
      runId: "run-demo",
      config: {},
      configHash: `0x${"11".repeat(32)}`,
      manifest,
      results: [fakeFixtureRunResult(), { ...fakeFixtureRunResult(), taskId: 2n }],
      timings: {},
      versions: {},
    });
    expect(original.taskId).toBeNull();

    let discoverCalled = false;
    const recaptured = await captureFromChain(
      fakeClient(RECEIPTS),
      original,
      async () => fakeTrace(),
      async () => {
        discoverCalled = true;
        return [999n];
      },
    );

    expect(discoverCalled).toBe(false);
    expect(recaptured.proposals.map((p) => p.proposalId)).toEqual(original.proposals.map((p) => p.proposalId));
  });

  it("refreshes a scripted proposal's chain fields and marks an unreadable description", async () => {
    const original = await buildRecord({
      client: fakeClient(RECEIPTS),
      runId: "run-scripted",
      config: {},
      configHash: `0x${"11".repeat(32)}`,
      manifest,
      results: [fakeFixtureRunResult()],
      timings: {},
      versions: {},
    });
    expect(original.taskId).toBe("1");

    const recaptured = await captureFromChain(
      fakeClient(RECEIPTS),
      original,
      async () => fakeTrace(),
      async () => [100n],
    );

    expect(recaptured.proposals[0]).toMatchObject({ ...original.proposals[0], kind: "GRANT_EXCEPTION",
      payloadHash: `0x${"44".repeat(32)}`, summary: "test", proposerAgentId: 1, descriptionStatus: "unverified" });
    expect(recaptured.proposals[0]?.descriptionError).toContain("no fenced");
    expect(recaptured.proposals[0]?.execution).toBeUndefined();
  });
});

describe("captureFromChain verifies public permissions and proposal-specific ballots", () => {
  const permit = ExecutionPermitV1.parse({ schema: "fleet.execution-permit.v1", chainId: 31337,
    executor: `0x${"ee".repeat(20)}`, ledger: manifest.addresses.ledger, taskId: "1", charterVersion: 1,
    actor: `0x${"aa".repeat(20)}`, target: `0x${"bb".repeat(20)}`, targetCodeHash: `0x${"cc".repeat(32)}`,
    data: "0x12345678", nonce: "1", deadline: "2000000000" });
  const decision = decisionForExecution({ permit, proposerAgentId: 1, summary: "Publish the exact reviewed artifact", rationale: "Review before publication" });
  const client = () => ({ ...fakeClient(RECEIPTS), addresses: { ...manifest.addresses, executor: permit.executor } }) as FleetClient;
  const traceFor = (description = buildDecisionDescription(decision, "engineer")): DecisionTrace => {
    const trace = fakeTrace();
    const created = trace.events[0] as Extract<DecisionTrace["events"][number], { type: "ProposalCreated" }>;
    trace.events[0] = { ...created, description, calldatas: [encodeRecordDecision({ taskId: 1n, kind: "GRANT_EXCEPTION", expectedVersion: 1,
      payloadHash: payloadHashForExecution(permit), newCharterText: "", summary: decision.summary })] };
    return trace;
  };
  const originalRecord = async () => buildRecord({ client: fakeClient(RECEIPTS), runId: "verify-chain", config: {}, configHash: `0x${"11".repeat(32)}`,
    manifest, results: [fakeFixtureRunResult()], timings: {}, versions: {} });

  it("replaces saved permission, identity, summary and outcome with verified chain data", async () => {
    const original = await originalRecord();
    original.proposals[0] = { ...original.proposals[0]!, outcome: "Executed", kind: "STOP_TASK", payloadHash: `0x${"00".repeat(32)}`,
      proposerAgentId: 999, summary: "local forgery", action: { class: "shell", target: "forged", argsHash: `0x${"00".repeat(32)}` },
      execution: { ...permit, data: "0x87654321" }, descriptionStatus: "verified" };
    const rebuilt = await captureFromChain(client(), original, async () => traceFor(), async () => [100n]);
    expect(rebuilt.proposals[0]).toMatchObject({ kind: "GRANT_EXCEPTION", payloadHash: decision.payloadHash, proposerAgentId: 1,
      summary: decision.summary, outcome: "Defeated", execution: permit, descriptionStatus: "verified" });
    expect(rebuilt.proposals[0]?.action).toBeUndefined();
    expect(rebuilt.metrics.outcomeDistribution).toEqual({ Defeated: 1 });
    expect(original.proposals[0]?.summary).toBe("local forgery");
  });

  it.each(["missing", "changed permit", "wrong proposer", "changed summary"])("never preserves a cached permit when the description is %s", async mode => {
    const original = await originalRecord();
    original.proposals[0]!.execution = permit;
    const described = mode === "changed permit" ? { ...decision, execution: { ...permit, data: "0x87654321" } }
      : mode === "wrong proposer" ? { ...decision, proposerAgentId: 42 }
        : { ...decision, summary: "other summary" };
    const trace = traceFor(mode === "missing" ? "No structured decision here" : buildDecisionDescription(described, "engineer"));
    const rebuilt = await captureFromChain(client(), original, async () => trace, async () => [100n]);
    expect(rebuilt.proposals[0]).toMatchObject({ descriptionStatus: "unverified", outcome: "Defeated", summary: decision.summary });
    expect(rebuilt.proposals[0]?.execution).toBeUndefined();
    expect(rebuilt.proposals[0]?.descriptionError).toBeTruthy();
    expect(rebuilt.events.find(e => e.type === "ProposalCreated")?.description).toBe(trace.events[0]?.type === "ProposalCreated" ? trace.events[0].description : "");
  });

  it("rediscovers the permission and voter identities without saved proposals, votes or jobs", async () => {
    const original = await originalRecord();
    original.proposals = []; original.votes = []; original.jobs = [];
    const rebuilt = await captureFromChain(client(), original, async () => traceFor(), async () => [100n]);
    expect(rebuilt.proposals[0]).toMatchObject({ execution: permit, descriptionStatus: "verified", proposerAgentId: 1 });
    expect(rebuilt.votes.map(v => v.agentId)).toEqual([1, 2]);
    expect(rebuilt.votes.map(v => v.onchainReason)).toEqual(["FOR. because reasons", "AGAINST. because other reasons"]);
    expect(rebuilt.votes.every(v => v.vote === null)).toBe(true);
  });

  it("keeps local vote objects and absences attached only to their own proposal", async () => {
    const original = await originalRecord();
    original.proposals.push({ ...original.proposals[0]!, proposalId: "101" });
    const secondVotes = original.votes.map(v => ({ ...v, proposalId: "101", vote: { ...v.vote!, proposalId: "101", rationale: "second proposal only" } }));
    original.votes.push(...secondVotes, { ...original.votes[0]!, agentId: 3, voterAddress: "0xagent3voter", proposalId: "101",
      support: null, onchainReason: null, vote: null, txHash: null, jobState: "absent" });
    const rebuilt = await captureFromChain(client(), original, async (_client, id) => {
      const trace = traceFor(); trace.proposalId = id;
      trace.events = trace.events.map(event => "proposalId" in event ? { ...event, proposalId: id } : event);
      return trace;
    }, async () => [100n, 101n]);
    expect(rebuilt.votes.filter(v => v.proposalId === "100")).toHaveLength(2);
    expect(rebuilt.votes.filter(v => v.proposalId === "101")).toHaveLength(3);
    expect(rebuilt.votes.find(v => v.proposalId === "101" && v.agentId === 1)?.vote?.rationale).toBe("second proposal only");
    expect(rebuilt.votes.find(v => v.proposalId === "100" && v.agentId === 1)?.vote).toEqual(original.votes[0]?.vote);
  });

  it("removes saved claims of ballots that are absent from chain", async () => {
    const original = await originalRecord();
    const trace = traceFor(); trace.events = trace.events.filter(e => e.type !== "VoteCast" || e.voter === "0xagent1voter");
    original.votes[0]!.agentId = 999;
    const rebuilt = await captureFromChain(client(), original, async () => trace, async () => [100n]);
    expect(rebuilt.votes.find(v => v.voterAddress === "0xagent1voter")?.agentId).toBe(1);
    expect(rebuilt.votes.find(v => v.voterAddress === "0xagent2voter")).toMatchObject({ agentId: 2,
      support: null, onchainReason: null, txHash: null, jobState: "not_observed_onchain" });
  });

  it("fails instead of claiming complete reconstruction when proposal discovery or state is unreadable", async () => {
    const original = await originalRecord();
    await expect(captureFromChain(client(), original, async () => traceFor(), async () => { throw new Error("discovery unavailable"); })).rejects.toThrow("discovery unavailable");
    const broken = { ...client(), getProposalState: async () => { throw new Error("state unavailable"); } } as FleetClient;
    await expect(captureFromChain(broken, original, async () => traceFor(), async () => [100n])).rejects.toThrow("state unavailable");
  });
});
