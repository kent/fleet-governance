import { readFileSync } from "node:fs";
import type { Hex } from "viem";
import { ManifestV1, assertAllowedChain } from "@fleet/schemas";
import type { ManifestV1 as ManifestV1Type } from "@fleet/schemas";
import type { ScriptedDirective } from "@fleet/agent-runtime";

/** Thrown by `parseWorkerEnv`/`loadManifest` for any missing or malformed input. Never carries a
 *  secret value in its message (a missing or malformed `FLEET_AGENT_KEY` is named by variable
 *  name only, never by value). */
export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}

export type WorkerEnv = {
  manifestPath: string;
  rpcHttpUrl: string;
  pgUrl: string | undefined;
  pollMs: number;
  logLevel: string;
  agentId: number;
  agentKey: Hex;
  policyDirective: ScriptedDirective;
  submissionMarginSec: number;
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

function parseAgentId(env: NodeJS.ProcessEnv): number {
  const raw = required(env, "FLEET_AGENT_ID");
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new EnvError(`FLEET_AGENT_ID must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function parseSubmissionMarginSec(env: NodeJS.ProcessEnv): number {
  const raw = optional(env, "FLEET_SUBMISSION_MARGIN_SEC");
  if (raw === undefined) return 20;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new EnvError(`FLEET_SUBMISSION_MARGIN_SEC must be a non-negative number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

const SCRIPTED_DIRECTIVES = ["FOR", "AGAINST", "ABSTAIN", "ABSENT", "MALFORMED", "LATE"] as const satisfies readonly ScriptedDirective[];

const POLICY_PATTERN = /^scripted:(FOR|AGAINST|ABSTAIN|ABSENT|MALFORMED|LATE)$/;

function parsePolicy(env: NodeJS.ProcessEnv): ScriptedDirective {
  const raw = required(env, "FLEET_POLICY");
  const match = POLICY_PATTERN.exec(raw);
  if (!match) {
    throw new EnvError(
      `FLEET_POLICY must be "scripted:<${SCRIPTED_DIRECTIVES.join("|")}>", got ${JSON.stringify(raw)}`,
    );
  }
  return match[1] as ScriptedDirective;
}

/** Reads and validates the worker's environment. Never touches the filesystem or the network;
 *  `loadManifest` below is the separate, explicit place that reads `FLEET_MANIFEST` off disk, so
 *  this function alone is cheaply unit-testable against a plain object. */
export function parseWorkerEnv(env: NodeJS.ProcessEnv = process.env): WorkerEnv {
  return {
    manifestPath: required(env, "FLEET_MANIFEST"),
    rpcHttpUrl: required(env, "FLEET_RPC_HTTP"),
    pgUrl: optional(env, "RUNNER_PG_URL"),
    pollMs: parsePollMs(env),
    logLevel: optional(env, "LOG_LEVEL") ?? "info",
    agentId: parseAgentId(env),
    agentKey: parsePrivateKey("FLEET_AGENT_KEY", required(env, "FLEET_AGENT_KEY")),
    policyDirective: parsePolicy(env),
    submissionMarginSec: parseSubmissionMarginSec(env),
  };
}

/** Reads `path`, parses it as JSON, and validates it against `ManifestV1`. Throws `EnvError` with
 *  the offending path (never the manifest's raw contents, which can be large) on any failure, and
 *  refuses a manifest for a chain v1 does not operate on (final review I2: nothing in the repo
 *  refused Base mainnet, so a manifest deployed there would drive a worker with real keys). */
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
