import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DeployConfigV1, ExperimentConfigV1, chainIdForKind } from "@fleet/schemas";
import type { DeployConfigV1 as DeployConfigV1Type, ExperimentConfigV1 as ExperimentConfigV1Type, ManifestV1 as ManifestV1Type } from "@fleet/schemas";
import { loadManifest } from "../env.js";
import { readJsonRecord } from "../pipeline/record.js";
import type { RunRecordDocument } from "../pipeline/record.js";
import { RUN_FILES } from "../pipeline/runfiles.js";
import type { UiRunRow } from "./db.js";
import { resolveConfinedRunDir } from "./run-id.js";
import { openUiRunStoreSafe } from "./safe-stores.js";

/**
 * The filesystem/UI-index lookups both `run-state.ts` and the guardian route need before either
 * can do anything chain-related: the run's own report directory, its `ui_runs` row (if the UI
 * itself started it), its `fleet.experiment.v1` config, its derived `fleet.deploy.v1`, its
 * `record.json` (once `CAPTURED` has run), and the deployment manifest it should read the chain
 * through. Centralized here so both callers resolve a run's identity the same way.
 */
export type RunContext = {
  runId: string;
  runDir: string;
  uiRow: UiRunRow | null;
  experiment: ExperimentConfigV1Type | null;
  deployConfig: DeployConfigV1Type | null;
  record: RunRecordDocument | null;
  /** `record.manifest` when `record.json` exists (post-`CAPTURED`); otherwise the manifest at
   *  `deployments/<chainId>/run-<runId>.json` or `deployments/<chainId>/latest.json` (fix round 1,
   *  F6; `chainId` from the experiment's own `target.kind`). `null` when none of those exist yet,
   *  or there is no experiment config to read a `target.kind` from. */
  manifest: ManifestV1Type | null;
};

function readFileIfExists(filePath: string): string | null {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
}

function tryLoadExperiment(experimentPath: string): ExperimentConfigV1Type | null {
  const text = readFileIfExists(experimentPath);
  if (!text) return null;
  const parsed = ExperimentConfigV1.safeParse(JSON.parse(text));
  return parsed.success ? parsed.data : null;
}

function tryLoadDeployConfig(deployConfigPath: string | null): DeployConfigV1Type | null {
  if (!deployConfigPath) return null;
  const text = readFileIfExists(deployConfigPath);
  if (!text) return null;
  const parsed = DeployConfigV1.safeParse(JSON.parse(text));
  return parsed.success ? parsed.data : null;
}

function tryLoadRecord(runDir: string): RunRecordDocument | null {
  const recordPath = path.join(runDir, RUN_FILES.record);
  if (!existsSync(recordPath)) return null;
  try {
    return readJsonRecord<RunRecordDocument>(recordPath);
  } catch {
    return null;
  }
}

function tryLoadManifestFile(manifestPath: string): ManifestV1Type | null {
  try {
    return loadManifest(manifestPath);
  } catch {
    return null;
  }
}

/** Mirrors `pipeline/run-pipeline.ts`'s `manifestPathsForRun` exactly: `<deploymentsDir>/<chainId>/
 *  latest.json` (the pointer, moved by whichever run deploys next) and `<deploymentsDir>/<chainId>/
 *  run-<runId>.json` (this run's own copy). Not imported from there on purpose: `run-pipeline.ts`
 *  transitively pulls in `pipeline/fixture-runner.ts`, which imports `@fleet/agent-runtime`'s full
 *  barrel (its Docker sandbox and worker modules), and that breaks `next build`'s page-data
 *  collection the same way `run-state.ts`'s Deviations already document for `PgJobStore` (a
 *  module-level `fileURLToPath(new URL(...))` deep in that barrel evaluated at build time). The
 *  duplication is deliberate, the same tradeoff `guardian.ts` already documents for
 *  `guardianPauseAndCancel`. */
function manifestPathsForRun(deploymentsDir: string, chainId: number, runId: string): { latest: string; perRun: string } {
  const dir = path.join(deploymentsDir, String(chainId));
  return { latest: path.join(dir, "latest.json"), perRun: path.join(dir, `run-${runId}.json`) };
}

/**
 * Resolves the manifest a still-running (pre-`CAPTURED`) run deployed against, from the
 * experiment's own chain id (fix round 1, F6): `fleet run` no longer writes a single fixed
 * `deployments/experiment-latest.json` (that path is dead); it writes the two paths
 * `manifestPathsForRun` above computes. Prefers the per-run copy, which stays this run's own
 * manifest even after a later run moves `latest.json` on. `null` when there is no experiment
 * config to read a `target.kind` from, or neither file exists yet.
 */
function tryResolveManifestForRun(repoRootDir: string, runId: string, experiment: ExperimentConfigV1Type | null): ManifestV1Type | null {
  if (!experiment) return null;
  const chainId = chainIdForKind(experiment.target.kind);
  const { latest, perRun } = manifestPathsForRun(path.join(repoRootDir, "deployments"), chainId, runId);
  return tryLoadManifestFile(perRun) ?? tryLoadManifestFile(latest);
}

export async function resolveRunContext(runId: string, repoRootDir: string, pgUrl: string | undefined): Promise<RunContext> {
  // Fix round 1, F1: defense in depth beyond every route's own `parseRunId` gate. A route already
  // rejects an invalid id with 400 before this ever runs; this backstop exists for any other
  // caller of `resolveRunContext` (a test, a future script) that might skip that gate. Throws
  // rather than returning an error shape, since a route never reaches this with an invalid id in
  // the first place; never echoes `runId` in the thrown message.
  const reportsDir = path.join(repoRootDir, "experiments", "reports");
  const runDir = resolveConfinedRunDir(reportsDir, runId);
  if (runDir === null) {
    throw new Error("invalid run id");
  }

  const uiStore = await openUiRunStoreSafe({ pgUrl, reportsDir });
  const uiRow = (await uiStore.list()).find((r) => r.runId === runId) ?? null;

  const experimentPath = uiRow?.experimentPath ?? path.join(repoRootDir, "experiments", "configs", `${runId}.json`);
  const experiment = tryLoadExperiment(experimentPath);
  const deployConfigPath = uiRow?.deployConfigPath ?? (experiment ? path.join(repoRootDir, "deployments", "configs", `${experiment.name}.deploy.json`) : null);
  const deployConfig = tryLoadDeployConfig(deployConfigPath) ?? tryLoadDeployConfig(path.join(runDir, "deploy.json"));

  const record = tryLoadRecord(runDir);
  const manifest = record?.manifest ?? tryResolveManifestForRun(repoRootDir, runId, experiment);

  return { runId, runDir, uiRow, experiment, deployConfig, record, manifest };
}
