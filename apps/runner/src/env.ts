import { readFileSync } from "node:fs";
import type { Hex } from "viem";
import { ManifestV1, assertAllowedChain } from "@fleet/schemas";
import type { ManifestV1 as ManifestV1Type } from "@fleet/schemas";

/** Thrown by every env/file-loading helper in this file. Never carries a secret value in its
 *  message (a missing or malformed key is named by variable name only, never by value), matching
 *  `apps/worker/src/env.ts`'s `EnvError`. */
export class RunnerEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerEnvError";
  }
}

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** Reads `name` out of `env`, requires it to be a 0x-prefixed 32-byte private key, and returns it
 *  typed as `Hex`. Throws `RunnerEnvError` naming `name` (never the value) on any failure. */
export function requirePrivateKeyEnv(env: NodeJS.ProcessEnv, name: string): Hex {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new RunnerEnvError(`missing required environment variable ${name}`);
  }
  if (!PRIVATE_KEY_PATTERN.test(value)) {
    throw new RunnerEnvError(`${name} must be a 0x-prefixed 32-byte (64 hex character) private key`);
  }
  return value as Hex;
}

/** Reads and validates a `fleet.manifest.v1` file off disk. Throws `RunnerEnvError` with the
 *  offending path (never the manifest's raw contents) on any failure, and refuses a manifest for a
 *  chain v1 does not operate on (final review I2). */
export function loadManifest(path: string): ManifestV1Type {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new RunnerEnvError(`could not read manifest at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new RunnerEnvError(`manifest at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const result = ManifestV1.safeParse(json);
  if (!result.success) {
    throw new RunnerEnvError(`manifest at ${path} does not parse as fleet.manifest.v1: ${result.error.message}`);
  }
  try {
    assertAllowedChain(result.data.chainId);
  } catch (err) {
    throw new RunnerEnvError(`manifest at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return result.data;
}
