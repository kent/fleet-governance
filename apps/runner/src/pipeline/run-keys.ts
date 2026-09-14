import type { Hex } from "viem";
import { chainIdForKind } from "@fleet/schemas";
import { anvilDevKey, DEMO_ACCOUNT_INDEX } from "../anvil-keys.js";
import { requirePrivateKeyEnv } from "../env.js";
import type { FleetKeys } from "./fixture-runner.js";

/**
 * Where `fleet run` and the Runner UI agree on which private key each role signs with, and on the
 * one case where a missing key is not a refusal.
 *
 * Kept in its own module, with no runtime import of the pipeline or `@fleet/agent-runtime`, so the
 * Next.js side (`lib/required-env.ts`, `lib/deploy-config.ts`, `lib/runs-handler.ts`) can share the
 * decision without pulling the Docker sandbox and worker modules into a page bundle. The
 * `FleetKeys` import is type-only and erases at runtime.
 */

/** The chain id a local Anvil reports, and the only chain on which a missing key falls back to a
 *  well-known public test account. */
export const LOCAL_ANVIL_CHAIN_ID = chainIdForKind("local-anvil");

export type RunKeyOptions = {
  /** The chain id the target RPC actually reported. The fallback is gated on this, not on the
   *  experiment's `target.kind`: a config can name `local-anvil` and point at anything, and
   *  handing a well-known test key to a real chain is exactly the mistake worth preventing. */
  chainId?: number | null;
  log?: (message: string) => void;
};

export type RoleKeySpec = {
  variable: string;
  accountIndex: number;
  /** How the role reads in a log line, e.g. `"deployer"` or `"agent 2"`. */
  description: string;
};

/** Every private-key variable a run of `memberCount` members needs, in the order `fleet run`
 *  resolves them, each paired with the Anvil dev account index it falls back to locally. */
export function roleKeySpecs(memberCount: number): RoleKeySpec[] {
  const specs: RoleKeySpec[] = [
    { variable: "FLEET_DEPLOYER_KEY", accountIndex: DEMO_ACCOUNT_INDEX.deployer, description: "deployer" },
    { variable: "FLEET_OPERATOR_KEY", accountIndex: DEMO_ACCOUNT_INDEX.operator, description: "operator" },
    { variable: "FLEET_GUARDIAN_KEY", accountIndex: DEMO_ACCOUNT_INDEX.guardian, description: "guardian" },
    { variable: "FLEET_KEEPER_KEY", accountIndex: DEMO_ACCOUNT_INDEX.keeper, description: "keeper" },
  ];
  for (let i = 0; i < memberCount; i++) {
    specs.push({ variable: `FLEET_AGENT_KEY_${i}`, accountIndex: DEMO_ACCOUNT_INDEX.agent(i), description: `agent ${i}` });
  }
  return specs;
}

const AGENT_KEY_PATTERN = /^FLEET_AGENT_KEY_(0|[1-9][0-9]*)$/;
const FIXED_ROLE_VARIABLES: ReadonlySet<string> = new Set([
  "FLEET_DEPLOYER_KEY",
  "FLEET_OPERATOR_KEY",
  "FLEET_GUARDIAN_KEY",
  "FLEET_KEEPER_KEY",
]);

/** Whether this variable is one a local Anvil run can supply a well-known test key for. Every
 *  private-key variable is; `OPENROUTER_API_KEY` is not, because no public stand-in for it exists
 *  and a run that needs a model needs a real account. */
export function isLocalAnvilFallbackVariable(name: string): boolean {
  return FIXED_ROLE_VARIABLES.has(name) || AGENT_KEY_PATTERN.test(name);
}

/** The Anvil dev account index a fallback-eligible variable maps to, or null when the name is not
 *  one this module knows how to substitute. */
export function anvilAccountIndexFor(name: string): number | null {
  switch (name) {
    case "FLEET_DEPLOYER_KEY":
      return DEMO_ACCOUNT_INDEX.deployer;
    case "FLEET_OPERATOR_KEY":
      return DEMO_ACCOUNT_INDEX.operator;
    case "FLEET_GUARDIAN_KEY":
      return DEMO_ACCOUNT_INDEX.guardian;
    case "FLEET_KEEPER_KEY":
      return DEMO_ACCOUNT_INDEX.keeper;
    default: {
      const match = AGENT_KEY_PATTERN.exec(name);
      return match?.[1] === undefined ? null : DEMO_ACCOUNT_INDEX.agent(Number(match[1]));
    }
  }
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

/**
 * One role's key: the configured variable when it is set, the matching well-known Anvil dev
 * account when it is not and the chain is a local Anvil, and a refusal naming the variable
 * otherwise.
 *
 * An explicitly set variable always wins, so an operator who does configure keys gets exactly
 * those. The log line names the role, the variable, and the dev account index, and never any key
 * material.
 */
export function resolveRunKey(env: NodeJS.ProcessEnv, spec: RoleKeySpec, opts: RunKeyOptions = {}): Hex {
  if (isSet(env[spec.variable])) return requirePrivateKeyEnv(env, spec.variable);
  if (opts.chainId !== LOCAL_ANVIL_CHAIN_ID) {
    // Throws naming the variable, exactly as it always has.
    return requirePrivateKeyEnv(env, spec.variable);
  }
  (opts.log ?? ((): void => {}))(
    `${spec.variable} is not set; using the well-known public Anvil test account for the ${spec.description} ` +
      `(local Anvil, chain id ${LOCAL_ANVIL_CHAIN_ID}, dev account index ${spec.accountIndex}). ` +
      `This key is public and must never be used on another chain.`,
  );
  return anvilDevKey(spec.accountIndex);
}

/**
 * Reads every key `fleet run` needs, one variable per role, matching the naming
 * `apps/worker`/`apps/keeper`/`DeployFleet.s.sol` already use (`FLEET_DEPLOYER_KEY`,
 * `FLEET_AGENT_KEY`, `FLEET_KEEPER_KEY`) plus one `FLEET_AGENT_KEY_<n>` per fleet member, since
 * `fleet.experiment.v1` itself only references keys "by reference to the secret store" (spec 12.1)
 * rather than carrying them inline.
 *
 * On a local Anvil, and only there, a variable that is not set falls back to the corresponding
 * well-known Anvil dev account (`anvil-keys.ts`, the standard `test test test ... junk` mnemonic
 * every local Anvil derives its accounts from). That is what makes the M3 acceptance sentence
 * true: someone who has not exported a single key can accept the defaults in the Runner UI, press
 * Run, and watch the replay. On any other chain a missing variable is refused as before, naming
 * it, because these keys are public: anyone can spend from them, and a fleet deployed with them on
 * a real chain is controlled by everyone.
 */
export function loadRunKeysFromEnv(env: NodeJS.ProcessEnv, memberCount: number, opts: RunKeyOptions = {}): FleetKeys {
  const resolved = new Map<string, Hex>();
  for (const spec of roleKeySpecs(memberCount)) {
    resolved.set(spec.variable, resolveRunKey(env, spec, opts));
  }

  const agentKeys: Record<number, Hex> = {};
  for (let i = 0; i < memberCount; i++) {
    agentKeys[i] = resolved.get(`FLEET_AGENT_KEY_${i}`)!;
  }
  return {
    deployerKey: resolved.get("FLEET_DEPLOYER_KEY")!,
    operatorKey: resolved.get("FLEET_OPERATOR_KEY")!,
    guardianKey: resolved.get("FLEET_GUARDIAN_KEY")!,
    keeperKey: resolved.get("FLEET_KEEPER_KEY")!,
    agentKeys,
  };
}
