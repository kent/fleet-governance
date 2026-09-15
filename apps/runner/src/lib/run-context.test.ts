import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveRunContext } from "./run-context.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fleet-run-context-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function validExperiment(name: string) {
  return {
    schema: "fleet.experiment.v1",
    name,
    target: { kind: "local-anvil", rpcHttp: "http://127.0.0.1:8545", rpcWs: "ws://127.0.0.1:8545" },
    fleet: {
      members: [
        { role: "a", provider: "scripted", model: "m", promptVersion: "1", operatorLabel: "local" },
        { role: "b", provider: "scripted", model: "m", promptVersion: "1", operatorLabel: "local" },
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

function fakeManifest(deployer: string) {
  return {
    schema: "fleet.manifest.v1",
    chainId: 31337,
    deploymentBlock: 1,
    deploymentTimestamp: 1,
    deployer,
    addresses: {
      registry: "0x1000000000000000000000000000000000000001",
      token: "0x1000000000000000000000000000000000000002",
      timelock: "0x1000000000000000000000000000000000000003",
      ledger: "0x1000000000000000000000000000000000000004",
      hook: "0x1000000000000000000000000000000000000005",
      governor: "0x1000000000000000000000000000000000000006",
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

describe("resolveRunContext", () => {
  it("resolves nothing for a run with no files written yet", async () => {
    const ctx = await resolveRunContext("run-none", dir, undefined);
    expect(ctx.uiRow).toBeNull();
    expect(ctx.experiment).toBeNull();
    expect(ctx.deployConfig).toBeNull();
    expect(ctx.record).toBeNull();
    expect(ctx.manifest).toBeNull();
    expect(ctx.runDir).toBe(path.join(dir, "experiments", "reports", "run-none"));
  });

  it("finds the experiment config at the conventional path when there is no ui_runs row", async () => {
    const experiment = { schema: "fleet.experiment.v1", name: "run-conv" };
    writeJson(path.join(dir, "experiments", "configs", "run-conv.json"), experiment);
    const ctx = await resolveRunContext("run-conv", dir, undefined);
    // ExperimentConfigV1.safeParse will fail on this minimal stub (missing required fields), so
    // this asserts the *path* resolution only, not full schema validity.
    expect(ctx.experiment).toBeNull();
  });

  it("prefers the ui_runs row's recorded experimentPath over the conventional path", async () => {
    const customPath = path.join(dir, "somewhere-else", "custom.json");
    writeJson(customPath, {
      schema: "fleet.experiment.v1",
      name: "run-ui",
      target: { kind: "local-anvil", rpcHttp: "http://127.0.0.1:8545", rpcWs: "ws://127.0.0.1:8545" },
      fleet: {
        members: [
          { role: "a", provider: "scripted", model: "m", promptVersion: "1", operatorLabel: "local" },
          { role: "b", provider: "scripted", model: "m", promptVersion: "1", operatorLabel: "local" },
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
    });
    writeJson(path.join(dir, "experiments", "reports", "ui-runs.json"), [
      {
        runId: "run-ui",
        experimentPath: customPath,
        deployConfigPath: path.join(dir, "somewhere-else", "custom.deploy.json"),
        logPath: path.join(dir, "experiments", "reports", "run-ui", "run.log"),
        pid: 1,
        readSide: false,
        createdAt: "2026-09-14T00:00:00.000Z",
      },
    ]);

    const ctx = await resolveRunContext("run-ui", dir, undefined);
    expect(ctx.uiRow?.experimentPath).toBe(customPath);
    expect(ctx.experiment?.name).toBe("run-ui");
  });

  // Fix round 1, F6: `fleet run` writes `deployments/<chainId>/run-<runId>.json` and
  // `deployments/<chainId>/latest.json`, derived from the experiment's own `target.kind`, not the
  // old fixed `deployments/experiment-latest.json` (which `fleet run` no longer writes at all).
  it("does not assign another run's latest deployment to an experiment that has not deployed", async () => {
    writeJson(path.join(dir, "experiments", "configs", "run-live.json"), validExperiment("run-live"));
    writeJson(path.join(dir, "deployments", "31337", "latest.json"), fakeManifest("0x1000000000000000000000000000000000000009"));

    const ctx = await resolveRunContext("run-live", dir, undefined);
    expect(ctx.record).toBeNull();
    expect(ctx.manifest).toBeNull();
  });

  it("prefers the per-run manifest copy over latest.json when both exist", async () => {
    writeJson(path.join(dir, "experiments", "configs", "run-live2.json"), validExperiment("run-live2"));
    writeJson(path.join(dir, "deployments", "31337", "latest.json"), fakeManifest("0x100000000000000000000000000000000000dead"));
    writeJson(path.join(dir, "deployments", "31337", "run-run-live2.json"), fakeManifest("0x100000000000000000000000000000000000beef"));

    const ctx = await resolveRunContext("run-live2", dir, undefined);
    expect(ctx.manifest?.deployer).toBe("0x100000000000000000000000000000000000beef");
  });

  it("returns no manifest when neither the per-run copy nor latest.json exists yet", async () => {
    writeJson(path.join(dir, "experiments", "configs", "run-live3.json"), validExperiment("run-live3"));
    const ctx = await resolveRunContext("run-live3", dir, undefined);
    expect(ctx.manifest).toBeNull();
  });

  // Fix round 1, F1: defense in depth beyond every route's own `parseRunId` gate. A route already
  // rejects these before ever calling `resolveRunContext`; this proves the library itself refuses
  // too, for any caller that skips the route.
  it.each(["..", "../../etc/passwd", "a/b", "a%2fb", ""])("throws rather than resolving a path for the invalid id %j", async (badId) => {
    await expect(resolveRunContext(badId, dir, undefined)).rejects.toThrow("invalid run id");
  });
});
