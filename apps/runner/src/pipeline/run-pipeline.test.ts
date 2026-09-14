import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ExperimentConfigV1, ManifestV1 } from "@fleet/schemas";
import {
  LOCAL_ANVIL_CHAIN_ID,
  experimentConfigHash,
  loadRunKeysFromEnv,
  manifestPathsForRun,
  readCaptureReportDir,
  rehydrateRunCtx,
  resolveReportDir,
} from "./run-pipeline.js";
import { anvilDevKey, DEMO_ACCOUNT_INDEX } from "../anvil-keys.js";
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
      repoRoot: "unused",
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
      timings: {},
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

  it("re-reads record.json off disk so a resume past AGENTS_RUNNING can reach CAPTURED and REPORTED (fix-wave finding 1)", () => {
    dir = mkdtempSync(path.join(tmpdir(), "fleet-rehydrate-"));
    const reportDir = path.join(dir, "reports");
    const recordPath = path.join(reportDir, "run-1", "record.json");
    mkdirSync(path.dirname(recordPath), { recursive: true });
    writeFileSync(recordPath, JSON.stringify({ schema: "fleet.record.v1", runId: "run-1", proposals: [] }), "utf8");

    const base = makeCtx(dir);
    const ctx = { ...base, opts: { ...base.opts, reportDir } };
    const rehydrated = rehydrateRunCtx(ctx, { chainId: 31337, taskId: null, recordPath, reportPath: path.join(reportDir, "run-1", "report.md") }, RUN_ENV);

    expect(rehydrated.recordPath).toBe(recordPath);
    expect(rehydrated.record?.runId).toBe("run-1");
    expect(rehydrated.reportPath).toBe(path.join(reportDir, "run-1", "report.md"));
  });

  it("leaves record and recordPath null when no record has been written yet", () => {
    dir = mkdtempSync(path.join(tmpdir(), "fleet-rehydrate-"));
    const base = makeCtx(dir);
    const ctx = { ...base, opts: { ...base.opts, reportDir: path.join(dir, "reports") } };
    const rehydrated = rehydrateRunCtx(ctx, { chainId: 31337, taskId: null }, RUN_ENV);
    expect(rehydrated.record).toBeNull();
    expect(rehydrated.recordPath).toBeNull();
    expect(rehydrated.reportPath).toBeNull();
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

describe("experimentConfigHash (final review I3)", () => {
  const base = {
    schema: "fleet.experiment.v1",
    name: "local-hf-replay",
    task: { charter: { goal: "make the tests pass", budget: { toolCalls: 200 } }, lifetime: 3600 },
    scenario: { fixture: "hf-replay" },
  };

  it("changes when anything in the config changes, not just the name", () => {
    const differentCharter = { ...base, task: { ...base.task, charter: { ...base.task.charter, goal: "do something else" } } };
    const differentBudget = { ...base, task: { ...base.task, charter: { ...base.task.charter, budget: { toolCalls: 5 } } } };
    const differentFixture = { ...base, scenario: { fixture: "legit-amendment" } };

    expect(experimentConfigHash(differentCharter)).not.toBe(experimentConfigHash(base));
    expect(experimentConfigHash(differentBudget)).not.toBe(experimentConfigHash(base));
    expect(experimentConfigHash(differentFixture)).not.toBe(experimentConfigHash(base));
  });

  it("is the same for the same config whatever order its keys were written in", () => {
    const reordered = {
      scenario: { fixture: "hf-replay" },
      task: { lifetime: 3600, charter: { budget: { toolCalls: 200 }, goal: "make the tests pass" } },
      name: "local-hf-replay",
      schema: "fleet.experiment.v1",
    };
    expect(experimentConfigHash(reordered)).toBe(experimentConfigHash(base));
  });

  it("is not the old schema-and-name-only hash", () => {
    // The exact regression: hashing only {schema, name} made every config with this name equal.
    const schemaAndNameOnly = { schema: base.schema, name: base.name };
    expect(experimentConfigHash(base)).not.toBe(experimentConfigHash(schemaAndNameOnly));
  });
});


describe("loadRunKeysFromEnv: the local-Anvil fallback", () => {
  const BASE_SEPOLIA = 84532;

  it("resolves every role to its well-known Anvil dev account when nothing is set and the chain is Anvil", () => {
    const keys = loadRunKeysFromEnv({}, 3, { chainId: LOCAL_ANVIL_CHAIN_ID });

    expect(keys.deployerKey).toBe(anvilDevKey(DEMO_ACCOUNT_INDEX.deployer));
    expect(keys.operatorKey).toBe(anvilDevKey(DEMO_ACCOUNT_INDEX.operator));
    expect(keys.guardianKey).toBe(anvilDevKey(DEMO_ACCOUNT_INDEX.guardian));
    expect(keys.keeperKey).toBe(anvilDevKey(DEMO_ACCOUNT_INDEX.keeper));
    expect(keys.agentKeys).toEqual({
      0: anvilDevKey(DEMO_ACCOUNT_INDEX.agent(0)),
      1: anvilDevKey(DEMO_ACCOUNT_INDEX.agent(1)),
      2: anvilDevKey(DEMO_ACCOUNT_INDEX.agent(2)),
    });
  });

  it("logs one line per fallback, naming the variable and the role and no key material", () => {
    const lines: string[] = [];
    const keys = loadRunKeysFromEnv({}, 1, { chainId: LOCAL_ANVIL_CHAIN_ID, log: (m) => lines.push(m) });

    expect(lines.length).toBe(5);
    expect(lines.some((l) => l.includes("FLEET_DEPLOYER_KEY") && l.includes("deployer"))).toBe(true);
    expect(lines.some((l) => l.includes("FLEET_AGENT_KEY_0") && l.includes("agent 0"))).toBe(true);
    for (const line of lines) {
      expect(line).not.toContain("0x");
      expect(line).toContain("public");
    }
    // and nothing in the log is any of the keys it resolved
    const material = [keys.deployerKey, keys.operatorKey, keys.guardianKey, keys.keeperKey, keys.agentKeys[0]!];
    for (const key of material) expect(lines.join("\n")).not.toContain(key);
  });

  it("lets an explicitly set variable win over the fallback", () => {
    const keys = loadRunKeysFromEnv({ FLEET_OPERATOR_KEY: KEY(9) }, 1, { chainId: LOCAL_ANVIL_CHAIN_ID });

    expect(keys.operatorKey).toBe(KEY(9));
    expect(keys.deployerKey).toBe(anvilDevKey(DEMO_ACCOUNT_INDEX.deployer));
  });

  it("treats an empty string as unset, so an exported-but-blank variable still falls back", () => {
    const keys = loadRunKeysFromEnv({ FLEET_KEEPER_KEY: "   " }, 0, { chainId: LOCAL_ANVIL_CHAIN_ID });
    expect(keys.keeperKey).toBe(anvilDevKey(DEMO_ACCOUNT_INDEX.keeper));
  });

  it("refuses the fallback on any other chain, naming the missing variable", () => {
    expect(() => loadRunKeysFromEnv({}, 1, { chainId: BASE_SEPOLIA })).toThrow(/FLEET_DEPLOYER_KEY/);
    expect(() =>
      loadRunKeysFromEnv(
        {
          FLEET_DEPLOYER_KEY: KEY(1),
          FLEET_OPERATOR_KEY: KEY(2),
          FLEET_GUARDIAN_KEY: KEY(3),
          FLEET_KEEPER_KEY: KEY(4),
        },
        1,
        { chainId: BASE_SEPOLIA },
      ),
    ).toThrow(/FLEET_AGENT_KEY_0/);
  });

  it("refuses the fallback when the chain id could not be read at all", () => {
    expect(() => loadRunKeysFromEnv({}, 1, { chainId: null })).toThrow(/FLEET_DEPLOYER_KEY/);
    expect(() => loadRunKeysFromEnv({}, 1)).toThrow(/FLEET_DEPLOYER_KEY/);
  });
});

describe("resolveReportDir (fix-wave finding 4: capture.reportDir is no longer dead config)", () => {
  it("prefers an explicit --report-dir over everything", () => {
    expect(resolveReportDir({ explicit: "/tmp/explicit", captureReportDir: "experiments/reports", repoRoot: "/repo", fallback: "/fallback" })).toBe(
      path.resolve("/tmp/explicit"),
    );
  });

  it("uses the experiment's capture.reportDir, resolved against the repository root, when no flag is given", () => {
    expect(resolveReportDir({ captureReportDir: "experiments/reports", repoRoot: "/repo", fallback: "/fallback" })).toBe(
      path.join("/repo", "experiments", "reports"),
    );
  });

  it("keeps an absolute capture.reportDir as it is", () => {
    expect(resolveReportDir({ captureReportDir: "/var/fleet-reports", repoRoot: "/repo", fallback: "/fallback" })).toBe("/var/fleet-reports");
  });

  it("falls back to the CLI default when the config names nothing usable", () => {
    expect(resolveReportDir({ repoRoot: "/repo", fallback: "/fallback" })).toBe("/fallback");
    expect(resolveReportDir({ captureReportDir: "   ", repoRoot: "/repo", fallback: "/fallback" })).toBe("/fallback");
  });
});

describe("readCaptureReportDir", () => {
  it("reads capture.reportDir out of a valid experiment config", () => {
    const repoRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
    const committed = path.join(repoRootDir, "experiments", "examples", "local-hf-replay.experiment.json");
    expect(readCaptureReportDir(committed)).toBe("experiments/reports");

    const dir = mkdtempSync(path.join(tmpdir(), "fleet-capture-dir-"));
    try {
      const edited = JSON.parse(readFileSync(committed, "utf8")) as { capture: { reportDir: string } };
      edited.capture.reportDir = "my/reports";
      const file = path.join(dir, "e.json");
      writeFileSync(file, JSON.stringify(edited), "utf8");
      expect(readCaptureReportDir(file)).toBe("my/reports");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined for a file that does not exist or does not parse, rather than throwing", () => {
    expect(readCaptureReportDir("/definitely/not/here.json")).toBeUndefined();
  });
});
