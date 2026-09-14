import { readFileSync } from "node:fs";
import type { Hex } from "viem";
import { ManifestV1, assertAllowedChain } from "@fleet/schemas";
import type { ManifestV1 as ManifestV1Type } from "@fleet/schemas";

/** Thrown by `parseKeeperEnv`/`loadManifest` for any missing or malformed input. Never carries a
 *  secret value in its message (a missing or malformed `FLEET_KEEPER_KEY` is named by variable
 *  name only, never by value). */
export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}

export type KeeperEnv = {
  manifestPath: string;
  rpcHttpUrl: string;
  pgUrl: string | undefined;
  pollMs: number;
  logLevel: string;
  keeperKey: Hex;
  /** Spec 10.7's "configured fee limits", fed into `Keeper`'s own sends (the keeper is not an
   *  agent and does not go through `FleetSigner`). `undefined` means unbounded, which is what
   *  every app did before (final review M1). */
  maxFeePerGasWei: bigint | undefined;
  maxGas: bigint | undefined;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new EnvError(`missing required environment variable ${name}`);
  }
  return value;
}

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

function parsePrivateKey(name: string, value: string): Hex {
  if (!PRIVATE_KEY_PATTERN.test(value)) {
    throw new EnvError(`${name} must be a 0x-prefixed 32-byte (64 hex character) private key`);
  }
  return value as Hex;
}

function parsePollMs(env: NodeJS.ProcessEnv): number {
  const raw = optional(env, "FLEET_POLL_MS");
  if (raw === undefined) return 2000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new EnvError(`FLEET_POLL_MS must be a positive number of milliseconds, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/** Reads an optional positive integer of wei or gas. Rejects anything that is not a plain
 *  non-negative decimal integer rather than silently truncating a float or a hex string. */
function parseOptionalBigint(env: NodeJS.ProcessEnv, name: string): bigint | undefined {
  const raw = optional(env, name);
  if (raw === undefined) return undefined;
  if (!/^[0-9]+$/.test(raw.trim())) {
    throw new EnvError(`${name} must be a non-negative decimal integer, got ${JSON.stringify(raw)}`);
  }
  const parsed = BigInt(raw.trim());
  if (parsed <= 0n) {
    throw new EnvError(`${name} must be greater than zero, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/** Reads and validates the keeper's environment. Never touches the filesystem or the network;
 *  `loadManifest` below is the separate, explicit place that reads `FLEET_MANIFEST` off disk, so
 *  this function alone is cheaply unit-testable against a plain object. */
export function parseKeeperEnv(env: NodeJS.ProcessEnv = process.env): KeeperEnv {
  return {
    manifestPath: required(env, "FLEET_MANIFEST"),
    rpcHttpUrl: required(env, "FLEET_RPC_HTTP"),
    pgUrl: optional(env, "RUNNER_PG_URL"),
    pollMs: parsePollMs(env),
    logLevel: optional(env, "LOG_LEVEL") ?? "info",
    keeperKey: parsePrivateKey("FLEET_KEEPER_KEY", required(env, "FLEET_KEEPER_KEY")),
    maxFeePerGasWei: parseOptionalBigint(env, "FLEET_MAX_FEE_PER_GAS_WEI"),
    maxGas: parseOptionalBigint(env, "FLEET_MAX_GAS"),
  };
}

/** Reads `path`, parses it as JSON, and validates it against `ManifestV1`. Throws `EnvError` with
 *  the offending path (never the manifest's raw contents, which can be large) on any failure, and
 *  refuses a manifest for a chain v1 does not operate on (final review I2: nothing in the repo
 *  refused Base mainnet, so a manifest deployed there would drive a keeper with real keys). */
export function loadManifest(path: string): ManifestV1Type {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new EnvError(`could not read FLEET_MANIFEST at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new EnvError(`FLEET_MANIFEST at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const result = ManifestV1.safeParse(json);
  if (!result.success) {
    throw new EnvError(`FLEET_MANIFEST at ${path} does not parse as fleet.manifest.v1: ${result.error.message}`);
  }
  try {
    assertAllowedChain(result.data.chainId);
  } catch (err) {
    throw new EnvError(`FLEET_MANIFEST at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return result.data;
}
