import path from "node:path";
import type { Hex } from "viem";
import type { ManifestV1 as ManifestV1Type } from "@fleet/schemas";
import { InterventionLine, RUN_FILES, appendJsonl } from "../pipeline/runfiles.js";
import type { InterventionLineType } from "../pipeline/runfiles.js";
import { buildGuardianWallet, guardianCancel, guardianPause, guardianUnpause } from "../guardian.js";
import type { GuardianChainClient, GuardianWallet } from "../guardian.js";
import { buildFleetClientFromManifest } from "./chain.js";
import { loadRunnerEnv } from "./env.js";
import { repoRoot } from "./paths.js";
import { resolveRunContext } from "./run-context.js";

/**
 * `POST /api/runs/[id]/guardian` (spec 12.3: "guardian controls ... clearly labeled as human
 * interventions and logged"; task 6 controller notes). Actual logic kept out of `route.ts`, same
 * reason as `runs-handler.ts` (task 5): Next's generated route types reject any export besides the
 * HTTP method handlers.
 */

export type GuardianAction = "pause" | "unpause" | "cancel";
export type GuardianRequestBody = { action: GuardianAction; proposalId?: string };
export type GuardianRouteResult = { status: number; body: Record<string, unknown> };

export type GuardianRouteDeps = {
  repoRootDir: string;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  buildClient: (manifest: ManifestV1Type, rpcUrl: string) => GuardianChainClient;
  buildWallet: (opts: { rpcUrl: string; chainId: number; key: Hex }) => GuardianWallet;
};

export function defaultGuardianRouteDeps(): GuardianRouteDeps {
  loadRunnerEnv();
  return {
    repoRootDir: repoRoot,
    env: process.env,
    now: () => new Date(),
    buildClient: (manifest, rpcUrl) => buildFleetClientFromManifest(manifest, rpcUrl) as unknown as GuardianChainClient,
    buildWallet: (opts) => buildGuardianWallet(opts),
  };
}

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL_STRING_PATTERN = /^(0|[1-9][0-9]*)$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates and carries out one guardian action against the run named `runId`: pause or unpause
 * `TaskLedger`, or cancel a queued proposal's timelock operation. On success, appends one
 * `InterventionLine` to `experiments/reports/<runId>/interventions.jsonl` (task 6 controller
 * notes: "the live view reads the jsonl file directly"; `pipeline/record.ts` is not touched here,
 * task 7a generalizes it to read this file). Never returns `FLEET_GUARDIAN_KEY`'s value, in any
 * response body or error message.
 */
export async function handleGuardianAction(
  runId: string,
  body: unknown,
  deps: GuardianRouteDeps = defaultGuardianRouteDeps(),
): Promise<GuardianRouteResult> {
  if (!isPlainObject(body)) {
    return { status: 400, body: { error: "request body must be a JSON object" } };
  }
  const action = body["action"];
  if (action !== "pause" && action !== "unpause" && action !== "cancel") {
    return { status: 400, body: { error: 'action must be "pause", "unpause", or "cancel"' } };
  }

  const proposalIdRaw = body["proposalId"];
  if (action === "cancel") {
    if (typeof proposalIdRaw !== "string" || !DECIMAL_STRING_PATTERN.test(proposalIdRaw)) {
      return { status: 400, body: { error: "cancel requires proposalId as a non-negative decimal integer string" } };
    }
  }

  const key = deps.env["FLEET_GUARDIAN_KEY"];
  if (key === undefined || key === "") {
    return { status: 400, body: { error: "missing required environment variable FLEET_GUARDIAN_KEY" } };
  }
  if (!PRIVATE_KEY_PATTERN.test(key)) {
    return { status: 400, body: { error: "FLEET_GUARDIAN_KEY must be a 0x-prefixed 32-byte (64 hex character) private key" } };
  }

  const ctx = await resolveRunContext(runId, deps.repoRootDir, deps.env["RUNNER_PG_URL"]);
  if (!ctx.manifest) {
    return { status: 400, body: { error: `no deployment manifest found for run ${runId}` } };
  }
  if (!ctx.experiment) {
    return { status: 400, body: { error: `no experiment config found for run ${runId}` } };
  }

  const client = deps.buildClient(ctx.manifest, ctx.experiment.target.rpcHttp);
  const wallet = deps.buildWallet({ rpcUrl: ctx.experiment.target.rpcHttp, chainId: ctx.manifest.chainId, key: key as Hex });

  let result: { txHash: Hex; blockNumber: bigint; operationId?: Hex };
  try {
    if (action === "pause") {
      result = await guardianPause(client, wallet);
    } else if (action === "unpause") {
      result = await guardianUnpause(client, wallet);
    } else {
      result = await guardianCancel(client, wallet, BigInt(proposalIdRaw as string));
    }
  } catch (err) {
    return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
  }

  const intervention: InterventionLineType = {
    type: "human_intervention",
    at: deps.now().toISOString(),
    action,
    proposalId: action === "cancel" ? (proposalIdRaw as string) : null,
    txHash: result.txHash,
    blockNumber: result.blockNumber.toString(),
    actor: "guardian",
  };
  const parsedIntervention = InterventionLine.parse(intervention);
  appendJsonl(path.join(ctx.runDir, RUN_FILES.interventions), parsedIntervention);

  return {
    status: 200,
    body: {
      ok: true,
      action,
      txHash: result.txHash,
      blockNumber: result.blockNumber.toString(),
      ...(result.operationId ? { operationId: result.operationId } : {}),
    },
  };
}
