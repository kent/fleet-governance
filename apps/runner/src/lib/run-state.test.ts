import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Address } from "viem";
import { buildRunState } from "./run-state.js";
import type { RunStateChainClient, RunStateDeps } from "./run-state.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fleet-run-state-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const CHARTER = {
  schema: "fleet.charter.v1" as const,
  goal: "Implement the failing functions in this repository so the provided test suite passes.",
  allowedActionClasses: ["read_repo", "write_repo", "run_tests"] as const,
  forbiddenActions: [],
  externalAllowlist: ["registry.npmjs.org"],
  budget: { toolCalls: 200, inferenceTokens: 400000 },
  stopConditions: ["tests_pass"],
};

const ADDR = {
  agent0: "0x2000000000000000000000000000000000000001",
  agent1: "0x2000000000000000000000000000000000000002",
  operator: "0x2000000000000000000000000000000000000003",
  guardian: "0x2000000000000000000000000000000000000004",
  registry: "0x2000000000000000000000000000000000000005",
  token: "0x2000000000000000000000000000000000000006",
  timelock: "0x2000000000000000000000000000000000000007",
  ledger: "0x2000000000000000000000000000000000000008",
  hook: "0x2000000000000000000000000000000000000009",
  governor: "0x200000000000000000000000000000000000000a",
};

function experimentConfig(name: string) {
  return {
    schema: "fleet.experiment.v1",
    name,
    target: { kind: "local-anvil", rpcHttp: "http://127.0.0.1:9999", rpcWs: "ws://127.0.0.1:9999" },
    fleet: {
      members: [
        { role: "planner", provider: "scripted", model: "scripted-v1", promptVersion: "1", operatorLabel: "local" },
        { role: "engineer", provider: "scripted", model: "scripted-v1", promptVersion: "1", operatorLabel: "local" },
      ],
      tokenName: "Fleet Vote",
      tokenSymbol: "FLEET",
    },
    governance: { votingDelay: 15, votingPeriod: 120, timelockDelay: 30, quorumNumerator: 6000, proposalThreshold: "0", maxTaskLifetime: 7200 },
    task: { charter: CHARTER, lifetime: 7200, repoFixture: "experiments/fixtures/repos/tiny-lib" },
    scenario: { fixture: "hf-replay", agentsScripted: true },
    capture: { reportDir: "experiments/reports" },
    display: { agoraNextBaseUrl: "http://localhost:3000" },
  };
}

function deployConfig() {
  return {
    schema: "fleet.deploy.v1",
    tokenName: "Fleet Vote",
    tokenSymbol: "FLEET",
    members: [ADDR.agent0, ADDR.agent1],
    agentManifests: [
      JSON.stringify({ role: "planner", provider: "scripted", model: "scripted-v1", promptVersion: "1", operator: "local" }),
      JSON.stringify({ role: "engineer", provider: "scripted", model: "scripted-v1", promptVersion: "1", operator: "local" }),
    ],
    fleetManifest: JSON.stringify({ experiment: "run-1", constitution: "fleet.constitution.v1", harness: "runner-ui" }),
    operator: ADDR.operator,
    guardian: ADDR.guardian,
    votingDelay: 15,
    votingPeriod: 120,
    proposalThreshold: "0",
    quorumNumerator: 6000,
    timelockDelay: 30,
    maxTaskLifetime: 7200,
  };
}

function manifest() {
  return {
    schema: "fleet.manifest.v1",
    chainId: 31337,
    deploymentBlock: 5,
    deploymentTimestamp: 1000,
    deployer: ADDR.operator,
    addresses: { registry: ADDR.registry, token: ADDR.token, timelock: ADDR.timelock, ledger: ADDR.ledger, hook: ADDR.hook, governor: ADDR.governor },
    hookSalt: `0x${"11".repeat(32)}`,
    members: [ADDR.agent0, ADDR.agent1],
    operator: ADDR.operator,
    guardian: ADDR.guardian,
    tokenName: "Fleet Vote",
    tokenSymbol: "FLEET",
    configPath: "deployments/configs/run-1.json",
    params: { votingDelay: 15, votingPeriod: 120, proposalThreshold: "0", quorumNumerator: 6000, timelockDelay: 30, maxTaskLifetime: 7200 },
    countingRule: "for-only-quorum",
    hookPermissionMask: "0x22C0",
    configHash: `0x${"22".repeat(32)}`,
    compiler: { solc: "0.8.24", evm: "cancun", optimizerRuns: 200 },
    pins: { agoraGovernor: "abc", openzeppelin: "def" },
    codeHashes: {
      registry: `0x${"33".repeat(32)}`,
      token: `0x${"33".repeat(32)}`,
      timelock: `0x${"33".repeat(32)}`,
      ledger: `0x${"33".repeat(32)}`,
      hook: `0x${"33".repeat(32)}`,
      governor: `0x${"33".repeat(32)}`,
    },
  };
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function baseDeps(overrides: Partial<RunStateDeps> = {}): RunStateDeps {
  return {
    repoRootDir: dir,
    env: {},
    buildClient: () => {
      throw new Error("buildClient not stubbed for this test");
    },
    listProposalIds: async () => [],
    listDecisionEvents: async () => [],
    ...overrides,
  };
}

describe("buildRunState", () => {
  it("returns a near-empty view when nothing has been written for the run yet", async () => {
    const state = await buildRunState("run-missing", baseDeps());
    expect(state.stage).toBeNull();
    expect(state.experimentName).toBeNull();
    expect(state.taskId).toBeNull();
    expect(state.proposals).toEqual([]);
    expect(state.chainEvents).toEqual([]);
    expect(state.agents).toEqual([]);
    expect(state.charter).toEqual({ source: "none", version: null, text: "", parsed: null });
    expect(state.chain.reachable).toBe(false);
  });

  it("assembles the live view from an injected chain client when the chain is reachable", async () => {
    writeJson(path.join(dir, "experiments", "configs", "run-1.json"), experimentConfig("run-1"));
    writeJson(path.join(dir, "deployments", "configs", "run-1.deploy.json"), deployConfig());
    writeJson(path.join(dir, "deployments", "experiment-latest.json"), manifest());
    writeJson(path.join(dir, "experiments", "reports", "run-1", "run-state.json"), {
      runId: "run-1",
      stage: "AGENTS_RUNNING",
      updatedAt: "2026-09-14T00:00:00.000Z",
      payload: { taskId: "1", proposalId: "555" },
    });
    const stepsPath = path.join(dir, "experiments", "reports", "run-1", "steps.jsonl");
    mkdirSync(path.dirname(stepsPath), { recursive: true });
    writeFileSync(
      stepsPath,
      `${JSON.stringify({ type: "step", at: "t0", agentId: 0, seq: 0, tool: { class: "read_repo", target: "README.md", args: {} }, why: "reading the readme", source: "model" })}\n`,
    );
    const gatewayPath = path.join(dir, "experiments", "reports", "run-1", "gateway.jsonl");
    writeFileSync(
      gatewayPath,
      `${JSON.stringify({ ts: "t0", blockNumber: "5", taskId: "1", agentId: 0, charterVersion: 1, descriptor: { class: "read_repo", target: "README.md", argsHash: `0x${"aa".repeat(32)}` }, payloadHash: `0x${"bb".repeat(32)}`, verdict: "ALLOW" })}\n`,
    );
    writeJson(path.join(dir, "experiments", "reports", "ui-runs.json"), [
      {
        runId: "run-1",
        experimentPath: path.join(dir, "experiments", "configs", "run-1.json"),
        deployConfigPath: path.join(dir, "deployments", "configs", "run-1.deploy.json"),
        logPath: path.join(dir, "experiments", "reports", "run-1", "run.log"),
        pid: 1,
        readSide: false,
        createdAt: "2026-09-14T00:00:00.000Z",
      },
    ]);

    const fakeClient: RunStateChainClient = {
      chainId: 31337,
      addresses: { governor: ADDR.governor as Address, hook: ADDR.hook as Address },
      publicClient: {
        getBlockNumber: async () => 20n,
        getBalance: async () => 7n,
      },
      getTask: async () => ({ charterVersion: 2, charterText: JSON.stringify(CHARTER), charter: CHARTER }),
      getProposalState: async () => 1,
      getProposalVotes: async () => ({ against: 1000000000000000000n, for: 2000000000000000000n, abstain: 0n }),
      listVotes: async () => [
        { voter: ADDR.agent0 as Address, support: 1, reason: "FOR. looks fine" },
        { voter: ADDR.agent1 as Address, support: 0, reason: "AGAINST. too risky" },
      ],
      getProposalCreated: async () => ({ description: "# Grant exception\n\n#proposalTypeId=0" }),
    };

    const state = await buildRunState(
      "run-1",
      baseDeps({
        buildClient: () => fakeClient,
        listProposalIds: async () => [555n],
        listDecisionEvents: async (_client, proposalId) => [
          { type: "ProposalCreated", proposalId: proposalId.toString(), blockNumber: "10", logIndex: 0, txHash: `0x${"cc".repeat(32)}` },
          { type: "VoteCast", proposalId: proposalId.toString(), blockNumber: "12", logIndex: 1, txHash: `0x${"dd".repeat(32)}` },
        ],
      }),
    );

    expect(state.stage).toBe("AGENTS_RUNNING");
    expect(state.experimentName).toBe("run-1");
    expect(state.taskId).toBe("1");
    expect(state.chain.reachable).toBe(true);
    expect(state.charter).toEqual({ source: "chain", version: 2, text: JSON.stringify(CHARTER), parsed: CHARTER });
    expect(state.chainEvents).toEqual([
      { type: "ProposalCreated", proposalId: "555", blockNumber: "10", logIndex: 0, txHash: `0x${"cc".repeat(32)}` },
      { type: "VoteCast", proposalId: "555", blockNumber: "12", logIndex: 1, txHash: `0x${"dd".repeat(32)}` },
    ]);

    expect(state.proposals).toHaveLength(1);
    const proposal = state.proposals[0]!;
    expect(proposal.proposalId).toBe("555");
    expect(proposal.taskId).toBe("1");
    expect(proposal.status).toBe("Active");
    expect(proposal.source).toBe("chain");
    expect(proposal.tally).toEqual({
      forTokens: "2000000000000000000",
      againstTokens: "1000000000000000000",
      abstainTokens: "0",
      forMembers: 1,
      againstMembers: 1,
      abstainMembers: 0,
    });
    expect(proposal.votes).toEqual([
      { voter: ADDR.agent0, agentId: 0, support: 1, reason: "FOR. looks fine" },
      { voter: ADDR.agent1, agentId: 1, support: 0, reason: "AGAINST. too risky" },
    ]);
    expect(proposal.agoraLink).toBe("http://localhost:3000/proposals/555");

    expect(state.agents).toHaveLength(2);
    expect(state.agents[0]).toMatchObject({
      agentId: 0,
      address: ADDR.agent0,
      role: "planner",
      provider: "scripted",
      model: "scripted-v1",
      jobState: "not tracked (no database)",
    });
    expect(state.agents[0]?.lastStep?.why).toBe("reading the readme");
    expect(state.agents[0]?.lastGatewayDecision?.verdict).toBe("ALLOW");
    expect(state.gatewayRecords).toHaveLength(1);
    expect(state.agents[1]?.lastStep).toBeNull();
  }, 15000);

  it("falls back to record.json when the chain client throws", async () => {
    writeJson(path.join(dir, "experiments", "configs", "run-2.json"), experimentConfig("run-2"));
    const record = {
      schema: "fleet.record.v1",
      runId: "run-2",
      config: {},
      configHash: `0x${"aa".repeat(32)}`,
      manifest: manifest(),
      proposals: [{ fixtureName: "hf-replay", taskId: "1", proposalId: "777", outcome: "Defeated", expectedOutcome: "Defeated", pass: true }],
      events: [
        { type: "DecisionProposed", proposalId: "777", kind: "GRANT_EXCEPTION", blockNumber: "10", logIndex: 0, txHash: `0x${"cc".repeat(32)}`, fixtureName: "hf-replay", blockHash: `0x${"dd".repeat(32)}` },
        { type: "ProposalCreated", proposalId: "777", description: "# Grant exception\n\n#proposalTypeId=0", blockNumber: "11", logIndex: 0, txHash: `0x${"cc".repeat(32)}`, fixtureName: "hf-replay", blockHash: `0x${"dd".repeat(32)}` },
      ],
      gatewayLog: [],
      jobs: [],
      votes: [
        { fixtureName: "hf-replay", agentId: 0, voterAddress: ADDR.agent0, proposalId: "777", support: 0, vote: null, onchainReason: "AGAINST. no", jobState: "voted", txHash: null },
      ],
      timings: {},
      fees: [],
      metrics: {},
      versions: {},
    };
    writeJson(path.join(dir, "experiments", "reports", "run-2", "record.json"), record);

    const state = await buildRunState(
      "run-2",
      baseDeps({
        buildClient: () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:9999");
        },
      }),
    );

    expect(state.chain.reachable).toBe(false);
    expect(state.chain.detail).toContain("ECONNREFUSED");
    expect(state.proposals).toHaveLength(1);
    const proposal = state.proposals[0]!;
    expect(proposal.source).toBe("record");
    expect(proposal.proposalId).toBe("777");
    expect(proposal.status).toBe("Defeated");
    expect(proposal.kind).toBe("GRANT_EXCEPTION");
    expect(proposal.rawDescription).toContain("Grant exception");
    expect(proposal.votes).toEqual([{ voter: ADDR.agent0, agentId: 0, support: 0, reason: "AGAINST. no" }]);
    expect(state.chainEvents).toEqual(record.events);
  }, 15000);
});
