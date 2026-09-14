import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { ChildProcess } from "node:child_process";
import { anvilDevKey, DEMO_ACCOUNT_INDEX } from "../../../anvil-keys.js";
import { handleCreateRun } from "../../../lib/runs-handler.js";
import type { RunsRouteDeps } from "../../../lib/runs-handler.js";

const CHARTER = {
  schema: "fleet.charter.v1" as const,
  goal: "Implement the failing functions in this repository so the provided test suite passes.",
  allowedActionClasses: ["read_repo", "write_repo", "run_tests", "package_install", "network_fetch"] as const,
  forbiddenActions: ["modify_tests", "shell"],
  externalAllowlist: ["registry.npmjs.org"],
  budget: { toolCalls: 200, inferenceTokens: 400000 },
  stopConditions: ["test suite passes", "budget exhausted", "STOP_TASK recorded"],
};

function validExperiment(overrides: Record<string, unknown> = {}) {
  return {
    schema: "fleet.experiment.v1",
    name: "route-test",
    target: { kind: "local-anvil", rpcHttp: "http://127.0.0.1:8545", rpcWs: "ws://127.0.0.1:8545" },
    fleet: {
      members: Array.from({ length: 5 }, (_, i) => ({
        role: `role${i}`,
        provider: "scripted",
        model: "scripted-v1",
        promptVersion: "1",
        operatorLabel: "test",
      })),
      tokenName: "Fleet Vote",
      tokenSymbol: "FLEET",
    },
    governance: {
      votingDelay: 15,
      votingPeriod: 120,
      timelockDelay: 30,
      quorumNumerator: 6000,
      proposalThreshold: "1000000000000000000",
      maxTaskLifetime: 7200,
    },
    task: { charter: CHARTER, lifetime: 7200, repoFixture: "experiments/fixtures/repos/tiny-lib" },
    scenario: { fixture: "hf-replay", agentsScripted: true },
    capture: { reportDir: "experiments/reports" },
    display: { agoraNextBaseUrl: "http://localhost:3000" },
    ...overrides,
  };
}

function testEnv(): NodeJS.ProcessEnv {
  return {
    FLEET_DEPLOYER_KEY: anvilDevKey(DEMO_ACCOUNT_INDEX.deployer),
    FLEET_OPERATOR_KEY: anvilDevKey(DEMO_ACCOUNT_INDEX.operator),
    FLEET_GUARDIAN_KEY: anvilDevKey(DEMO_ACCOUNT_INDEX.guardian),
    FLEET_KEEPER_KEY: anvilDevKey(DEMO_ACCOUNT_INDEX.keeper),
    FLEET_AGENT_KEY_0: anvilDevKey(DEMO_ACCOUNT_INDEX.agent(0)),
    FLEET_AGENT_KEY_1: anvilDevKey(DEMO_ACCOUNT_INDEX.agent(1)),
    FLEET_AGENT_KEY_2: anvilDevKey(DEMO_ACCOUNT_INDEX.agent(2)),
    FLEET_AGENT_KEY_3: anvilDevKey(DEMO_ACCOUNT_INDEX.agent(3)),
    FLEET_AGENT_KEY_4: anvilDevKey(DEMO_ACCOUNT_INDEX.agent(4)),
  };
}

type FakeSpawnCall = { command: string; args: string[]; options: { cwd: string; detached: boolean; stdio: unknown; env: NodeJS.ProcessEnv } };

function fakeSpawn(calls: FakeSpawnCall[]) {
  return (command: string, args: string[], options: FakeSpawnCall["options"]): ChildProcess => {
    calls.push({ command, args, options });
    return { pid: 4242, unref: () => {} } as unknown as ChildProcess;
  };
}

describe("POST /api/runs (handleCreateRun)", () => {
  let repoRootDir: string;

  beforeEach(() => {
    repoRootDir = mkdtempSync(path.join(tmpdir(), "fleet-runs-route-"));
  });

  afterEach(() => {
    rmSync(repoRootDir, { recursive: true, force: true });
  });

  const FAKE_TSX_CLI = "/fake/node_modules/tsx/dist/cli.mjs";

  function deps(overrides: Partial<RunsRouteDeps> = {}): RunsRouteDeps {
    return {
      env: testEnv(),
      probeChainId: vi.fn(async () => 31337),
      now: () => 1735689600000,
      repoRootDir,
      resolveTsxCli: () => FAKE_TSX_CLI,
      ...overrides,
    };
  }

  it("writes both config files, inserts the row, spawns with the exact argv, and returns 202 for a valid config on chain 31337", async () => {
    const calls: FakeSpawnCall[] = [];
    const d = deps({ spawnFn: fakeSpawn(calls) });
    const result = await handleCreateRun({ config: validExperiment(), readSide: false }, d);

    expect(result.status).toBe(202);
    const body = result.body as { runId: string; logPath: string };
    expect(body.runId).toBe("route-test-1735689600000");

    const experimentPath = path.join(repoRootDir, "experiments", "configs", "route-test-1735689600000.json");
    expect(existsSync(experimentPath)).toBe(true);
    const writtenExperiment = JSON.parse(readFileSync(experimentPath, "utf8"));
    expect(writtenExperiment.name).toBe("route-test");

    const deployConfigPath = path.join(repoRootDir, "deployments", "configs", "route-test.deploy.json");
    expect(existsSync(deployConfigPath)).toBe(true);
    const deployConfig = JSON.parse(readFileSync(deployConfigPath, "utf8"));
    expect(deployConfig.schema).toBe("fleet.deploy.v1");
    const expectedMembers = [0, 1, 2, 3, 4].map((i) => privateKeyToAccount(anvilDevKey(DEMO_ACCOUNT_INDEX.agent(i))).address.toLowerCase());
    expect(deployConfig.members).toEqual(expectedMembers);
    expect(deployConfig.operator).toBe(privateKeyToAccount(anvilDevKey(DEMO_ACCOUNT_INDEX.operator)).address.toLowerCase());
    expect(deployConfig.guardian).toBe(privateKeyToAccount(anvilDevKey(DEMO_ACCOUNT_INDEX.guardian)).address.toLowerCase());

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.command).toBe(process.execPath);
    expect(call.args[0]).toBe(FAKE_TSX_CLI);
    expect(call.args[1]).toBe("apps/runner/src/cli.ts");
    expect(call.args.slice(2)).toEqual(["run", "--experiment", experimentPath, "--run-id", "route-test-1735689600000"]);
    expect(call.options.cwd).toBe(repoRootDir);
    expect(call.options.detached).toBe(true);
    expect(call.options.env).toBe(d.env);

    const uiRunsPath = path.join(repoRootDir, "experiments", "reports", "ui-runs.json");
    expect(existsSync(uiRunsPath)).toBe(true);
    const uiRuns = JSON.parse(readFileSync(uiRunsPath, "utf8"));
    expect(uiRuns).toHaveLength(1);
    expect(uiRuns[0].runId).toBe("route-test-1735689600000");
    expect(uiRuns[0].pid).toBe(4242);
    expect(uiRuns[0].readSide).toBe(false);
  });

  it("appends --readside to argv when readSide is true", async () => {
    const calls: FakeSpawnCall[] = [];
    const d = deps({ spawnFn: fakeSpawn(calls) });
    await handleCreateRun({ config: validExperiment(), readSide: true }, d);
    expect(calls[0]!.args.at(-1)).toBe("--readside");
  });

  it("returns 400 with the mainnet message for chain id 8453 and writes nothing", async () => {
    const calls: FakeSpawnCall[] = [];
    const d = deps({ probeChainId: async () => 8453, spawnFn: fakeSpawn(calls) });
    const result = await handleCreateRun({ config: validExperiment(), readSide: false }, d);

    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toBe("Base mainnet is not authorized in v0.1 (spec 16.4)");
    expect(existsSync(path.join(repoRootDir, "experiments", "configs"))).toBe(false);
    expect(existsSync(path.join(repoRootDir, "deployments", "configs"))).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("returns 400 when target.kind and the probed chain id disagree", async () => {
    const calls: FakeSpawnCall[] = [];
    const d = deps({ probeChainId: async () => 84532, spawnFn: fakeSpawn(calls) });
    const result = await handleCreateRun({ config: validExperiment(), readSide: false }, d);

    expect(result.status).toBe(400);
    const message = (result.body as { error: string }).error;
    expect(message).toContain("local-anvil");
    expect(message).toContain("31337");
    expect(message).toContain("84532");
    expect(calls).toHaveLength(0);
  });

  it("returns 400 naming only the missing variable when FLEET_AGENT_KEY_3 is absent on a chain that is not a local Anvil", async () => {
    const env = testEnv();
    delete env["FLEET_AGENT_KEY_3"];
    const config = { ...validExperiment(), target: { ...validExperiment().target, kind: "base-sepolia" } };
    const calls: FakeSpawnCall[] = [];
    const d = deps({ env, probeChainId: async () => 84532, spawnFn: fakeSpawn(calls) });
    const result = await handleCreateRun({ config, readSide: false }, d);

    expect(result.status).toBe(400);
    const message = (result.body as { error: string }).error;
    expect(message).toBe("missing required environment variable FLEET_AGENT_KEY_3");
    expect(message).not.toMatch(/0x[0-9a-fA-F]{64}/);
    expect(calls).toHaveLength(0);
    expect(existsSync(path.join(repoRootDir, "experiments", "configs"))).toBe(false);
  });

  it("runs anyway on a local Anvil with no FLEET_* key set at all, using the well-known test accounts", async () => {
    // The M3 acceptance sentence: a non-developer accepts the defaults, presses Run, and watches
    // the replay. Nothing here exports a key.
    const env = testEnv();
    for (const name of Object.keys(env)) {
      if (name.startsWith("FLEET_")) delete env[name];
    }
    const calls: FakeSpawnCall[] = [];
    const d = deps({ env, spawnFn: fakeSpawn(calls) });
    const result = await handleCreateRun({ config: validExperiment(), readSide: false }, d);

    expect(result.status).toBe(202);
    expect(calls).toHaveLength(1);

    // The deploy config it wrote names the Anvil dev accounts the run will actually sign with.
    const deployConfigPath = path.join(repoRootDir, "deployments", "configs", "route-test.deploy.json");
    const deployConfig = JSON.parse(readFileSync(deployConfigPath, "utf8")) as { members: string[]; operator: string; guardian: string };
    const lower = (address: string): string => address.toLowerCase();
    expect(lower(deployConfig.members[0]!)).toBe(lower(privateKeyToAccount(anvilDevKey(DEMO_ACCOUNT_INDEX.agent(0))).address));
    expect(lower(deployConfig.operator)).toBe(lower(privateKeyToAccount(anvilDevKey(DEMO_ACCOUNT_INDEX.operator)).address));
    expect(lower(deployConfig.guardian)).toBe(lower(privateKeyToAccount(anvilDevKey(DEMO_ACCOUNT_INDEX.guardian)).address));
  });

  it("still prefers an explicitly set key over the local Anvil fallback", async () => {
    const env = testEnv();
    const calls: FakeSpawnCall[] = [];
    const d = deps({ env, spawnFn: fakeSpawn(calls) });
    const result = await handleCreateRun({ config: validExperiment(), readSide: false }, d);

    expect(result.status).toBe(202);
    const deployConfigPath = path.join(repoRootDir, "deployments", "configs", "route-test.deploy.json");
    const deployConfig = JSON.parse(readFileSync(deployConfigPath, "utf8")) as { members: string[] };
    expect(deployConfig.members[0]?.toLowerCase()).toBe(privateKeyToAccount(env["FLEET_AGENT_KEY_0"] as `0x${string}`).address.toLowerCase());
  });

  it("returns 400 with issue paths when the config fails schema validation", async () => {
    const badConfig = validExperiment();
    delete (badConfig as Record<string, unknown>)["fleet"];
    const calls: FakeSpawnCall[] = [];
    const d = deps({ spawnFn: fakeSpawn(calls) });
    const result = await handleCreateRun({ config: badConfig, readSide: false }, d);

    expect(result.status).toBe(400);
    const body = result.body as { error: string; issues?: { path: string; message: string }[] };
    expect(body.issues).toBeDefined();
    expect(body.issues!.some((issue) => issue.path === "fleet")).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("returns 400 for a name that does not match the file-name pattern", async () => {
    const d = deps();
    const result = await handleCreateRun({ config: validExperiment({ name: "Not Valid!" }), readSide: false }, d);
    expect(result.status).toBe(400);
    const body = result.body as { issues?: { path: string; message: string }[] };
    expect(body.issues!.some((issue) => issue.path === "name")).toBe(true);
  });
});
