import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DeployConfigV1, ExperimentConfigV1 } from "@fleet/schemas";
import type { DeployConfigV1 as DeployConfigV1Type, ExperimentConfigV1 as ExperimentConfigV1Type, ManifestV1 as ManifestV1Type } from "@fleet/schemas";
import { loadManifest } from "../env.js";
import { readJsonRecord } from "../pipeline/record.js";
import type { RunRecordDocument } from "../pipeline/record.js";
import { RUN_FILES } from "../pipeline/runfiles.js";
import { openUiRunStore } from "./db.js";
import type { UiRunRow } from "./db.js";

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
  /** `record.manifest` when `record.json` exists (post-`CAPTURED`); otherwise
   *  `deployments/experiment-latest.json` (the one path `fleet run` writes today for every run,
   *  per `cli.ts`'s `run` command; see the task 6 report's Deviations). `null` when neither
   *  exists yet. */
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

function tryLoadManifestFromDisk(repoRootDir: string): ManifestV1Type | null {
  try {
    return loadManifest(path.join(repoRootDir, "deployments", "experiment-latest.json"));
  } catch {
    return null;
  }
}

export async function resolveRunContext(runId: string, repoRootDir: string, pgUrl: string | undefined): Promise<RunContext> {
  const runDir = path.join(repoRootDir, "experiments", "reports", runId);

  const uiStore = await openUiRunStore({ pgUrl, reportsDir: path.join(repoRootDir, "experiments", "reports") });
  const uiRow = (await uiStore.list()).find((r) => r.runId === runId) ?? null;

  const experimentPath = uiRow?.experimentPath ?? path.join(repoRootDir, "experiments", "configs", `${runId}.json`);
  const experiment = tryLoadExperiment(experimentPath);
  const deployConfigPath = uiRow?.deployConfigPath ?? (experiment ? path.join(repoRootDir, "deployments", "configs", `${experiment.name}.deploy.json`) : null);
  const deployConfig = tryLoadDeployConfig(deployConfigPath);

  const record = tryLoadRecord(runDir);
  const manifest = record?.manifest ?? tryLoadManifestFromDisk(repoRootDir);

  return { runId, runDir, uiRow, experiment, deployConfig, record, manifest };
}
