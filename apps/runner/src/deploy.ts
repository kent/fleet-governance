import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Hex } from "viem";
import { keccak256, toHex } from "viem";
import { ManifestV1 } from "@fleet/schemas";
import type { ManifestV1 as ManifestV1Type } from "@fleet/schemas";
import { RunnerEnvError } from "./env.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readManifestFile(filePath: string): ManifestV1Type {
  const raw = readFileSync(filePath, "utf8");
  const result = ManifestV1.safeParse(JSON.parse(raw));
  if (!result.success) {
    throw new RunnerEnvError(`manifest at ${filePath} does not parse as fleet.manifest.v1: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Deploys the fleet by shelling out to `forge script script/DeployFleet.s.sol` from `contractsDir`
 * (task 8 controller notes), writing the manifest to `outPath`. Idempotent: if `outPath` already
 * holds a manifest whose `configHash` matches `keccak256(bytes(<configPath's raw text>))` and
 * whose `chainId` matches `expectedChainId` (when given), the existing manifest is returned
 * unchanged and forge is never invoked.
 *
 * `FLEET_MANIFEST_OUT` is written to a scratch file inside `contractsDir` first (forge's own
 * `fs_permissions` in `contracts/foundry.toml` only allow writes under `contracts/` itself and
 * `../deployments`, matching `docs/compatibility-notes.md`'s "forge script cannot write straight
 * into the worktree"), then copied to `outPath` with plain Node `fs` (not subject to forge's
 * sandbox) and the scratch file removed, so `outPath` can be anywhere the caller wants (including
 * a test's temp directory).
 */
export async function deployFleet(opts: {
  contractsDir: string;
  configPath: string;
  rpcUrl: string;
  deployerKey: Hex;
  outPath: string;
  expectedChainId?: number;
  /** Wait for each deployment receipt before sending the next batch. */
  sequentialBroadcast?: boolean;
}): Promise<{ manifest: ManifestV1Type; deployed: boolean }> {
  const configRaw = readFileSync(opts.configPath, "utf8");
  const configHash = keccak256(toHex(configRaw));

  if (existsSync(opts.outPath)) {
    try {
      const existing = readManifestFile(opts.outPath);
      const chainOk = opts.expectedChainId === undefined || existing.chainId === opts.expectedChainId;
      if (existing.configHash.toLowerCase() === configHash.toLowerCase() && chainOk) {
        return { manifest: existing, deployed: false };
      }
    } catch {
      // Not a valid existing manifest (or a stale/partial one); fall through and redeploy.
    }
  }

  const scratchName = `.fleet-manifest-tmp-${process.pid}-${Date.now()}.json`;
  const scratchPath = path.join(opts.contractsDir, scratchName);
  rmSync(scratchPath, { force: true });

  try {
    execFileSync("forge", ["script", "script/DeployFleet.s.sol", "--rpc-url", opts.rpcUrl, "--broadcast", ...(opts.sequentialBroadcast !== false ? ["--slow"] : [])], {
      cwd: opts.contractsDir,
      env: {
        ...process.env,
        FLEET_DEPLOY_CONFIG: path.resolve(opts.configPath),
        FLEET_DEPLOYER_KEY: opts.deployerKey,
        FLEET_MANIFEST_OUT: scratchName,
      },
      stdio: "pipe",
    });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
    const stdout = (err as { stdout?: Buffer }).stdout?.toString() ?? "";
    rmSync(scratchPath, { force: true });
    throw new Error(`forge script DeployFleet.s.sol failed: ${errorMessage(err)}\n${stdout}\n${stderr}`);
  }

  const manifest = readManifestFile(scratchPath);
  mkdirSync(path.dirname(opts.outPath), { recursive: true });
  writeFileSync(opts.outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  rmSync(scratchPath, { force: true });

  return { manifest, deployed: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runVerifyOnce(opts: { contractsDir: string; manifestPath: string; rpcUrl: string }): string {
  return execFileSync("forge", ["script", "script/VerifyDeployment.s.sol", "--rpc-url", opts.rpcUrl], {
    cwd: opts.contractsDir,
    env: { ...process.env, FLEET_MANIFEST: path.resolve(opts.manifestPath) },
    stdio: "pipe",
  }).toString();
}

/**
 * Verifies a deployed fleet by shelling out to `forge script script/VerifyDeployment.s.sol`
 * (a view-only script; no `--broadcast`), which reverts with a descriptive `require` message on
 * the first failed post-condition and otherwise prints `VERIFIED`. Returns normally only when
 * `VERIFIED` appears in stdout; throws (with the script's own stdout/stderr) otherwise.
 *
 * One of the script's own checks has a timing precondition (`VerifyDeployment.s.sol`'s own doc
 * comment: per-member voting power needs the token clock to have moved past the deployment
 * block/timestamp) and deliberately reverts asking the caller to retry rather than skip it, so
 * this retries a few times with a short delay before giving up, matching that script's stated
 * expectation.
 */
export async function verifyDeployment(opts: { contractsDir: string; manifestPath: string; rpcUrl: string }): Promise<void> {
  const maxAttempts = 5;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const stdout = runVerifyOnce(opts);
      if (!stdout.includes("VERIFIED")) {
        throw new Error(`VerifyDeployment.s.sol did not print VERIFIED:\n${stdout}`);
      }
      return;
    } catch (err) {
      lastErr = err;
      const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
      const out = (err as { stdout?: Buffer }).stdout?.toString() ?? "";
      const combined = `${out}\n${stderr}`;
      const isRetryableTiming = combined.includes("clock has not advanced past deployment");
      if (!isRetryableTiming || attempt === maxAttempts) {
        throw new Error(`forge script VerifyDeployment.s.sol failed: ${errorMessage(err)}\n${combined}`);
      }
      await sleep(1500);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** A scratch directory under the OS temp dir, for callers (tests, `fleet demo --fresh-anvil`)
 *  that need a disposable manifest output path. Caller is responsible for removing it. */
export function makeScratchDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}
