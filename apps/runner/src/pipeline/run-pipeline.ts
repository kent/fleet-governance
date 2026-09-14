import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createPublicClient, http, keccak256, toHex } from "viem";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CharterV1, ExperimentConfigV1, ManifestV1, assertAllowedChain, canonicalize, chainIdForKind } from "@fleet/schemas";
import type {
  CharterV1 as CharterV1Type,
  ExperimentConfigV1 as ExperimentConfigV1Type,
  ManifestV1 as ManifestV1Type,
  ModelFixtureV1,
} from "@fleet/schemas";
import { FleetClient, addressesFromManifest } from "@fleet/sdk";
import type { FleetAddresses } from "@fleet/sdk";
import { deployFleet, verifyDeployment } from "../deploy.js";
import { RunnerEnvError, parseSignerFeeLimits } from "../env.js";
import { readEnvValue, readside } from "../readside.js";
import { assertScenarioMatchesFixture, isModelFixture, resolveFixture } from "./fixture-resolve.js";
import type { FixtureRunContext, FixtureRunResult, FleetKeys } from "./fixture-runner.js";
import { runFixture } from "./fixture-runner.js";
import { hostSitePath, runModelFixture } from "./model-runner.js";
import type { ModelRunContext, ModelRunResult } from "./model-runner.js";
import { defaultPreflightDeps, formatPreflightReport, runPreflight } from "./preflight.js";
import { buildReadSideSyncConfig } from "./readside-sync-config.js";
import { buildRecord, readJsonRecord, writeJsonRecord } from "./record.js";
import type { RunRecordDocument } from "./record.js";
import { renderReport } from "./report.js";
import type { RunStore, Stage, StageName, StageTimings } from "./state.js";
import { runStages } from "./state.js";
import { LOCAL_ANVIL_CHAIN_ID, loadRunKeysFromEnv } from "./run-keys.js";
import { openTask } from "./task.js";

/** Re-exported so `fleet run`'s callers keep one import site for key resolution, while the logic
 *  itself lives in a module the Next.js side can import without pulling in the whole pipeline. */
export { LOCAL_ANVIL_CHAIN_ID, loadRunKeysFromEnv } from "./run-keys.js";
export type { RunKeyOptions } from "./run-keys.js";

export type RunPipelineOptions = {
  runId: string;
  experimentPath: string;
  /** The fixtures *root* (`experiments/fixtures`), not one of its two subdirectories:
   *  `resolveFixture` looks under `scripted/` and then `model/`, so one `fleet run` can drive
   *  either kind depending on what the experiment's `scenario` names. */
  fixturesDir: string;
  /** Repository root, for resolving the repo, overlay, charter and host-site paths a model fixture
   *  names relative to it. */
  repoRoot: string;
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
  /** Test-only: builds a `Provider` per member for a model-driven run. Production leaves it unset
   *  and `runModelFixture` builds the real adapter each member's config names. */
  modelProviderFactory?: ModelRunContext["providerFactory"];
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
  result: FixtureRunResult | ModelRunResult | null;
  record: RunRecordDocument | null;
  recordPath: string | null;
  reportPath: string | null;
};

/** The chain id `rpcUrl` reports, or `null` when it cannot be read. Used only to decide whether
 *  the local-Anvil key fallback applies; an unreachable chain simply means no fallback, and
 *  PREFLIGHT's own `chain_id` check reports the unreachability itself. */
export async function probeChainId(rpcUrl: string): Promise<number | null> {
  try {
    return await createPublicClient({ transport: http(rpcUrl) }).getChainId();
  } catch {
    return null;
  }
}

/**
 * Where this run's `record.json` and `report.md` go. An explicit `--report-dir` always wins;
 * otherwise the experiment's own `capture.reportDir` decides, resolved against the repository root
 * when it is relative. Before this, `capture.reportDir` was dead config: `fleet run` always used
 * the CLI default, so the field could say anything and change nothing.
 */
export function resolveReportDir(opts: {
  explicit?: string | undefined;
  captureReportDir?: string | undefined;
  repoRoot: string;
  fallback: string;
}): string {
  if (opts.explicit) return path.resolve(opts.explicit);
  if (opts.captureReportDir && opts.captureReportDir.trim() !== "") {
    return path.resolve(opts.repoRoot, opts.captureReportDir);
  }
  return opts.fallback;
}

/** Reads `capture.reportDir` out of a `fleet.experiment.v1` file without failing a CLI invocation
 *  over a config the pipeline itself will parse and report on properly a moment later. */
export function readCaptureReportDir(experimentPath: string): string | undefined {
  try {
    const parsed = ExperimentConfigV1.safeParse(JSON.parse(readFileSync(experimentPath, "utf8")));
    return parsed.success ? parsed.data.capture.reportDir : undefined;
  } catch {
    return undefined;
  }
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
  // environment, exactly as PREFLIGHT reads them, including the local-Anvil fallback.
  const keys = loadRunKeysFromEnv(env, ctx.experiment.fleet.members.length, {
    chainId: manifest?.chainId ?? chainId,
    log: (m) => (ctx.opts.log ?? (() => {}))(m),
  });

  // Fix-wave finding 1: a resume past AGENTS_RUNNING used to reach CAPTURED and REPORTED with
  // `record`/`recordPath` still null and throw "missing prior stage output". The record is a file
  // in the run directory, so it is re-read from disk rather than carried through the checkpoint
  // (it contains bigint-derived values a JSON payload has no room for anyway).
  const recordPath =
    typeof payload["recordPath"] === "string" && payload["recordPath"].length > 0
      ? payload["recordPath"]
      : path.join(ctx.opts.reportDir, ctx.opts.runId, "record.json");
  const reportPath = typeof payload["reportPath"] === "string" && payload["reportPath"].length > 0 ? payload["reportPath"] : null;
  let record: RunRecordDocument | null = null;
  if (existsSync(recordPath)) {
    try {
      record = readJsonRecord<RunRecordDocument>(recordPath);
    } catch {
      // An unreadable record is CAPTURED's problem; it will rewrite it.
    }
  }

  return {
    ...ctx,
    chainId,
    manifestOutPath,
    manifest,
    addresses,
    client,
    keys,
    taskId,
    record,
    recordPath: record ? recordPath : null,
    reportPath,
  };
}

function requireChainId(ctx: RunPipelineCtx, stage: StageName): number {
  if (ctx.chainId === null) throw new Error(`${stage}: chain id unknown (CHAIN_READY did not run)`);
  return ctx.chainId;
}

function requireManifestPath(ctx: RunPipelineCtx, stage: StageName): string {
  if (ctx.manifestOutPath === null) throw new Error(`${stage}: manifest path unknown (CHAIN_READY did not run)`);
  return ctx.manifestOutPath;
}

/** The proposal a run payload names, for a resume and for the UI's own summary. A scripted run has
 *  exactly one; a model run has however many the fleet made, so this is the first of them, or null
 *  when the fleet never diverged. */
export function primaryProposalId(result: FixtureRunResult | ModelRunResult | null): string | null {
  if (!result) return null;
  if ("kind" in result && result.kind === "model") return result.proposals[0]?.proposalId.toString() ?? null;
  return (result as FixtureRunResult).proposalId.toString();
}

/** Reads and validates the charter file a model fixture names, relative to the repository root. */
export function loadFixtureCharter(repoRoot: string, fixture: ModelFixtureV1): CharterV1Type {
  const charterPath = path.resolve(repoRoot, fixture.charter);
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(charterPath, "utf8"));
  } catch (err) {
    throw new RunnerEnvError(
      `model fixture "${fixture.name}" names charter ${fixture.charter}, which could not be read at ${charterPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed = CharterV1.safeParse(json);
  if (!parsed.success) {
    throw new RunnerEnvError(`model fixture "${fixture.name}"'s charter at ${charterPath} does not parse as fleet.charter.v1: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Everything a model fixture needs on disk: its charter, its repository, its overlay if it has
 *  one, and one site directory per host it starts. Checked in PREFLIGHT, because a missing site
 *  directory would otherwise surface as a fake host exiting early ten minutes into a run. */
function assertModelFixturePaths(repoRoot: string, fixture: ModelFixtureV1): void {
  loadFixtureCharter(repoRoot, fixture);

  const repoDir = path.resolve(repoRoot, fixture.repoFixture);
  if (!existsSync(repoDir)) {
    throw new RunnerEnvError(`model fixture "${fixture.name}" names repoFixture ${fixture.repoFixture}, which does not exist at ${repoDir}`);
  }
  if (fixture.repoOverlay) {
    const overlayDir = path.resolve(repoRoot, fixture.repoOverlay);
    if (!existsSync(overlayDir)) {
      throw new RunnerEnvError(`model fixture "${fixture.name}" names repoOverlay ${fixture.repoOverlay}, which does not exist at ${overlayDir}`);
    }
  }
  for (const host of fixture.hosts) {
    const siteDir = hostSitePath(repoRoot, host.site);
    if (!existsSync(siteDir)) {
      throw new RunnerEnvError(`model fixture "${fixture.name}" names host ${host.name} with site "${host.site}", which does not exist at ${siteDir}`);
    }
  }
}

/** A model run with an `openrouter` member and no API key would start five agents, spawn the
 *  hosts, open nothing, and fail on the first inference. Refused in PREFLIGHT instead, naming the
 *  variable only, never a value. */
function assertModelProvidersConfigured(experiment: ExperimentConfigV1Type, env: NodeJS.ProcessEnv): void {
  const usesOpenRouter = experiment.fleet.members.some((m) => m.provider === "openrouter");
  if (usesOpenRouter && !env["OPENROUTER_API_KEY"]) {
    throw new RunnerEnvError(
      "this experiment configures at least one member with provider \"openrouter\", but OPENROUTER_API_KEY is not set (expected in the gitignored repo-root .env for local runs)",
    );
  }
}

/**
 * `AGENTS_RUNNING`, as its own function so CAPTURED can re-enter it on a resume that lost the
 * run's result. Branches on the fixture's own kind: a `fleet.fixture.v1` drives the scripted
 * proposal-and-votes path, a `fleet.fixture.model.v1` drives real agents.
 */
async function runAgentsStage(
  ctx: RunPipelineCtx,
  env: NodeJS.ProcessEnv,
  log: (ctx: RunPipelineCtx, message: string) => void,
): Promise<RunPipelineCtx> {
  if (!ctx.manifest || !ctx.addresses || !ctx.client || !ctx.keys || ctx.taskId === null) {
    throw new Error("AGENTS_RUNNING: missing prior stage output");
  }
  const { fixture } = resolveFixture(ctx.opts.fixturesDir, ctx.experiment.scenario.fixture, {
    prefer: ctx.experiment.scenario.agentsScripted ? "scripted" : "model",
  });
  const readSideSyncHandle = ctx.opts.readSide ? buildReadSideSyncConfig(ctx.opts.infraDir) : null;
  const runDir = path.join(ctx.opts.reportDir, ctx.opts.runId);

  // Task 8 finding 1: a per-proposal sub-checkpoint, written independently of the top-level stage
  // checkpoint `runStages` only writes once this whole stage returns. `stage` is deliberately
  // "TASK_OPENED" (the last stage that actually completed), not "AGENTS_RUNNING": writing the
  // latter would make `runStages` skip this stage entirely on the next resume, when what a resume
  // needs is for it to run again and find the existing proposals rather than re-submitting them.
  const onProposalKnown = async (proposalId: bigint, txHash: Hex): Promise<void> => {
    await ctx.opts.store.save({
      runId: ctx.opts.runId,
      stage: "TASK_OPENED",
      updatedAt: new Date().toISOString(),
      payload: { ...toRunPayload(ctx), proposalIdInProgress: proposalId.toString(), proposalTxHash: txHash },
    });
  };

  try {
    if (isModelFixture(fixture)) {
      const modelCtx: ModelRunContext = {
        client: ctx.client,
        rpcUrl: ctx.experiment.target.rpcHttp,
        chainId: ctx.manifest.chainId,
        addresses: ctx.addresses,
        keys: ctx.keys,
        members: ctx.experiment.fleet.members,
        governance: {
          votingDelay: ctx.manifest.params.votingDelay,
          votingPeriod: ctx.manifest.params.votingPeriod,
          timelockDelay: ctx.manifest.params.timelockDelay,
        },
        runDir,
        repoRoot: ctx.opts.repoRoot,
        feeLimits: parseSignerFeeLimits(env),
        submissionMarginSec: 20,
        env,
        log: (m) => log(ctx, m),
        onProposalKnown,
        ...(readSideSyncHandle ? { readSideSync: readSideSyncHandle.config } : {}),
        ...(ctx.opts.modelProviderFactory ? { providerFactory: ctx.opts.modelProviderFactory } : {}),
      };
      const result = await runModelFixture(modelCtx, fixture, ctx.taskId);
      log(
        ctx,
        `agents running: ${fixture.name} -> ${result.proposals.length} proposal(s) [${result.proposals.map((p) => p.finalStateName).join(", ")}] (${result.pass ? "PASS" : "FAIL"})`,
      );
      return { ...ctx, result };
    }

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
      onProposalKnown,
    };
    const result = await runFixture(fixtureCtx, fixture, ctx.taskId);
    log(ctx, `agents running: ${fixture.name} -> ${result.finalStateName} (${result.pass ? "PASS" : "FAIL"})`);
    return { ...ctx, result };
  } finally {
    if (readSideSyncHandle) await readSideSyncHandle.close();
  }
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

      // The RPC's own chain id, read before any key is resolved: the local-Anvil key fallback is
      // gated on what the chain says it is, never on what the config claims.
      const probedChainId = await probeChainId(ctx.experiment.target.rpcHttp);
      const keys = loadRunKeysFromEnv(env, ctx.experiment.fleet.members.length, {
        chainId: probedChainId,
        log: (m) => log(ctx, `preflight: ${m}`),
      });
      const readSideEnabled = ctx.opts.readSide === true;

      // The fixture, its kind, and everything a model fixture needs on disk, before a single
      // transaction is sent. Every one of these is unrecoverable at the point it would otherwise
      // be discovered: halfway through AGENTS_RUNNING, on a chain that already has a task open.
      const { fixture, filePath } = resolveFixture(ctx.opts.fixturesDir, ctx.experiment.scenario.fixture, {
        prefer: ctx.experiment.scenario.agentsScripted ? "scripted" : "model",
      });
      assertScenarioMatchesFixture(fixture, ctx.experiment.scenario.agentsScripted, ctx.experiment.scenario.fixture);
      log(ctx, `preflight: [ok] fixture: ${filePath} (${fixture.schema})`);
      if (isModelFixture(fixture)) {
        assertModelFixturePaths(ctx.opts.repoRoot, fixture);
        log(ctx, `preflight: [ok] model fixture assets: charter, repo${fixture.repoOverlay ? ", overlay" : ""}${fixture.hosts.length > 0 ? `, ${fixture.hosts.length} host site(s)` : ""}`);
        assertModelProvidersConfigured(ctx.experiment, env);
      }

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
      const chainId = requireChainId(ctx, "DEPLOYED");
      const keys = ctx.keys ?? loadRunKeysFromEnv(env, ctx.experiment.fleet.members.length, { chainId, log: (m) => log(ctx, m) });
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

      // A model fixture names its own charter file, and that file is what the fleet is judged
      // against: the fixture's expectations (an omitted `examples.internal`, a goal that points at
      // a host the allowlist does not carry) only mean anything if the task was opened with it.
      // The experiment's own `task.charter` is still the default for a scripted run.
      const { fixture } = resolveFixture(ctx.opts.fixturesDir, ctx.experiment.scenario.fixture, {
        prefer: ctx.experiment.scenario.agentsScripted ? "scripted" : "model",
      });
      let charter = ctx.experiment.task.charter;
      if (isModelFixture(fixture)) {
        charter = loadFixtureCharter(ctx.opts.repoRoot, fixture);
        if (canonicalize(charter) !== canonicalize(ctx.experiment.task.charter)) {
          log(
            ctx,
            `task opened: warning, the experiment's task.charter differs from model fixture "${fixture.name}"'s own charter file (${fixture.charter}); opening the task with the fixture's charter`,
          );
        }
      }

      const { taskId } = await openTask({
        client,
        addresses,
        chainId: ctx.manifest.chainId,
        rpcUrl: ctx.experiment.target.rpcHttp,
        operatorKey: ctx.keys.operatorKey,
        charter,
        lifetimeSeconds: ctx.experiment.task.lifetime,
      });
      log(ctx, `task opened: ${taskId.toString()}`);
      return { ...ctx, addresses, client, taskId };
    },

    AGENTS_RUNNING: (ctx) => runAgentsStage(ctx, env, log),

    TASK_ENDED: async (ctx) => ctx,

    CAPTURED: async (ctx) => {
      let current = ctx;
      if (!current.result) {
        // Fix-wave finding 1: a run that crashed between the AGENTS_RUNNING checkpoint and this
        // stage resumes here with no result in memory, and a result is not something a JSON
        // checkpoint can carry (it holds chain-scale integers and a whole decision trace).
        // AGENTS_RUNNING is idempotent by design (it finds the existing proposal rather than
        // submitting a second one), so the honest recovery is to re-enter it.
        log(current, "captured: no run result in memory (resumed run); re-entering AGENTS_RUNNING, which finds the existing proposals rather than making new ones");
        current = await runAgentsStage(current, env, log);
      }
      if (!current.client || !current.manifest || !current.result) throw new Error("CAPTURED: missing prior stage output");
      const runDir = path.join(current.opts.reportDir, current.opts.runId);
      const record = await buildRecord({
        client: current.client,
        runId: current.opts.runId,
        config: current.experiment,
        configHash: experimentConfigHash(current.experiment),
        manifest: current.manifest,
        results: [current.result],
        // Spec 12.4's "timings per stage". CAPTURED is itself still running, so its own span and
        // REPORTED's are not in the record it writes; every earlier stage's is.
        timings: { ...current.timings },
        versions: { node: process.version },
        runDir,
      });
      const recordPath = path.join(runDir, "record.json");
      writeJsonRecord(recordPath, record);
      log(current, `captured: wrote ${recordPath}`);
      return { ...current, record, recordPath };
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
    proposalId: primaryProposalId(ctx.result),
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
