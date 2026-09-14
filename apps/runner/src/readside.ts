import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ManifestV1 } from "@fleet/schemas";
import { RunnerEnvError } from "./env.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Reads one `KEY=value` line out of a dotenv-style file's text, tolerant of surrounding quotes.
 *  The last occurrence of `key` wins, matching Compose's own precedence and
 *  `infra/scripts/env-lib.sh`'s `read_env_value`. Returns `fallback` when the file has no such
 *  key (or does not exist). */
export function readEnvValue(envText: string, key: string, fallback: string): string {
  const pattern = new RegExp(`^\\s*${key}=(.*)$`, "gm");
  let match: RegExpExecArray | null;
  let last: string | undefined;
  while ((match = pattern.exec(envText)) !== null) {
    last = match[1];
  }
  if (last === undefined) return fallback;
  const trimmed = last.trim();
  if (trimmed.length === 0) return fallback;
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Sets (or appends) one `KEY=value` line in a dotenv-style file's text, preserving every other
 *  line byte-for-byte, matching `infra/scripts/write-daonode-config.sh`'s `set_env_var`. */
export function setEnvValue(envText: string, key: string, value: string): string {
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(envText)) {
    return envText.replace(pattern, `${key}=${value}`);
  }
  const withNewline = envText.length > 0 && !envText.endsWith("\n") ? `${envText}\n` : envText;
  return `${withNewline}${key}=${value}\n`;
}

export type ReadsideResult = {
  manifest: ReturnType<typeof ManifestV1.parse>;
  envFile: string;
  tokenAbiFile: string;
  governorAbiFile: string;
  agoraNextDeploymentFile: string;
  restarted: boolean;
};

/**
 * Implements in TypeScript what Part 2's `infra/scripts/write-daonode-config.sh` and
 * `write-agora-next-deployment.sh` do (task 8 controller notes: "do not shell out to them"):
 * parse the manifest, write `infra/.env`'s `TOKEN_ADDRESS`/`GOVERNOR_ADDRESS`/
 * `DAO_NODE_START_BLOCK` (preserving every other key), copy `FleetVotes.json` and
 * `AgoraGovernor.json` to `infra/dao-node/abis/<lowercase address>.json`, and write
 * `deployments/agora-next-deployment.json`. Idempotent: safe to re-run against the same or a new
 * manifest, always rewriting all of the above.
 *
 * With `restart: true`, also runs `docker compose ... up -d --force-recreate dao-node cpls` (no
 * `--build`) and waits on DAO Node's `/v1/progress` and CPLS's `/health`, creating the fake GCS
 * bucket first when the offline overlay is in use (`GCS_CREDENTIALS_FILE` unset). This task does
 * not exercise that path (no Docker in this task's own tests); it is verified by hand once the
 * Part 2 infra is merged, per the task brief's M2 acceptance.
 */
export async function readside(opts: {
  manifestPath: string;
  infraDir: string;
  abiSourceDir: string;
  deploymentsDir: string;
  restart?: boolean;
  log?: (message: string) => void;
}): Promise<ReadsideResult> {
  const log = opts.log ?? (() => {});

  let manifestRaw: string;
  try {
    manifestRaw = readFileSync(opts.manifestPath, "utf8");
  } catch (err) {
    throw new RunnerEnvError(`could not read manifest at ${opts.manifestPath}: ${errorMessage(err)}`);
  }
  const parsed = ManifestV1.safeParse(JSON.parse(manifestRaw));
  if (!parsed.success) {
    throw new RunnerEnvError(`manifest at ${opts.manifestPath} does not parse as fleet.manifest.v1: ${parsed.error.message}`);
  }
  const manifest = parsed.data;

  // 1. infra/.env: TOKEN_ADDRESS, GOVERNOR_ADDRESS, DAO_NODE_START_BLOCK, preserving every other key.
  const envFile = path.join(opts.infraDir, ".env");
  const envExample = path.join(opts.infraDir, ".env.example");
  let envText = existsSync(envFile) ? readFileSync(envFile, "utf8") : existsSync(envExample) ? readFileSync(envExample, "utf8") : "";
  envText = setEnvValue(envText, "TOKEN_ADDRESS", manifest.addresses.token);
  envText = setEnvValue(envText, "GOVERNOR_ADDRESS", manifest.addresses.governor);
  envText = setEnvValue(envText, "DAO_NODE_START_BLOCK", String(manifest.deploymentBlock));
  mkdirSync(opts.infraDir, { recursive: true });
  writeFileSync(envFile, envText, "utf8");
  log(
    `readside: wrote TOKEN_ADDRESS=${manifest.addresses.token} GOVERNOR_ADDRESS=${manifest.addresses.governor} ` +
      `DAO_NODE_START_BLOCK=${manifest.deploymentBlock} to ${envFile}`,
  );

  // 2. ABI files, address-named, lowercase (Address already normalizes to lowercase at parse time).
  const abiDestDir = path.join(opts.infraDir, "dao-node", "abis");
  mkdirSync(abiDestDir, { recursive: true });
  const tokenAbiFile = path.join(abiDestDir, `${manifest.addresses.token}.json`);
  const governorAbiFile = path.join(abiDestDir, `${manifest.addresses.governor}.json`);
  // FleetVotes.json over the abstract ERC20Votes.json it extends (docs/compatibility-notes.md).
  copyFileSync(path.join(opts.abiSourceDir, "FleetVotes.json"), tokenAbiFile);
  copyFileSync(path.join(opts.abiSourceDir, "AgoraGovernor.json"), governorAbiFile);
  log(`readside: wrote ABIs to ${tokenAbiFile} and ${governorAbiFile}`);

  // 3. deployments/agora-next-deployment.json
  const agoraNextDeploymentFile = path.join(opts.deploymentsDir, "agora-next-deployment.json");
  mkdirSync(opts.deploymentsDir, { recursive: true });
  const agoraNextDeployment = {
    chainId: manifest.chainId,
    governor: manifest.addresses.governor,
    token: manifest.addresses.token,
    timelock: manifest.addresses.timelock,
    ledger: manifest.addresses.ledger,
    hook: manifest.addresses.hook,
    registry: manifest.addresses.registry,
  };
  writeFileSync(agoraNextDeploymentFile, `${JSON.stringify(agoraNextDeployment, null, 2)}\n`, "utf8");
  log(`readside: wrote ${agoraNextDeploymentFile}`);

  let restarted = false;
  if (opts.restart) {
    restarted = true;
    const composeFiles = ["-f", path.join(opts.infraDir, "docker-compose.yml")];
    const gcsCredentialsFile = readEnvValue(envText, "GCS_CREDENTIALS_FILE", "");
    const offline = gcsCredentialsFile === "";
    if (offline) {
      composeFiles.push("-f", path.join(opts.infraDir, "docker-compose.offline.yml"));
    }
    log(`readside: restarting dao-node and cpls (${offline ? "offline overlay" : "real GCS"})`);
    execFileSync("docker", ["compose", ...composeFiles, "--project-directory", opts.infraDir, "up", "-d", "--force-recreate", "dao-node", "cpls"], {
      stdio: "pipe",
    });

    const daoNodePort = readEnvValue(envText, "DAO_NODE_PORT", "8000");
    const cplsPort = readEnvValue(envText, "CPLS_PORT", "8001");
    await waitForHttp(`http://localhost:${daoNodePort}/v1/progress`, log, "DAO Node /v1/progress");
    await waitForHttp(`http://localhost:${cplsPort}/health`, log, "CPLS /health");

    if (offline) {
      const fakeGcsPort = readEnvValue(envText, "FAKE_GCS_PORT", "4443");
      const bucket = readEnvValue(envText, "GCS_BUCKET_NAME", "fleet-archive-dev");
      await createFakeBucket(`http://localhost:${fakeGcsPort}`, bucket, log);
    }
  }

  return { manifest, envFile, tokenAbiFile, governorAbiFile, agoraNextDeploymentFile, restarted };
}

async function waitForHttp(url: string, log: (message: string) => void, description: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        log(`readside: ${description} is ready`);
        return;
      }
    } catch {
      // not ready yet; fall through to retry
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`readside: timed out after ${timeoutMs}ms waiting for ${description} at ${url}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/** Mirrors `infra/scripts/create-fake-bucket.sh`: idempotent, tolerates "already exists". */
async function createFakeBucket(host: string, bucket: string, log: (message: string) => void): Promise<void> {
  const res = await fetch(`${host}/storage/v1/b?project=fleet`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: bucket }),
  });
  if (res.ok) {
    log(`readside: created fake GCS bucket ${bucket}`);
    return;
  }
  const body = await res.text();
  if (/exist/i.test(body)) {
    log(`readside: fake GCS bucket ${bucket} already exists, continuing`);
    return;
  }
  throw new Error(`readside: failed to create fake GCS bucket ${bucket} (HTTP ${res.status}): ${body}`);
}
