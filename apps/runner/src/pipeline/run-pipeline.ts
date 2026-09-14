import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { keccak256, toHex } from "viem";
import type { Hex } from "viem";
import { ExperimentConfigV1, canonicalize } from "@fleet/schemas";
import type { ExperimentConfigV1 as ExperimentConfigV1Type, ManifestV1 } from "@fleet/schemas";
import { FleetClient, addressesFromManifest } from "@fleet/sdk";
import type { FleetAddresses } from "@fleet/sdk";
import { deployFleet, verifyDeployment } from "../deploy.js";
import { RunnerEnvError, requirePrivateKeyEnv } from "../env.js";
import { loadFixture } from "../fixtures.js";
import { readside } from "../readside.js";
import type { FixtureRunContext, FixtureRunResult, FleetKeys } from "./fixture-runner.js";
import { runFixture } from "./fixture-runner.js";
import { buildRecord, writeJsonRecord } from "./record.js";
import type { RunRecordDocument } from "./record.js";
import { renderReport } from "./report.js";
import type { RunStore, Stage, StageName } from "./state.js";
import { runStages } from "./state.js";
import { openTask } from "./task.js";

export type RunPipelineOptions = {
  runId: string;
  experimentPath: string;
  fixturesDir: string;
  contractsDir: string;
  configDir: string;
  manifestOutPath: string;
  infraDir: string;
  abiSourceDir: string;
  deploymentsDir: string;
  store: RunStore;
  log?: (message: string) => void;
};

export type RunPipelineCtx = {
  opts: RunPipelineOptions;
  experiment: ExperimentConfigV1Type;
  manifest: ManifestV1 | null;
  addresses: FleetAddresses | null;
  client: FleetClient | null;
  keys: FleetKeys | null;
  taskId: bigint | null;
  result: FixtureRunResult | null;
  record: RunRecordDocument | null;
  recordPath: string | null;
  reportPath: string | null;
};

/** Reads every key `fleet run` needs from the environment, one variable per role, matching the
 *  naming `apps/worker`/`apps/keeper`/`DeployFleet.s.sol` already use (`FLEET_DEPLOYER_KEY`,
 *  `FLEET_AGENT_KEY`, `FLEET_KEEPER_KEY`) plus one `FLEET_AGENT_KEY_<n>` per fleet member, since
 *  `fleet.experiment.v1` itself only references keys "by reference to the secret store" (spec
 *  12.1) rather than carrying them inline. */
export function loadRunKeysFromEnv(env: NodeJS.ProcessEnv, memberCount: number): FleetKeys {
  const agentKeys: Record<number, Hex> = {};
  for (let i = 0; i < memberCount; i++) {
    agentKeys[i] = requirePrivateKeyEnv(env, `FLEET_AGENT_KEY_${i}`);
  }
  return {
    deployerKey: requirePrivateKeyEnv(env, "FLEET_DEPLOYER_KEY"),
    operatorKey: requirePrivateKeyEnv(env, "FLEET_OPERATOR_KEY"),
    guardianKey: requirePrivateKeyEnv(env, "FLEET_GUARDIAN_KEY"),
    keeperKey: requirePrivateKeyEnv(env, "FLEET_KEEPER_KEY"),
    agentKeys,
  };
}

function loadExperiment(experimentPath: string): ExperimentConfigV1Type {
  const text = readFileSync(experimentPath, "utf8");
  const json: unknown = JSON.parse(text);
  const result = ExperimentConfigV1.safeParse(json);
  if (!result.success) {
    throw new RunnerEnvError(`experiment config at ${experimentPath} does not parse as fleet.experiment.v1: ${result.error.message}`);
  }
  return result.data;
}

/** Builds the ten spec 12.2 `fleet run` stages. Each stage checks chain or file state before
 *  acting, so `runStages` can resume a partially completed run without redoing finished work. */
export function buildRunStages(env: NodeJS.ProcessEnv): readonly Stage<RunPipelineCtx>[] {
  const stageNames: StageName[] = [
    "PREFLIGHT",
    "CHAIN_READY",
    "DEPLOYED",
    "VERIFIED",
    "INDEXERS_READY",
    "TASK_OPENED",
    "AGENTS_RUNNING",
    "TASK_ENDED",
    "CAPTURED",
    "REPORTED",
  ];
  const log = (ctx: RunPipelineCtx, message: string): void => (ctx.opts.log ?? (() => {}))(message);

  const stages: Record<StageName, (ctx: RunPipelineCtx) => Promise<RunPipelineCtx>> = {
    PREFLIGHT: async (ctx) => {
      log(ctx, `preflight: experiment "${ctx.experiment.name}", target ${ctx.experiment.target.kind}, fixture ${ctx.experiment.scenario.fixture}`);
      return ctx;
    },

    CHAIN_READY: async (ctx) => {
      const probe = new FleetClient({
        rpcUrl: ctx.experiment.target.rpcHttp,
        chainId: 0,
        addresses: {
          registry: "0x0000000000000000000000000000000000000000",
          token: "0x0000000000000000000000000000000000000000",
          timelock: "0x0000000000000000000000000000000000000000",
          ledger: "0x0000000000000000000000000000000000000000",
          hook: "0x0000000000000000000000000000000000000000",
          governor: "0x0000000000000000000000000000000000000000",
        },
      });
      const chainId = await probe.publicClient.getChainId();
      log(ctx, `chain ready: ${ctx.experiment.target.rpcHttp} reports chainId ${chainId}`);
      return ctx;
    },

    DEPLOYED: async (ctx) => {
      const configPath = path.join(ctx.opts.configDir, `${ctx.experiment.name}.deploy.json`);
      const keys = loadRunKeysFromEnv(env, ctx.experiment.fleet.members.length);
      const { manifest, deployed } = await deployFleet({
        contractsDir: ctx.opts.contractsDir,
        configPath,
        rpcUrl: ctx.experiment.target.rpcHttp,
        deployerKey: keys.deployerKey,
        outPath: ctx.opts.manifestOutPath,
      });
      log(ctx, `deployed: ${deployed ? "ran forge script" : "reused existing manifest"} at ${ctx.opts.manifestOutPath}`);
      return { ...ctx, manifest, keys };
    },

    VERIFIED: async (ctx) => {
      await verifyDeployment({ contractsDir: ctx.opts.contractsDir, manifestPath: ctx.opts.manifestOutPath, rpcUrl: ctx.experiment.target.rpcHttp });
      log(ctx, "verified: VerifyDeployment.s.sol reported VERIFIED");
      return ctx;
    },

    INDEXERS_READY: async (ctx) => {
      await readside({
        manifestPath: ctx.opts.manifestOutPath,
        infraDir: ctx.opts.infraDir,
        abiSourceDir: ctx.opts.abiSourceDir,
        deploymentsDir: ctx.opts.deploymentsDir,
        restart: false,
        log: (m) => log(ctx, m),
      });
      return ctx;
    },

    TASK_OPENED: async (ctx) => {
      if (!ctx.manifest || !ctx.keys) throw new Error("TASK_OPENED: manifest/keys missing (DEPLOYED did not run)");
      const addresses = addressesFromManifest(ctx.manifest);
      const client = new FleetClient({ rpcUrl: ctx.experiment.target.rpcHttp, chainId: ctx.manifest.chainId, addresses });
      const { taskId } = await openTask({
        client,
        addresses,
        chainId: ctx.manifest.chainId,
        rpcUrl: ctx.experiment.target.rpcHttp,
        operatorKey: ctx.keys.operatorKey,
        charter: ctx.experiment.task.charter,
        lifetimeSeconds: ctx.experiment.task.lifetime,
      });
      log(ctx, `task opened: ${taskId.toString()}`);
      return { ...ctx, addresses, client, taskId };
    },

    AGENTS_RUNNING: async (ctx) => {
      if (!ctx.manifest || !ctx.addresses || !ctx.client || !ctx.keys || ctx.taskId === null) {
        throw new Error("AGENTS_RUNNING: missing prior stage output");
      }
      const fixturePath = path.join(ctx.opts.fixturesDir, `${ctx.experiment.scenario.fixture}.json`);
      const fixture = loadFixture(fixturePath);
      const fixtureCtx: FixtureRunContext = {
        client: ctx.client,
        rpcUrl: ctx.experiment.target.rpcHttp,
        chainId: ctx.manifest.chainId,
        addresses: ctx.addresses,
        keys: ctx.keys,
        submissionMarginSec: 20,
        log: (m) => log(ctx, m),
      };
      const result = await runFixture(fixtureCtx, fixture, ctx.taskId);
      log(ctx, `agents running: ${fixture.name} -> ${result.finalStateName} (${result.pass ? "PASS" : "FAIL"})`);
      return { ...ctx, result };
    },

    TASK_ENDED: async (ctx) => ctx,

    CAPTURED: async (ctx) => {
      if (!ctx.client || !ctx.manifest || !ctx.result) throw new Error("CAPTURED: missing prior stage output");
      const configForHash = { schema: "fleet.experiment.v1" as const, name: ctx.experiment.name };
      const record = await buildRecord({
        client: ctx.client,
        runId: ctx.opts.runId,
        config: ctx.experiment,
        configHash: keccak256(toHex(canonicalize(configForHash))),
        manifest: ctx.manifest,
        results: [ctx.result],
        timings: {},
        versions: { node: process.version },
      });
      const runDir = path.join(ctx.opts.deploymentsDir, "..", ctx.experiment.capture.reportDir, ctx.opts.runId);
      const recordPath = path.join(runDir, "record.json");
      writeJsonRecord(recordPath, record);
      log(ctx, `captured: wrote ${recordPath}`);
      return { ...ctx, record, recordPath };
    },

    REPORTED: async (ctx) => {
      if (!ctx.record || !ctx.recordPath) throw new Error("REPORTED: missing prior stage output");
      const reportPath = ctx.recordPath.replace(/record\.json$/, "report.md");
      const opts: { title: string; agoraNextBaseUrl?: string } = { title: `Fleet Governance Report: ${ctx.experiment.name}` };
      if (ctx.experiment.display.agoraNextBaseUrl) opts.agoraNextBaseUrl = ctx.experiment.display.agoraNextBaseUrl;
      const reportText = renderReport(ctx.record, opts);
      mkdirSync(path.dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, reportText, "utf8");
      log(ctx, `reported: wrote ${reportPath}`);
      return { ...ctx, reportPath };
    },
  };

  return stageNames.map((name) => ({ name, run: stages[name] }));
}

export function toRunPayload(ctx: RunPipelineCtx): Record<string, unknown> {
  return {
    experimentName: ctx.experiment.name,
    manifestChainId: ctx.manifest?.chainId ?? null,
    taskId: ctx.taskId?.toString() ?? null,
    proposalId: ctx.result?.proposalId?.toString() ?? null,
    pass: ctx.result?.pass ?? null,
    recordPath: ctx.recordPath,
    reportPath: ctx.reportPath,
  };
}

export async function runExperiment(opts: RunPipelineOptions, env: NodeJS.ProcessEnv = process.env): Promise<RunPipelineCtx> {
  const experiment = loadExperiment(opts.experimentPath);
  const stages = buildRunStages(env);
  const initialCtx: RunPipelineCtx = {
    opts,
    experiment,
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
  return runStages({ runId: opts.runId, store: opts.store, stages, ctx: initialCtx, toPayload: toRunPayload });
}
