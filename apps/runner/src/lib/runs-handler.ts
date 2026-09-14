import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ExperimentConfigV1 } from "@fleet/schemas";
import type { ExperimentConfigV1 as ExperimentConfigV1Type } from "@fleet/schemas";
import { RunnerEnvError } from "../env.js";
import { openUiRunStore } from "./db.js";
import { BASE_MAINNET_CHAIN_ID, CHAIN_ID_BY_TARGET_KIND, defaultChainIdProbe } from "./chain-probe.js";
import type { ChainIdProbe } from "./chain-probe.js";
import { buildDeployConfig } from "./deploy-config.js";
import { EXPERIMENT_NAME_PATTERN } from "./defaults.js";
import { loadRunnerEnv } from "./env.js";
import { repoRoot } from "./paths.js";
import { findMissingEnvVar, requiredEnvVarNames } from "./required-env.js";
import { LOCAL_ANVIL_CHAIN_ID } from "../pipeline/run-keys.js";
import { spawnRun } from "./spawn-run.js";
import type { SpawnFn } from "./spawn-run.js";

/**
 * The `POST /api/runs` handler's actual logic, kept out of `app/api/runs/route.ts` on purpose:
 * Next's generated route types (`.next/types/app/api/runs/route.ts`) reject any export from a
 * `route.ts` file other than the handful it recognizes (`GET`, `POST`, `dynamic`, ...), so a
 * second value export like this one fails `next build`'s typecheck step even though a plain `tsc
 * --noEmit` against `tsconfig.next.json` alone does not catch it (the generated file does not
 * exist until `next build` runs). `route.ts` only re-exports the thin `POST` wrapper;
 * `route.test.ts` imports `handleCreateRun` from here directly.
 */

export type ApiIssue = { path: string; message: string };
export type RunsErrorBody = { error: string; issues?: ApiIssue[] };
export type RunsSuccessBody = { runId: string; logPath: string };

export type RunsRouteDeps = {
  env: NodeJS.ProcessEnv;
  probeChainId: ChainIdProbe;
  now: () => number;
  /** The "filesystem root" every write and the spawned child's `cwd` are resolved against.
   *  Defaults to the real repo root; tests pass a temp directory instead. */
  repoRootDir: string;
  spawnFn?: SpawnFn;
  resolveTsxCli?: () => string;
};

export function defaultRunsRouteDeps(): RunsRouteDeps {
  loadRunnerEnv();
  return { env: process.env, probeChainId: defaultChainIdProbe, now: () => Date.now(), repoRootDir: repoRoot };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `POST /api/runs`'s full behavior (controller notes item 7): validate, probe the target chain,
 * check required keys are present, write `experiments/configs/<name>-<timestamp>.json` and
 * `deployments/configs/<name>.deploy.json`, insert the UI's own run row, spawn `fleet run`
 * detached, and return `{ runId, logPath }`. `deps` injects everything with a side effect (spawn,
 * the chain-id probe, the clock, and the filesystem root) so tests never spawn a real process,
 * make a real RPC call, or write outside a temp directory.
 */
export async function handleCreateRun(
  body: unknown,
  deps: RunsRouteDeps = defaultRunsRouteDeps(),
): Promise<{ status: number; body: RunsErrorBody | RunsSuccessBody }> {
  if (!isPlainObject(body) || !("config" in body)) {
    return { status: 400, body: { error: "request body must be a JSON object with a config field" } };
  }
  const readSide = body["readSide"] === true;

  const parsed = ExperimentConfigV1.safeParse(body["config"]);
  if (!parsed.success) {
    const issues: ApiIssue[] = parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
    return { status: 400, body: { error: "invalid experiment config", issues } };
  }
  const experiment: ExperimentConfigV1Type = parsed.data;

  if (!EXPERIMENT_NAME_PATTERN.test(experiment.name)) {
    return {
      status: 400,
      body: {
        error: "invalid experiment config",
        issues: [{ path: "name", message: "name must match ^[a-z0-9][a-z0-9-]{0,39}$ (it becomes file names)" }],
      },
    };
  }

  let chainId: number;
  try {
    chainId = await deps.probeChainId(experiment.target.rpcHttp);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 400, body: { error: `could not reach RPC ${experiment.target.rpcHttp}: ${message}` } };
  }
  if (chainId === BASE_MAINNET_CHAIN_ID) {
    return { status: 400, body: { error: "Base mainnet is not authorized in v0.1 (spec 16.4)" } };
  }
  const expectedChainId = CHAIN_ID_BY_TARGET_KIND[experiment.target.kind];
  if (chainId !== expectedChainId) {
    return {
      status: 400,
      body: {
        error: `target.kind "${experiment.target.kind}" expects chain id ${expectedChainId} but RPC ${experiment.target.rpcHttp} reports ${chainId}`,
      },
    };
  }

  const anyOpenRouter = experiment.fleet.members.some((member) => member.provider === "openrouter");
  const requiredNames = requiredEnvVarNames({ memberCount: experiment.fleet.members.length, anyOpenRouter });
  // On a local Anvil a missing private-key variable is not a blocker: `fleet run` falls back to
  // the well-known public dev account for that role, which is what lets a non-developer accept the
  // defaults and press Run. On every other chain a missing variable still refuses the run.
  const localAnvil = chainId === LOCAL_ANVIL_CHAIN_ID;
  const missing = findMissingEnvVar(requiredNames, deps.env, { localAnvil });
  if (missing) {
    return { status: 400, body: { error: `missing required environment variable ${missing}` } };
  }

  let deployConfig;
  try {
    deployConfig = buildDeployConfig(experiment, deps.env, { chainId });
  } catch (err) {
    if (err instanceof RunnerEnvError) return { status: 400, body: { error: err.message } };
    throw err;
  }

  const runId = `${experiment.name}-${deps.now()}`;

  const experimentsConfigsDir = path.join(deps.repoRootDir, "experiments", "configs");
  mkdirSync(experimentsConfigsDir, { recursive: true });
  const experimentPath = path.join(experimentsConfigsDir, `${runId}.json`);
  writeFileSync(experimentPath, `${JSON.stringify(experiment, null, 2)}\n`, "utf8");

  const deployConfigsDir = path.join(deps.repoRootDir, "deployments", "configs");
  mkdirSync(deployConfigsDir, { recursive: true });
  const deployConfigPath = path.join(deployConfigsDir, `${experiment.name}.deploy.json`);
  writeFileSync(deployConfigPath, `${JSON.stringify(deployConfig, null, 2)}\n`, "utf8");

  const { logPath, pid } = spawnRun({
    runId,
    experimentPath,
    readSide,
    repoRootDir: deps.repoRootDir,
    env: deps.env,
    ...(deps.spawnFn ? { spawnFn: deps.spawnFn } : {}),
    ...(deps.resolveTsxCli ? { resolveTsxCli: deps.resolveTsxCli } : {}),
  });

  const store = await openUiRunStore({
    pgUrl: deps.env["RUNNER_PG_URL"],
    reportsDir: path.join(deps.repoRootDir, "experiments", "reports"),
  });
  await store.insert({
    runId,
    experimentPath,
    deployConfigPath,
    logPath,
    pid,
    readSide,
    createdAt: new Date(deps.now()).toISOString(),
  });

  return { status: 202, body: { runId, logPath } };
}
