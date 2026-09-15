import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { handleGuardianAction } from "./guardian-route.js";
import type { GuardianRouteDeps } from "./guardian-route.js";
import type { GuardianChainClient, GuardianWallet } from "../guardian.js";
import { anvilDevKey, DEMO_ACCOUNT_INDEX } from "../anvil-keys.js";

let dir: string;
const RUN_ID = "run-guardian-1";
const GUARDIAN_KEY = anvilDevKey(DEMO_ACCOUNT_INDEX.guardian);

const ADDR = {
  ledger: "0x1000000000000000000000000000000000000004",
  timelock: "0x1000000000000000000000000000000000000003",
  governor: "0x1000000000000000000000000000000000000006",
};

function experimentConfig() {
  return {
    schema: "fleet.experiment.v1",
    name: RUN_ID,
    target: { kind: "local-anvil", rpcHttp: "http://127.0.0.1:9999", rpcWs: "ws://127.0.0.1:9999" },
    fleet: {
      members: [
        { role: "planner", provider: "scripted", model: "m", promptVersion: "1", operatorLabel: "local" },
        { role: "engineer", provider: "scripted", model: "m", promptVersion: "1", operatorLabel: "local" },
      ],
      tokenName: "Fleet Vote",
      tokenSymbol: "FLEET",
    },
    governance: { votingDelay: 1, votingPeriod: 1, timelockDelay: 1, quorumNumerator: 6000, proposalThreshold: "0", maxTaskLifetime: 1 },
    task: {
      charter: {
        schema: "fleet.charter.v1",
        goal: "g",
        allowedActionClasses: ["read_repo"],
        forbiddenActions: [],
        externalAllowlist: [],
        budget: { toolCalls: 1, inferenceTokens: 1 },
        stopConditions: [],
      },
      lifetime: 1,
      repoFixture: "x",
    },
    scenario: { fixture: "hf-replay", agentsScripted: true },
    capture: { reportDir: "experiments/reports" },
    display: {},
  };
}

function manifest() {
  return {
    schema: "fleet.manifest.v1",
    chainId: 31337,
    deploymentBlock: 1,
    deploymentTimestamp: 1,
    deployer: "0x1000000000000000000000000000000000000009",
    addresses: {
      registry: "0x1000000000000000000000000000000000000001",
      token: "0x1000000000000000000000000000000000000002",
      timelock: ADDR.timelock,
      ledger: ADDR.ledger,
      hook: "0x1000000000000000000000000000000000000005",
      governor: ADDR.governor,
    },
    hookSalt: `0x${"11".repeat(32)}`,
    members: ["0x100000000000000000000000000000000000000a"],
    operator: "0x100000000000000000000000000000000000000b",
    guardian: "0x100000000000000000000000000000000000000c",
    tokenName: "Fleet Vote",
    tokenSymbol: "FLEET",
    configPath: "deployments/configs/x.json",
    params: { votingDelay: 1, votingPeriod: 1, proposalThreshold: "0", quorumNumerator: 6000, timelockDelay: 1, maxTaskLifetime: 1 },
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

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fleet-guardian-route-"));
  writeJson(path.join(dir, "experiments", "configs", `${RUN_ID}.json`), experimentConfig());
  // Guardian actions must use the requested run's own deployment copy.
  writeJson(path.join(dir, "deployments", "31337", `run-${RUN_ID}.json`), manifest());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeChainClient(): GuardianChainClient {
  return {
    addresses: { ledger: ADDR.ledger, timelock: ADDR.timelock, governor: ADDR.governor } as never,
    getProposalCreated: vi.fn(async () => ({
      targets: [ADDR.ledger] as never,
      values: [0n],
      calldatas: ["0xabc"] as never,
      description: "# Grant exception\n\n#proposalTypeId=0",
    })),
    publicClient: {
      readContract: vi.fn(async () => "0xoperationid" as Hex),
      waitForTransactionReceipt: vi.fn(async () => ({ blockNumber: 42n })),
    },
  };
}

function fakeWallet(txHash: Hex): { wallet: GuardianWallet; writeContract: ReturnType<typeof vi.fn> } {
  const writeContract = vi.fn(async () => txHash);
  return { wallet: { writeContract }, writeContract };
}

function baseDeps(overrides: Partial<GuardianRouteDeps> = {}): GuardianRouteDeps {
  return {
    repoRootDir: dir,
    env: { FLEET_GUARDIAN_KEY: GUARDIAN_KEY },
    now: () => new Date("2026-09-14T12:00:00.000Z"),
    buildClient: () => fakeChainClient(),
    buildWallet: () => fakeWallet("0xdddddddddddddddd" as Hex).wallet,
    ...overrides,
  };
}

function interventionsPath(): string {
  return path.join(dir, "experiments", "reports", RUN_ID, "interventions.jsonl");
}

describe("handleGuardianAction", () => {
  it("refuses when FLEET_GUARDIAN_KEY is not set, naming only the variable", async () => {
    const result = await handleGuardianAction(RUN_ID, { action: "pause" }, baseDeps({ env: {} }));
    expect(result.status).toBe(400);
    expect(result.body["error"]).toBe("missing required environment variable FLEET_GUARDIAN_KEY");
  });

  it("refuses a malformed FLEET_GUARDIAN_KEY without ever echoing it", async () => {
    const result = await handleGuardianAction(RUN_ID, { action: "pause" }, baseDeps({ env: { FLEET_GUARDIAN_KEY: "not-a-key" } }));
    expect(result.status).toBe(400);
    expect(String(result.body["error"])).not.toContain("not-a-key");
  });

  it("refuses an unknown action", async () => {
    const result = await handleGuardianAction(RUN_ID, { action: "nuke" }, baseDeps());
    expect(result.status).toBe(400);
  });

  it("refuses cancel without a proposalId", async () => {
    const result = await handleGuardianAction(RUN_ID, { action: "cancel" }, baseDeps());
    expect(result.status).toBe(400);
    expect(result.body["error"]).toContain("proposalId");
  });

  it("pauses TaskLedger and appends a pause intervention line", async () => {
    const { wallet, writeContract } = fakeWallet("0xaaaaaaaaaaaaaaaa" as Hex);
    const result = await handleGuardianAction(RUN_ID, { action: "pause" }, baseDeps({ buildWallet: () => wallet }));

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, action: "pause", txHash: "0xaaaaaaaaaaaaaaaa", blockNumber: "42" });
    expect(writeContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "pause" }));

    const lines = readFileSync(interventionsPath(), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      type: "human_intervention",
      at: "2026-09-14T12:00:00.000Z",
      action: "pause",
      proposalId: null,
      txHash: "0xaaaaaaaaaaaaaaaa",
      blockNumber: "42",
      actor: "guardian",
    });
  });

  it("cancels a proposal, computing the operation id, and records the proposalId in the intervention line", async () => {
    const { wallet, writeContract } = fakeWallet("0xbbbbbbbbbbbbbbbb" as Hex);
    const result = await handleGuardianAction(RUN_ID, { action: "cancel", proposalId: "555" }, baseDeps({ buildWallet: () => wallet }));

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, action: "cancel", txHash: "0xbbbbbbbbbbbbbbbb", operationId: "0xoperationid" });
    expect(writeContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "cancel", args: ["0xoperationid"] }));

    const lines = readFileSync(interventionsPath(), "utf8").trim().split("\n");
    const line = JSON.parse(lines[0]!);
    expect(line.action).toBe("cancel");
    expect(line.proposalId).toBe("555");
  });

  it("reports an error and writes nothing when there is no deployment manifest for the run", async () => {
    rmSync(path.join(dir, "deployments", "31337", `run-${RUN_ID}.json`));
    writeJson(path.join(dir, "deployments", "31337", "latest.json"), manifest());
    const result = await handleGuardianAction(RUN_ID, { action: "pause" }, baseDeps());
    expect(result.status).toBe(400);
    expect(String(result.body["error"])).toContain("no deployment manifest found");
  });
});
