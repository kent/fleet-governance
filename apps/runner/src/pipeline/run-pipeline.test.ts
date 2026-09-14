import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExperimentConfigV1, ManifestV1 } from "@fleet/schemas";
import { loadRunKeysFromEnv, manifestPathsForRun, rehydrateRunCtx } from "./run-pipeline.js";
import type { RunPipelineCtx, RunPipelineOptions } from "./run-pipeline.js";
import { MemoryRunStore } from "./state.js";

const KEY = (n: number) => `0x${n.toString().padStart(2, "0").repeat(32)}`;

describe("loadRunKeysFromEnv", () => {
  it("reads one env var per role plus one per agent", () => {
    const env = {
      FLEET_DEPLOYER_KEY: KEY(1),
      FLEET_OPERATOR_KEY: KEY(2),
      FLEET_GUARDIAN_KEY: KEY(3),
      FLEET_KEEPER_KEY: KEY(4),
      FLEET_AGENT_KEY_0: KEY(5),
      FLEET_AGENT_KEY_1: KEY(6),
    };
    const keys = loadRunKeysFromEnv(env, 2);
    expect(keys.deployerKey).toBe(KEY(1));
    expect(keys.operatorKey).toBe(KEY(2));
    expect(keys.guardianKey).toBe(KEY(3));
    expect(keys.keeperKey).toBe(KEY(4));
    expect(keys.agentKeys).toEqual({ 0: KEY(5), 1: KEY(6) });
  });

  it("throws naming the missing variable when an agent key is absent", () => {
    const env = {
      FLEET_DEPLOYER_KEY: KEY(1),
      FLEET_OPERATOR_KEY: KEY(2),
      FLEET_GUARDIAN_KEY: KEY(3),
      FLEET_KEEPER_KEY: KEY(4),
      FLEET_AGENT_KEY_0: KEY(5),
    };
    expect(() => loadRunKeysFromEnv(env, 2)).toThrow(/FLEET_AGENT_KEY_1/);
  });

  it("throws naming the missing variable when a role key is absent", () => {
    const env = { FLEET_OPERATOR_KEY: KEY(2), FLEET_GUARDIAN_KEY: KEY(3), FLEET_KEEPER_KEY: KEY(4) };
    expect(() => loadRunKeysFromEnv(env, 0)).toThrow(/FLEET_DEPLOYER_KEY/);
  });

  it("requests zero agent keys when memberCount is 0", () => {
    const env = {
      FLEET_DEPLOYER_KEY: KEY(1),
      FLEET_OPERATOR_KEY: KEY(2),
      FLEET_GUARDIAN_KEY: KEY(3),
      FLEET_KEEPER_KEY: KEY(4),
    };
    expect(loadRunKeysFromEnv(env, 0).agentKeys).toEqual({});
  });
});

describe("manifestPathsForRun (final review I8)", () => {
  it("writes under deployments/<chainId>/, the path the runbook and bootstrap-local.sh name", () => {
    const paths = manifestPathsForRun("/repo/deployments", 84532, "run-7");
    expect(paths.latest).toBe(path.join("/repo/deployments", "84532", "latest.json"));
    expect(paths.perRun).toBe(path.join("/repo/deployments", "84532", "run-run-7.json"));
  });

  it("uses the same latest.json on Anvil that bootstrap-local.sh writes", () => {
    expect(manifestPathsForRun("/repo/deployments", 31337, "run-1").latest).toBe(
      path.join("/repo/deployments", "31337", "latest.json"),
    );
  });

  it("gives two different runs on one chain different per-run copies", () => {
    const a = manifestPathsForRun("/repo/deployments", 31337, "run-a");
    const b = manifestPathsForRun("/repo/deployments", 31337, "run-b");
    expect(a.latest).toBe(b.latest);
    expect(a.perRun).not.toBe(b.perRun);
  });
});

const MANIFEST = {
  schema: "fleet.manifest.v1",
  chainId: 31337,
  deploymentBlock: 1,
  deploymentTimestamp: 1_700_000_000,
  deployer: "0xf39fd6e51aad88f6f4ce6ab8827279cffdb92266",
  addresses: {
    registry: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
    token: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512",
    timelock: "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0",
    ledger: "0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9",
    hook: "0xfe1bf729317e6eaa74d91b3223964aa6ee0322c1",
    governor: "0x5fc8d32690cc91d4c39d9d3abcbd16989f875707",
  },
  hookSalt: `0x${"00".repeat(32)}`,
  members: [],
  operator: "0x976ea74026e726554db657fa54763abd0c3a0aa9",
  guardian: "0x14dc79964da2c08b23698b3d3cc7ca32193d9955",
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

const EXPERIMENT = {
  schema: "fleet.experiment.v1",
  name: "local-hf-replay",
  target: { kind: "local-anvil", rpcHttp: "http://127.0.0.1:8545", rpcWs: "ws://127.0.0.1:8545" },
  fleet: { members: [{}, {}], tokenName: "Fleet Vote", tokenSymbol: "FLEET" },
} as unknown as ExperimentConfigV1;

const RUN_ENV = {
  FLEET_DEPLOYER_KEY: KEY(1),
  FLEET_OPERATOR_KEY: KEY(2),
  FLEET_GUARDIAN_KEY: KEY(3),
  FLEET_KEEPER_KEY: KEY(4),
  FLEET_AGENT_KEY_0: KEY(5),
  FLEET_AGENT_KEY_1: KEY(6),
};

describe("rehydrateRunCtx (final review I1)", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function makeCtx(deploymentsDir: string): RunPipelineCtx {
    const opts = {
      runId: "run-1",
      experimentPath: "unused.json",
      fixturesDir: "unused",
      contractsDir: "unused",
      configDir: "unused",
      infraDir: "unused",
      abiSourceDir: "unused",
      deploymentsDir,
      reportDir: "unused",
      store: new MemoryRunStore(),
    } satisfies RunPipelineOptions;
    return {
      opts,
      experiment: EXPERIMENT,
      chainId: null,
      manifestOutPath: null,
      manifest: null,
      addresses: null,
      client: null,
      keys: null,
      taskId: null,
      result: null,
      record: null,
      recordPath: null,
      reportPath: null,
    };
  }

  it("rebuilds the manifest, addresses, client, keys and taskId a TASK_OPENED checkpoint implies", () => {
    dir = mkdtempSync(path.join(tmpdir(), "fleet-rehydrate-"));
    const manifestPath = manifestPathsForRun(dir, 31337, "run-1").latest;
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(MANIFEST), "utf8");

    const rehydrated = rehydrateRunCtx(
      makeCtx(dir),
      { chainId: 31337, manifestOutPath: manifestPath, manifestChainId: 31337, taskId: "4" },
      RUN_ENV,
    );

    expect(rehydrated.chainId).toBe(31337);
    expect(rehydrated.manifestOutPath).toBe(manifestPath);
    expect(rehydrated.manifest?.addresses.governor).toBe(MANIFEST.addresses.governor);
    expect(rehydrated.addresses?.ledger).toBe(MANIFEST.addresses.ledger);
    expect(rehydrated.client?.chainId).toBe(31337);
    expect(rehydrated.taskId).toBe(4n);
    expect(rehydrated.keys?.deployerKey).toBe(KEY(1));
  });

  it("derives the manifest path from the chain id when the payload predates that field", () => {
    dir = mkdtempSync(path.join(tmpdir(), "fleet-rehydrate-"));
    const manifestPath = manifestPathsForRun(dir, 31337, "run-1").latest;
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(MANIFEST), "utf8");

    const rehydrated = rehydrateRunCtx(makeCtx(dir), { chainId: 31337, taskId: null }, RUN_ENV);
    expect(rehydrated.manifestOutPath).toBe(manifestPath);
    expect(rehydrated.manifest).not.toBeNull();
    expect(rehydrated.taskId).toBeNull();
  });

  it("leaves the manifest null when the checkpoint is from before DEPLOYED", () => {
    dir = mkdtempSync(path.join(tmpdir(), "fleet-rehydrate-"));
    const rehydrated = rehydrateRunCtx(makeCtx(dir), { chainId: 31337, taskId: null }, RUN_ENV);
    expect(rehydrated.manifest).toBeNull();
    expect(rehydrated.client).toBeNull();
    // Keys are always re-read from the environment: they never round trip through a checkpoint.
    expect(rehydrated.keys?.keeperKey).toBe(KEY(4));
  });
});
