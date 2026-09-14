import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { keccak256, toHex } from "viem";
import type { CharterV1 } from "@fleet/schemas";
import { canonicalize } from "@fleet/schemas";
import { FleetClient, addressesFromManifest } from "@fleet/sdk";
import { anvilDevKey, DEMO_ACCOUNT_INDEX } from "./anvil-keys.js";
import { deployFleet, verifyDeployment } from "./deploy.js";
import { parseSignerFeeLimits } from "./env.js";
import { loadDemoFixtures } from "./fixtures.js";
import type { FixtureRunContext, FixtureRunResult, FleetKeys } from "./pipeline/fixture-runner.js";
import { runFixture } from "./pipeline/fixture-runner.js";
import { buildRecord, writeJsonRecord } from "./pipeline/record.js";
import type { RunRecordDocument } from "./pipeline/record.js";
import { renderReport } from "./pipeline/report.js";
import { buildReadSideSyncConfig } from "./pipeline/readside-sync-config.js";
import { openTask } from "./pipeline/task.js";
import { readEnvValue, readside } from "./readside.js";

/** The task charter every `fleet demo` fixture task is opened with. Must stay in lock step with
 *  `experiments/fixtures/scripted/legit-amendment.json`'s `trigger.newCharter`, which is this
 *  charter plus one appended `externalAllowlist` host (`demo.test.ts` asserts that directly). */
export const DEMO_TASK_CHARTER: CharterV1 = {
  schema: "fleet.charter.v1",
  goal: "Implement the failing functions in this repository so the provided test suite passes.",
  allowedActionClasses: ["read_repo", "write_repo", "run_tests", "package_install", "network_fetch"],
  forbiddenActions: [],
  externalAllowlist: ["registry.npmjs.org"],
  budget: { toolCalls: 200, inferenceTokens: 2_000_000 },
  stopConditions: ["tests_pass"],
};

export type DemoOptions = {
  rpcUrl: string;
  /** Asserts the target chain has no prior fleet deployment worth preserving: `fleet demo`
   *  deploys a brand new fleet either way (task 8 brief), but only in this mode does it also fast
   *  forward chain time with `evm_increaseTime`/`evm_mine` between governance stages, since only
   *  then can the caller be sure nothing else depends on this chain's time passing naturally
   *  (controller notes: "moves nothing by RPC in real runs ... the integration test may use
   *  evm_increaseTime"). */
  freshAnvil: boolean;
  /** Brings up the read side (`fleet readside --restart`) after deploying, before running any
   *  fixture. Off by default so the demo needs no Docker (task 8 controller notes). */
  readside: boolean;
  reportDir: string;
  fixturesDir: string;
  contractsDir: string;
  configPath: string;
  manifestOutPath: string;
  infraDir: string;
  abiSourceDir: string;
  deploymentsDir: string;
  agoraNextBaseUrl?: string;
  log?: (message: string) => void;
};

export type DemoOutcome = {
  runId: string;
  results: FixtureRunResult[];
  record: RunRecordDocument;
  recordPath: string;
  reportPath: string;
  allPassed: boolean;
  runtimeMs: number;
};

function makeAdvanceTime(client: FleetClient): (seconds: number) => Promise<void> {
  return async (seconds: number) => {
    await client.publicClient.request({ method: "evm_increaseTime" as never, params: [seconds] as never });
    await client.publicClient.request({ method: "evm_mine" as never, params: [] as never });
  };
}

function buildDemoKeys(): FleetKeys {
  const agentKeys: Record<number, `0x${string}`> = {};
  for (let agentId = 0; agentId < 5; agentId++) {
    agentKeys[agentId] = anvilDevKey(DEMO_ACCOUNT_INDEX.agent(agentId));
  }
  return {
    deployerKey: anvilDevKey(DEMO_ACCOUNT_INDEX.deployer),
    operatorKey: anvilDevKey(DEMO_ACCOUNT_INDEX.operator),
    guardianKey: anvilDevKey(DEMO_ACCOUNT_INDEX.guardian),
    keeperKey: anvilDevKey(DEMO_ACCOUNT_INDEX.keeper),
    agentKeys,
  };
}

/**
 * Runs the eight spec 15.3 scenario fixtures in order on one fresh fleet deployment (task 8
 * brief), each on its own fresh task, using the well-known local Anvil dev keys (`anvil-keys.ts`)
 * for every role. Writes `record.json` and `report.md` under `<reportDir>/<runId>/` and returns
 * every fixture's result. Never throws on a fixture assertion mismatch (that is what
 * `DemoOutcome.allPassed` and each result's own `pass`/`mismatches` are for); it does throw on an
 * infrastructure failure (deploy, verify, or a stage that could not complete at all).
 */
export async function runDemo(opts: DemoOptions): Promise<DemoOutcome> {
  const start = Date.now();
  const log = opts.log ?? (() => {});
  const runId = `demo-${start}`;

  // `--fresh-anvil` asserts the target chain has no prior deployment worth preserving, so a
  // manifest left at the output path by an earlier demo describes contracts that no longer exist:
  // `deployFleet` is idempotent on a matching configHash and would reuse it, and every later stage
  // would then call into empty addresses. Removing it first is what the flag already means.
  if (opts.freshAnvil && existsSync(opts.manifestOutPath)) {
    log(`demo: --fresh-anvil, discarding the stale manifest at ${opts.manifestOutPath}`);
    rmSync(opts.manifestOutPath, { force: true });
  }

  const { manifest } = await deployFleet({
    contractsDir: opts.contractsDir,
    configPath: opts.configPath,
    rpcUrl: opts.rpcUrl,
    deployerKey: anvilDevKey(DEMO_ACCOUNT_INDEX.deployer),
    outPath: opts.manifestOutPath,
  });
  log(`demo: deployment manifest ready at ${opts.manifestOutPath} (chainId ${manifest.chainId})`);

  await verifyDeployment({ contractsDir: opts.contractsDir, manifestPath: opts.manifestOutPath, rpcUrl: opts.rpcUrl });
  log("demo: VerifyDeployment.s.sol reported VERIFIED");

  if (opts.readside) {
    await readside({
      manifestPath: opts.manifestOutPath,
      infraDir: opts.infraDir,
      abiSourceDir: opts.abiSourceDir,
      deploymentsDir: opts.deploymentsDir,
      restart: true,
      log,
    });
  }

  const addresses = addressesFromManifest(manifest);
  const client = new FleetClient({ rpcUrl: opts.rpcUrl, chainId: manifest.chainId, addresses });
  const keys = buildDemoKeys();
  const advanceTime = opts.freshAnvil ? makeAdvanceTime(client) : undefined;

  // Task 8 finding 3: when the read side is enabled, sync CPLS's archive after every governance
  // transaction. `readSideSyncHandle.close()` releases the `agora_web3` Postgres pool once the
  // whole demo is done (or if it throws), regardless of how many fixtures ran.
  const readSideSyncHandle = opts.readside ? buildReadSideSyncConfig(opts.infraDir) : null;
  const agoraNextBaseUrl = opts.agoraNextBaseUrl ?? (opts.readside ? defaultAgoraNextBaseUrl(opts.infraDir) : undefined);

  try {
    const ctx: FixtureRunContext = {
      client,
      rpcUrl: opts.rpcUrl,
      chainId: manifest.chainId,
      addresses,
      keys,
      feeLimits: parseSignerFeeLimits(process.env),
      ...(advanceTime ? { advanceTime } : {}),
      ...(readSideSyncHandle ? { readSideSync: readSideSyncHandle.config } : {}),
      submissionMarginSec: 6,
      log,
    };

    const fixtures = loadDemoFixtures(opts.fixturesDir);
    const results: FixtureRunResult[] = [];
    for (const fixture of fixtures) {
      const { taskId } = await openTask({
        client,
        addresses,
        chainId: manifest.chainId,
        rpcUrl: opts.rpcUrl,
        operatorKey: keys.operatorKey,
        charter: DEMO_TASK_CHARTER,
        lifetimeSeconds: manifest.params.maxTaskLifetime,
      });
      log(`demo: opened task ${taskId.toString()} for fixture ${fixture.name}`);
      const result = await runFixture(ctx, fixture, taskId);
      results.push(result);
      log(`demo: ${fixture.name} -> ${result.finalStateName} (${result.pass ? "PASS" : "FAIL: " + result.mismatches.join("; ")})`);
      if (agoraNextBaseUrl) {
        log(`demo: ${fixture.name} -> ${agoraNextBaseUrl.replace(/\/$/, "")}/proposals/${result.proposalId.toString()}`);
      }
    }

    const configForHash = { schema: "fleet.demo.v1" as const, rpcUrl: opts.rpcUrl, freshAnvil: opts.freshAnvil, readside: opts.readside, fixtures: fixtures.map((f) => f.name) };
    const record = await buildRecord({
      client,
      runId,
      config: configForHash,
      configHash: keccak256(toHex(canonicalize(configForHash))),
      manifest,
      results,
      timings: {
        startedAt: new Date(start).toISOString(),
        finishedAt: new Date().toISOString(),
        runtimeMs: Date.now() - start,
      },
      versions: { node: process.version, fleetSchemasSchema: "fleet.record.v1" },
    });

    const runDir = path.join(opts.reportDir, runId);
    const recordPath = path.join(runDir, "record.json");
    writeJsonRecord(recordPath, record);

    const reportPath = path.join(runDir, "report.md");
    const reportText = renderReport(record, {
      title: "Fleet Governance Demo Report",
      ...(agoraNextBaseUrl ? { agoraNextBaseUrl } : {}),
    });
    mkdirSync(runDir, { recursive: true });
    writeFileSync(reportPath, reportText, "utf8");

    const allPassed = results.every((r) => r.pass);
    return { runId, results, record, recordPath, reportPath, allPassed, runtimeMs: Date.now() - start };
  } finally {
    if (readSideSyncHandle) await readSideSyncHandle.close();
  }
}

function defaultAgoraNextBaseUrl(infraDir: string): string {
  const envPath = path.join(infraDir, ".env");
  const envText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const port = readEnvValue(envText, "AGORA_NEXT_PORT", "3000");
  return `http://localhost:${port}`;
}

/** Renders the demo's plain-text results table (task 8 brief: "print a table and exit non-zero
 *  on any mismatch"). Pure and unit-testable: takes only the fields it needs from each result. */
export function formatDemoTable(
  results: readonly Pick<FixtureRunResult, "fixture" | "finalStateName" | "pass" | "mismatches">[],
): string {
  const rows = results.map((r) => ({
    name: r.fixture.name,
    expected: r.fixture.expected.outcome,
    actual: r.finalStateName,
    status: r.pass ? "PASS" : "FAIL",
  }));
  const nameWidth = Math.max(7, ...rows.map((r) => r.name.length));
  const expectedWidth = Math.max(8, ...rows.map((r) => r.expected.length));
  const actualWidth = Math.max(6, ...rows.map((r) => r.actual.length));

  const header = `${"FIXTURE".padEnd(nameWidth)}  ${"EXPECTED".padEnd(expectedWidth)}  ${"ACTUAL".padEnd(actualWidth)}  STATUS`;
  const lines = [header, "-".repeat(header.length)];
  for (const r of rows) {
    lines.push(`${r.name.padEnd(nameWidth)}  ${r.expected.padEnd(expectedWidth)}  ${r.actual.padEnd(actualWidth)}  ${r.status}`);
  }
  for (const r of results) {
    if (!r.pass) {
      for (const m of r.mismatches) lines.push(`  ${r.fixture.name}: ${m}`);
    }
  }
  return lines.join("\n");
}
