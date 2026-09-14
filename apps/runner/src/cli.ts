#!/usr/bin/env node
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { CharterV1 } from "@fleet/schemas";
import { deployFleet, verifyDeployment } from "./deploy.js";
import { runDemo, formatDemoTable } from "./demo.js";
import { RunnerEnvError, loadManifest, requirePrivateKeyEnv } from "./env.js";
import { createLogger } from "./logger.js";
import { openRunStore } from "./pipeline/state.js";
import { readJsonRecord, writeJsonRecord, captureFromChain } from "./pipeline/record.js";
import type { RunRecordDocument } from "./pipeline/record.js";
import { renderReport } from "./pipeline/report.js";
import { openTask } from "./pipeline/task.js";
import { runExperiment } from "./pipeline/run-pipeline.js";
import { readside } from "./readside.js";
import { FleetClient, addressesFromManifest } from "@fleet/sdk";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "../../..");

const logger = createLogger({ name: "fleet", level: process.env["LOG_LEVEL"] ?? "info" });

function defaultReportDir(): string {
  return path.join(repoRoot, "experiments", "reports");
}

function defaultFixturesDir(): string {
  return path.join(repoRoot, "experiments", "fixtures", "scripted");
}

function defaultAbiSourceDir(): string {
  return path.join(repoRoot, "packages", "abi", "abis");
}

function defaultDeploymentsDir(): string {
  return path.join(repoRoot, "deployments");
}

function defaultContractsDir(): string {
  return path.join(repoRoot, "contracts");
}

function fail(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  logger.error(message);
  // eslint-disable-next-line no-console
  console.error(`fleet: ${message}`);
  process.exit(1);
}

const program = new Command();
program.name("fleet").description("Fleet Governance headless pipeline: deploy, read side, tasks, runs, capture, report, demo.");

program
  .command("deploy")
  .description("Deploy a fleet with the Foundry script and write a manifest.")
  .requiredOption("--config <path>", "fleet.deploy.v1 config JSON path")
  .requiredOption("--rpc <url>", "RPC URL for the target chain")
  .option("--key-env <name>", "environment variable holding the deployer's private key", "FLEET_DEPLOYER_KEY")
  .requiredOption("--out <path>", "where to write the manifest")
  .action(async (opts: { config: string; rpc: string; keyEnv: string; out: string }) => {
    try {
      const deployerKey = requirePrivateKeyEnv(process.env, opts.keyEnv);
      const { manifest, deployed } = await deployFleet({
        contractsDir: defaultContractsDir(),
        configPath: opts.config,
        rpcUrl: opts.rpc,
        deployerKey,
        outPath: opts.out,
      });
      logger.info({ deployed, chainId: manifest.chainId, out: opts.out }, "deploy complete");
      // eslint-disable-next-line no-console
      console.log(`fleet deploy: ${deployed ? "deployed" : "reused existing manifest"} -> ${opts.out}`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("verify")
  .description("Run VerifyDeployment.s.sol against a manifest.")
  .requiredOption("--manifest <path>", "manifest JSON path")
  .requiredOption("--rpc <url>", "RPC URL for the target chain")
  .action(async (opts: { manifest: string; rpc: string }) => {
    try {
      await verifyDeployment({ contractsDir: defaultContractsDir(), manifestPath: opts.manifest, rpcUrl: opts.rpc });
      // eslint-disable-next-line no-console
      console.log("fleet verify: VERIFIED");
    } catch (err) {
      fail(err);
    }
  });

program
  .command("readside")
  .description("Write the Part 2 read side's config (infra/.env, DAO Node ABIs, Agora Next deployment file) from a manifest.")
  .requiredOption("--manifest <path>", "manifest JSON path")
  .option("--infra-dir <path>", "infra/ directory", "infra")
  .option("--restart", "also restart dao-node/cpls and wait for them to become ready", false)
  .action(async (opts: { manifest: string; infraDir: string; restart: boolean }) => {
    try {
      const result = await readside({
        manifestPath: opts.manifest,
        infraDir: path.resolve(opts.infraDir),
        abiSourceDir: defaultAbiSourceDir(),
        deploymentsDir: defaultDeploymentsDir(),
        restart: opts.restart,
        log: (m) => {
          logger.info(m);
          // eslint-disable-next-line no-console
          console.log(m);
        },
      });
      // eslint-disable-next-line no-console
      console.log(`fleet readside: wrote ${result.envFile}, ${result.tokenAbiFile}, ${result.governorAbiFile}, ${result.agoraNextDeploymentFile}`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("open-task")
  .description("Open a task on a deployed fleet with the operator's key.")
  .requiredOption("--manifest <path>", "manifest JSON path")
  .requiredOption("--charter <path>", "fleet.charter.v1 JSON path")
  .requiredOption("--lifetime <seconds>", "task lifetime in seconds")
  .option("--operator-key-env <name>", "environment variable holding the operator's private key", "OPERATOR_KEY")
  .requiredOption("--rpc <url>", "RPC URL for the target chain (not in the manifest itself)")
  .action(async (opts: { manifest: string; charter: string; lifetime: string; operatorKeyEnv: string; rpc: string }) => {
    try {
      const manifest = loadManifest(opts.manifest);
      const addresses = addressesFromManifest(manifest);
      const client = new FleetClient({ rpcUrl: opts.rpc, chainId: manifest.chainId, addresses });
      const operatorKey = requirePrivateKeyEnv(process.env, opts.operatorKeyEnv);
      const { readFileSync } = await import("node:fs");
      const charterJson: unknown = JSON.parse(readFileSync(opts.charter, "utf8"));
      const charter = CharterV1.parse(charterJson);
      const { taskId, txHash } = await openTask({
        client,
        addresses,
        chainId: manifest.chainId,
        rpcUrl: opts.rpc,
        operatorKey,
        charter,
        lifetimeSeconds: Number(opts.lifetime),
      });
      // eslint-disable-next-line no-console
      console.log(`fleet open-task: task ${taskId.toString()} opened (tx ${txHash})`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("run")
  .description("Run the full pipeline (spec 12.2) for one fleet.experiment.v1 config, resumable by --run-id.")
  .requiredOption("--experiment <path>", "fleet.experiment.v1 config JSON path")
  .option("--run-id <id>", "resume (or start) this run id")
  .option("--report-dir <path>", "base report directory", defaultReportDir())
  .option("--readside", "bring up and sync the read side (Docker Compose, CPLS archive sync)", false)
  .action(async (opts: { experiment: string; runId?: string; reportDir: string; readside: boolean }) => {
    try {
      const runId = opts.runId ?? `run-${Date.now()}`;
      const runDir = path.join(opts.reportDir, runId);
      mkdirSync(runDir, { recursive: true });
      const store = await openRunStore({ pgUrl: process.env["RUNNER_PG_URL"], runDir });
      const ctx = await runExperiment({
        runId,
        experimentPath: opts.experiment,
        fixturesDir: defaultFixturesDir(),
        contractsDir: defaultContractsDir(),
        configDir: path.join(repoRoot, "deployments", "configs"),
        manifestOutPath: path.join(repoRoot, "deployments", "experiment-latest.json"),
        infraDir: path.join(repoRoot, "infra"),
        abiSourceDir: defaultAbiSourceDir(),
        deploymentsDir: defaultDeploymentsDir(),
        readSide: opts.readside,
        store,
        log: (m) => {
          logger.info(m);
          // eslint-disable-next-line no-console
          console.log(m);
        },
      });
      // eslint-disable-next-line no-console
      console.log(`fleet run: run ${runId} complete. record: ${ctx.recordPath}, report: ${ctx.reportPath}`);
      if (ctx.result && !ctx.result.pass) process.exitCode = 1;
    } catch (err) {
      fail(err);
    }
  });

program
  .command("capture")
  .description("Rebuild record.json's chain-derived sections for a run.")
  .requiredOption("--run-id <id>", "run id")
  .option("--report-dir <path>", "base report directory", defaultReportDir())
  .option("--rpc <url>", "RPC URL (required with --from-chain)")
  .option("--from-chain", "rebuild events[] and votes[] purely from chain logs", false)
  .action(async (opts: { runId: string; reportDir: string; rpc?: string; fromChain: boolean }) => {
    try {
      const recordPath = path.join(opts.reportDir, opts.runId, "record.json");
      if (!existsSync(recordPath)) throw new RunnerEnvError(`no record.json found for run ${opts.runId} at ${recordPath}`);
      const existing = readJsonRecord<RunRecordDocument>(recordPath);

      if (!opts.fromChain) {
        // eslint-disable-next-line no-console
        console.log(`fleet capture: record.json for run ${opts.runId} exists at ${recordPath} (pass --from-chain to rebuild it)`);
        return;
      }
      if (!opts.rpc) throw new RunnerEnvError("capture --from-chain: --rpc is required");

      const addresses = addressesFromManifest(existing.manifest);
      const client = new FleetClient({ rpcUrl: opts.rpc, chainId: existing.manifest.chainId, addresses });
      const recaptured = await captureFromChain(client, existing);
      writeJsonRecord(recordPath, recaptured);
      // eslint-disable-next-line no-console
      console.log(`fleet capture --from-chain: rebuilt events[] (${recaptured.events.length}) and votes[] (${recaptured.votes.length}) for run ${opts.runId}`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("report")
  .description("Render report.md from an existing record.json.")
  .requiredOption("--run-id <id>", "run id")
  .option("--report-dir <path>", "base report directory", defaultReportDir())
  .action(async (opts: { runId: string; reportDir: string }) => {
    try {
      const runDir = path.join(opts.reportDir, opts.runId);
      const recordPath = path.join(runDir, "record.json");
      if (!existsSync(recordPath)) throw new RunnerEnvError(`no record.json found for run ${opts.runId} at ${recordPath}`);
      const record = readJsonRecord<RunRecordDocument>(recordPath);
      const config = record.config as { display?: { agoraNextBaseUrl?: string } } | undefined;
      const reportOpts: { title: string; agoraNextBaseUrl?: string } = { title: `Fleet Governance Report: ${opts.runId}` };
      if (config?.display?.agoraNextBaseUrl) reportOpts.agoraNextBaseUrl = config.display.agoraNextBaseUrl;
      const reportText = renderReport(record, reportOpts);
      const { writeFileSync } = await import("node:fs");
      const reportPath = path.join(runDir, "report.md");
      writeFileSync(reportPath, reportText, "utf8");
      // eslint-disable-next-line no-console
      console.log(`fleet report: wrote ${reportPath}`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("demo")
  .description("Run the eight scripted fixtures (spec 15.3) on one fresh fleet deployment.")
  .requiredOption("--rpc <url>", "RPC URL for the target chain")
  .option("--fresh-anvil", "the target chain has no prior deployment; also fast-forward chain time between stages", false)
  .option("--readside", "bring up the read side (fleet readside --restart) before running fixtures", false)
  .option("--report-dir <path>", "base report directory", defaultReportDir())
  .option("--agora-next-base-url <url>", "Agora Next base URL for printed proposal links")
  .action(async (opts: { rpc: string; freshAnvil: boolean; readside: boolean; reportDir: string; agoraNextBaseUrl?: string }) => {
    try {
      const outcome = await runDemo({
        rpcUrl: opts.rpc,
        freshAnvil: opts.freshAnvil,
        readside: opts.readside,
        reportDir: opts.reportDir,
        fixturesDir: defaultFixturesDir(),
        contractsDir: defaultContractsDir(),
        configPath: path.join(repoRoot, "deployments", "configs", "local-5.json"),
        manifestOutPath: path.join(repoRoot, "deployments", "demo-latest.json"),
        infraDir: path.join(repoRoot, "infra"),
        abiSourceDir: defaultAbiSourceDir(),
        deploymentsDir: defaultDeploymentsDir(),
        ...(opts.agoraNextBaseUrl ? { agoraNextBaseUrl: opts.agoraNextBaseUrl } : {}),
        log: (m) => {
          logger.info(m);
          // eslint-disable-next-line no-console
          console.log(m);
        },
      });
      // eslint-disable-next-line no-console
      console.log("");
      // eslint-disable-next-line no-console
      console.log(formatDemoTable(outcome.results));
      // eslint-disable-next-line no-console
      console.log("");
      // eslint-disable-next-line no-console
      console.log(`fleet demo: ${outcome.results.filter((r) => r.pass).length}/${outcome.results.length} fixtures matched their expected outcome in ${outcome.runtimeMs}ms`);
      // eslint-disable-next-line no-console
      console.log(`fleet demo: record ${outcome.recordPath}`);
      // eslint-disable-next-line no-console
      console.log(`fleet demo: report ${outcome.reportPath}`);
      if (!outcome.allPassed) process.exitCode = 1;
    } catch (err) {
      fail(err);
    }
  });

const isMainModule = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  program.parseAsync(process.argv).catch(fail);
}

export { program };
