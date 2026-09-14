import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createPublicClient, http, keccak256, toHex } from "viem";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ExperimentConfigV1, ManifestV1, assertAllowedChain, canonicalize, chainIdForKind } from "@fleet/schemas";
import type { ExperimentConfigV1 as ExperimentConfigV1Type, ManifestV1 as ManifestV1Type } from "@fleet/schemas";
import { FleetClient, addressesFromManifest } from "@fleet/sdk";
import type { FleetAddresses } from "@fleet/sdk";
import { deployFleet, verifyDeployment } from "../deploy.js";
import { RunnerEnvError, parseSignerFeeLimits, requirePrivateKeyEnv } from "../env.js";
import { loadFixture } from "../fixtures.js";
import { readEnvValue, readside } from "../readside.js";
import type { FixtureRunContext, FixtureRunResult, FleetKeys } from "./fixture-runner.js";
import { runFixture } from "./fixture-runner.js";
import { defaultPreflightDeps, formatPreflightReport, runPreflight } from "./preflight.js";
import { buildReadSideSyncConfig } from "./readside-sync-config.js";
import { buildRecord, writeJsonRecord } from "./record.js";
import type { RunRecordDocument } from "./record.js";
import { renderReport } from "./report.js";
import type { RunStore, Stage, StageName, StageTimings } from "./state.js";
import { runStages } from "./state.js";
import { openTask } from "./task.js";

export type RunPipelineOptions = {
  runId: string;
  experimentPath: string;
  fixturesDir: string;
  contractsDir: string;
  configDir: string;
  infraDir: string;
  abiSourceDir: string;
  /** Where deployment manifests live. `fleet run` writes this run's manifest to
   *  `<deploymentsDir>/<chainId>/latest.json` plus a per-run copy
   *  `<deploymentsDir>/<chainId>/run-<runId>.json` (spec section 8's deployment layout, spec 16.2's
   *  "writes the manifest under `deployments/84532/`", and the same file
   *  `infra/scripts/bootstrap-local.sh` writes for Anvil). Final review I8: the pipeline used to
   *  write `deployments/experiment-latest.json`, which no other tool or document reads. */
  deploymentsDir: string;
  /** Base report directory: this run's `record.json` and `report.md` go under
   *  `<reportDir>/<runId>/`, the same directory `fleet capture`/`fleet report --report-dir` read
   *  and the same one the run store uses. */
  reportDir: string;
  store: RunStore;
  /** Whether the read side (Docker Compose: DAO Node, CPLS, Agora Next) is part of this run.
   *  Gates PREFLIGHT's `docker`/container-health/bucket checks, CPLS per-decision archive sync
   *  during `AGENTS_RUNNING` (task 8 finding 3), and whether `INDEXERS_READY` restarts the stack. */
  readSide?: boolean;
  log?: (message: string) => void;
};

export type RunPipelineCtx = {
  opts: RunPipelineOptions;
  experiment: ExperimentConfigV1Type;
  /** The chain id the target RPC actually reported, known from `CHAIN_READY` onward. */
  chainId: number | null;
  /** `<deploymentsDir>/<chainId>/latest.json`, derivable only once `chainId` is known. */
  manifestOutPath: string | null;
  /** One entry per stage `runStages` has finished, filled in as the run goes (final review M5).
   *  The same object `runStages` was handed, so `CAPTURED` sees every earlier stage's span. */
  timings: StageTimings;
  manifest: ManifestV1Type | null;
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

/**
 * `record.json`'s `configHash`, spec 12.4's "config and its hash". The hash covers the whole
 * config the record stores. Final review I3: it used to cover only `{schema, name}`, so two runs
 * of the same experiment name with different charters, budgets, governance numbers or fixtures
 * produced identical hashes, and a reader could not tell that the stored config had been edited.
 * The parsed config is plain JSON, so `canonicalize` takes it as is.
 */
export function experimentConfigHash(config: unknown): Hex {
  return keccak256(toHex(canonicalize(config)));
}

/** The two manifest paths a run writes, spec section 8's layout: `latest.json` is the pointer the
 *  next deployment overwrites, and `run-<runId>.json` is this run's own copy, so a later
 *  `fleet capture` or a report can still name the exact manifest a given run deployed against
 *  after another run has moved `latest.json` on (final review I8). */
export function manifestPathsForRun(deploymentsDir: string, chainId: number, runId: string): { latest: string; perRun: string } {
  const dir = path.join(deploymentsDir, String(chainId));
  return { latest: path.join(dir, "latest.json"), perRun: path.join(dir, `run-${runId}.json`) };
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

/**
 * Rebuilds everything the finished stages had put in the context, from the checkpoint payload
 * `toRunPayload` wrote (final review I1). A resumed `fleet run` is a fresh process: without this,
 * `TASK_OPENED` found `ctx.manifest === null` and threw "manifest/keys missing (DEPLOYED did not
 * run)", and `AGENTS_RUNNING` threw "missing prior stage output", so no checkpoint at or after
 * `DEPLOYED` could ever be resumed and `findExistingProposal` was unreachable from `fleet run`.
 *
 * Nothing here is trusted from the payload beyond identifiers: the manifest is re-read from disk
 * and re-validated, the addresses and client are rebuilt from it, and the keys are re-read from
 * the environment. `taskId` is the one carried value, and `TASK_OPENED` verifies it exists on
 * chain before using it.
 */
export function rehydrateRunCtx(
  ctx: RunPipelineCtx,
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): RunPipelineCtx {
  const chainId = typeof payload["chainId"] === "number" ? payload["chainId"] : null;
  // `timings` is restored by `runStages` itself (it owns the object it fills in), not here.
  const manifestOutPath =
    typeof payload["manifestOutPath"] === "string"
      ? payload["manifestOutPath"]
      : chainId !== null
        ? manifestPathsForRun(ctx.opts.deploymentsDir, chainId, ctx.opts.runId).latest
        : null;

  let manifest: ManifestV1Type | null = null;
  if (manifestOutPath !== null && existsSync(manifestOutPath)) {
    const parsed = ManifestV1.safeParse(JSON.parse(readFileSync(manifestOutPath, "utf8")));
    if (parsed.success) manifest = parsed.data;
  }

  const addresses = manifest ? addressesFromManifest(manifest) : null;
  const client = manifest && addresses
    ? new FleetClient({ rpcUrl: ctx.experiment.target.rpcHttp, chainId: manifest.chainId, addresses })
    : null;

  const rawTaskId = payload["taskId"];
  const taskId = typeof rawTaskId === "string" && rawTaskId.length > 0 ? BigInt(rawTaskId) : null;

  // Keys never round trip through the checkpoint (a run record is written to Postgres or a file
  // next to the report; no private key belongs in either), so they are always re-read from the
  // environment, exactly as PREFLIGHT reads them.
  const keys = loadRunKeysFromEnv(env, ctx.experiment.fleet.members.length);

  return { ...ctx, chainId, manifestOutPath, manifest, addresses, client, keys, taskId };
}

function requireChainId(ctx: RunPipelineCtx, stage: StageName): number {
  if (ctx.chainId === null) throw new Error(`${stage}: chain id unknown (CHAIN_READY did not run)`);
  return ctx.chainId;
}

function requireManifestPath(ctx: RunPipelineCtx, stage: StageName): string {
  if (ctx.manifestOutPath === null) throw new Error(`${stage}: manifest path unknown (CHAIN_READY did not run)`);
  return ctx.manifestOutPath;
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

      const keys = loadRunKeysFromEnv(env, ctx.experiment.fleet.members.length);
      const readSideEnabled = ctx.opts.readSide === true;

      const publicClient = createPublicClient({ transport: http(ctx.experiment.target.rpcHttp) });
      const keyAddresses: { label: string; address: Address }[] = [
        { label: "deployer", address: privateKeyToAccount(keys.deployerKey).address },
        { label: "operator", address: privateKeyToAccount(keys.operatorKey).address },
        { label: "guardian", address: privateKeyToAccount(keys.guardianKey).address },
        { label: "keeper", address: privateKeyToAccount(keys.keeperKey).address },
        ...Object.entries(keys.agentKeys).map(([id, key]) => ({ label: `agent${id}`, address: privateKeyToAccount(key).address })),
      ];

      // The manifest path depends on the chain id, which CHAIN_READY has not read yet, so look
      // where a deployment for the configured target would already be: the experiment's own
      // `target.kind` fixes that chain id (final review I2), and the RPC is checked against it
      // below.
      const targetChainId = chainIdForKind(ctx.experiment.target.kind);
      const existingManifestPath = manifestPathsForRun(ctx.opts.deploymentsDir, targetChainId, ctx.opts.runId).latest;
      let existingManifestChainId: number | undefined;
      if (existsSync(existingManifestPath)) {
        try {
          const parsed = ManifestV1.safeParse(JSON.parse(readFileSync(existingManifestPath, "utf8")));
          if (parsed.success) existingManifestChainId = parsed.data.chainId;
        } catch {
          // an unreadable or invalid existing manifest is DEPLOYED's problem, not PREFLIGHT's
        }
      }

      const preflightOpts: Parameters<typeof runPreflight>[0] = {
        deps: defaultPreflightDeps({
          getChainId: () => publicClient.getChainId(),
          getBalanceWei: (address) => publicClient.getBalance({ address }),
        }),
        readSideEnabled,
        keyAddresses,
        expectedChainId: targetChainId,
        ...(existingManifestChainId !== undefined ? { existingManifestChainId } : {}),
      };
      if (readSideEnabled) {
        const envPath = path.join(ctx.opts.infraDir, ".env");
        const envText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
        const daoNodePort = readEnvValue(envText, "DAO_NODE_PORT", "8000");
        const cplsPort = readEnvValue(envText, "CPLS_PORT", "8001");
        const agoraNextPort = readEnvValue(envText, "AGORA_NEXT_PORT", "3000");
        const fakeGcsPort = readEnvValue(envText, "FAKE_GCS_PORT", "4443");
        const bucket = readEnvValue(envText, "GCS_BUCKET_NAME", "fleet-archive-dev");
        const offline = readEnvValue(envText, "GCS_CREDENTIALS_FILE", "") === "";
        preflightOpts.readSide = {
          daoNodeUrl: `http://localhost:${daoNodePort}`,
          cplsUrl: `http://localhost:${cplsPort}`,
          agoraNextUrl: `http://localhost:${agoraNextPort}`,
        };
        preflightOpts.bucketCheckUrl = offline
          ? `http://localhost:${fakeGcsPort}/storage/v1/b/${bucket}/o`
          : `https://storage.googleapis.com/storage/v1/b/${bucket}/o`;
      }

      const report = await runPreflight(preflightOpts);
      for (const check of report.checks) {
        log(ctx, `preflight: [${check.ok ? "ok" : "FAIL"}] ${check.name}: ${check.detail}`);
      }
      if (!report.ok) {
        throw new Error(`preflight failed:\n${formatPreflightReport(report)}`);
      }

      return { ...ctx, keys };
    },

    CHAIN_READY: async (ctx) => {
      // A plain viem client rather than a `FleetClient`: no fleet is deployed yet, so there are no
      // addresses to give one, and `FleetClient`'s constructor now refuses a chain outside the v1
      // allowlist (final review I2/M7), which a placeholder chain id of 0 would trip.
      const probe = createPublicClient({ transport: http(ctx.experiment.target.rpcHttp) });
      const chainId = await probe.getChainId();
      const expected = chainIdForKind(ctx.experiment.target.kind);
      assertAllowedChain(chainId);
      if (chainId !== expected) {
        throw new Error(
          `CHAIN_READY: ${ctx.experiment.target.rpcHttp} reports chainId ${chainId}, but target.kind "${ctx.experiment.target.kind}" means chainId ${expected}`,
        );
      }
      const { latest } = manifestPathsForRun(ctx.opts.deploymentsDir, chainId, ctx.opts.runId);
      log(ctx, `chain ready: ${ctx.experiment.target.rpcHttp} reports chainId ${chainId}; manifest path ${latest}`);
      return { ...ctx, chainId, manifestOutPath: latest };
    },

    DEPLOYED: async (ctx) => {
      // PREFLIGHT always runs first (it is the first stage; runStages only ever resumes strictly
      // after it) and already loaded and balance-checked every key, including the deployer's.
      const keys = ctx.keys ?? loadRunKeysFromEnv(env, ctx.experiment.fleet.members.length);
      const chainId = requireChainId(ctx, "DEPLOYED");
      const { latest, perRun } = manifestPathsForRun(ctx.opts.deploymentsDir, chainId, ctx.opts.runId);
      const configPath = path.join(ctx.opts.configDir, `${ctx.experiment.name}.deploy.json`);
      const { manifest, deployed } = await deployFleet({
        contractsDir: ctx.opts.contractsDir,
        configPath,
        rpcUrl: ctx.experiment.target.rpcHttp,
        deployerKey: keys.deployerKey,
        outPath: latest,
        expectedChainId: chainId,
      });
      // The per-run copy is byte-identical to `latest.json` and never overwritten by a later run,
      // so `record.json`'s manifest can always be matched back to a file on disk (final review I8).
      mkdirSync(path.dirname(perRun), { recursive: true });
      writeFileSync(perRun, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      log(ctx, `deployed: ${deployed ? "ran forge script" : "reused existing manifest"} at ${latest} (run copy ${perRun})`);
      return { ...ctx, manifest, keys, manifestOutPath: latest };
    },

    VERIFIED: async (ctx) => {
      await verifyDeployment({ contractsDir: ctx.opts.contractsDir, manifestPath: requireManifestPath(ctx, "VERIFIED"), rpcUrl: ctx.experiment.target.rpcHttp });
      log(ctx, "verified: VerifyDeployment.s.sol reported VERIFIED");
      return ctx;
    },

    INDEXERS_READY: async (ctx) => {
      await readside({
        manifestPath: requireManifestPath(ctx, "INDEXERS_READY"),
        infraDir: ctx.opts.infraDir,
        abiSourceDir: ctx.opts.abiSourceDir,
        deploymentsDir: ctx.opts.deploymentsDir,
        restart: ctx.opts.readSide === true,
        log: (m) => log(ctx, m),
      });
      return ctx;
    },

    TASK_OPENED: async (ctx) => {
      if (!ctx.manifest || !ctx.keys) throw new Error("TASK_OPENED: manifest/keys missing (DEPLOYED did not run)");
      const addresses = addressesFromManifest(ctx.manifest);
      const client = new FleetClient({ rpcUrl: ctx.experiment.target.rpcHttp, chainId: ctx.manifest.chainId, addresses });

      // Spec 12.2: "Each stage is idempotent and resumable by run ID". `openTask` has no natural
      // key on chain, so re-entering this stage with a task already opened for this run id would
      // open a second one and leave every later stage driving the wrong task (final review I1).
      // The run's own checkpoint is the record that it happened; the chain is what confirms it.
      if (ctx.taskId !== null) {
        const existingTask = await client.getTask(ctx.taskId);
        if (existingTask.id !== ctx.taskId) {
          throw new Error(`TASK_OPENED: run payload names task ${ctx.taskId.toString()}, which does not exist on chain`);
        }
        log(ctx, `task opened: ${ctx.taskId.toString()} already exists for this run, not opening another`);
        return { ...ctx, addresses, client };
      }

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
      const readSideSyncHandle = ctx.opts.readSide ? buildReadSideSyncConfig(ctx.opts.infraDir) : null;
      try {
        const fixtureCtx: FixtureRunContext = {
          client: ctx.client,
          rpcUrl: ctx.experiment.target.rpcHttp,
          chainId: ctx.manifest.chainId,
          addresses: ctx.addresses,
          keys: ctx.keys,
          feeLimits: parseSignerFeeLimits(env),
          submissionMarginSec: 20,
          log: (m) => log(ctx, m),
          ...(readSideSyncHandle ? { readSideSync: readSideSyncHandle.config } : {}),
          // Task 8 finding 1: persists a per-fixture sub-checkpoint (the proposal id, once known)
          // independent of the top-level stage checkpoint `runStages` writes only once this whole
          // stage function returns. `stage` here is deliberately "TASK_OPENED" (the last stage that
          // actually completed), not "AGENTS_RUNNING": writing "AGENTS_RUNNING" here would make
          // `runStages` treat this stage as already done on the next resume and skip it entirely,
          // when what a resume actually needs is for AGENTS_RUNNING to run again and find the
          // existing proposal itself (`findExistingProposal`) rather than re-submitting it.
          onProposalKnown: async (proposalId, txHash) => {
            await ctx.opts.store.save({
              runId: ctx.opts.runId,
              stage: "TASK_OPENED",
              updatedAt: new Date().toISOString(),
              payload: { ...toRunPayload(ctx), proposalIdInProgress: proposalId.toString(), proposalTxHash: txHash },
            });
          },
        };
        const result = await runFixture(fixtureCtx, fixture, ctx.taskId);
        log(ctx, `agents running: ${fixture.name} -> ${result.finalStateName} (${result.pass ? "PASS" : "FAIL"})`);
        return { ...ctx, result };
      } finally {
        if (readSideSyncHandle) await readSideSyncHandle.close();
      }
    },

    TASK_ENDED: async (ctx) => ctx,

    CAPTURED: async (ctx) => {
      if (!ctx.client || !ctx.manifest || !ctx.result) throw new Error("CAPTURED: missing prior stage output");
      const record = await buildRecord({
        client: ctx.client,
        runId: ctx.opts.runId,
        config: ctx.experiment,
        configHash: experimentConfigHash(ctx.experiment),
        manifest: ctx.manifest,
        results: [ctx.result],
        // Spec 12.4's "timings per stage". CAPTURED is itself still running, so its own span and
        // REPORTED's are not in the record it writes; every earlier stage's is.
        timings: { ...ctx.timings },
        versions: { node: process.version },
      });
      const runDir = path.join(ctx.opts.reportDir, ctx.opts.runId);
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
    chainId: ctx.chainId,
    manifestOutPath: ctx.manifestOutPath,
    manifestChainId: ctx.manifest?.chainId ?? null,
    taskId: ctx.taskId?.toString() ?? null,
    timings: ctx.timings,
    proposalId: ctx.result?.proposalId?.toString() ?? null,
    pass: ctx.result?.pass ?? null,
    recordPath: ctx.recordPath,
    reportPath: ctx.reportPath,
  };
}

export async function runExperiment(opts: RunPipelineOptions, env: NodeJS.ProcessEnv = process.env): Promise<RunPipelineCtx> {
  const experiment = loadExperiment(opts.experimentPath);
  const stages = buildRunStages(env);
  const timings: StageTimings = {};
  const initialCtx: RunPipelineCtx = {
    opts,
    experiment,
    chainId: null,
    manifestOutPath: null,
    timings,
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
  return runStages({
    runId: opts.runId,
    store: opts.store,
    stages,
    ctx: initialCtx,
    toPayload: toRunPayload,
    rehydrate: (ctx, payload) => rehydrateRunCtx(ctx, payload, env),
    timings,
  });
}
