import { anvilAccountIndexFor, isLocalAnvilFallbackVariable } from "../pipeline/run-keys.js";

/**
 * The environment variable names `POST /api/runs` requires present before it writes or spawns
 * anything, and `GET /api/env` reports presence for (controller notes item 4): one key per fixed
 * role, one `FLEET_AGENT_KEY_<n>` per fleet member, and `OPENROUTER_API_KEY` only when at least
 * one member's provider is `openrouter`. Never returns or inspects a value, only names.
 */
export function requiredEnvVarNames(opts: { memberCount: number; anyOpenRouter: boolean }): string[] {
  const names = ["FLEET_DEPLOYER_KEY", "FLEET_OPERATOR_KEY", "FLEET_GUARDIAN_KEY", "FLEET_KEEPER_KEY"];
  for (let i = 0; i < opts.memberCount; i++) names.push(`FLEET_AGENT_KEY_${i}`);
  if (opts.anyOpenRouter) names.push("OPENROUTER_API_KEY");
  return names;
}

/** Where one required variable's value comes from for this run. `"local-anvil-test-key"` is the
 *  local-Anvil fallback: the variable is not set, and `fleet run` will use the well-known public
 *  Anvil dev account for that role (`pipeline/run-keys.ts`). */
export type EnvVarSource = "env" | "local-anvil-test-key" | "missing";

export type EnvVarRequirement = {
  name: string;
  /** True when the run has a usable value for this variable, whether it came from the environment
   *  or from the local Anvil fallback. What the UI's presence marker reads. */
  present: boolean;
  source: EnvVarSource;
  /** For a fallback, which Anvil dev account index will be used. Never a key, only an index. */
  anvilAccountIndex?: number;
};

function isSet(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

/**
 * Classifies every required variable as set, satisfied by the local Anvil test key, or missing.
 *
 * On a local Anvil, a missing private-key variable is not a blocker: `fleet run` falls back to the
 * corresponding well-known dev account, so the M3 acceptance sentence holds for someone who has
 * exported nothing at all. `OPENROUTER_API_KEY` is never satisfied this way; there is no public
 * stand-in for a model account.
 */
export function classifyRequiredEnvVars(
  names: readonly string[],
  env: NodeJS.ProcessEnv,
  opts: { localAnvil: boolean },
): EnvVarRequirement[] {
  return names.map((name) => {
    if (isSet(env[name])) return { name, present: true, source: "env" as const };
    const accountIndex = opts.localAnvil && isLocalAnvilFallbackVariable(name) ? anvilAccountIndexFor(name) : null;
    if (accountIndex !== null) {
      return { name, present: true, source: "local-anvil-test-key" as const, anvilAccountIndex: accountIndex };
    }
    return { name, present: false, source: "missing" as const };
  });
}

/** The first name in `names` that the run has no value for, or null when every one is satisfied.
 *  Returns the variable's name only, never its value. On a local Anvil the private-key variables
 *  are satisfied by the well-known test accounts, so they are never reported missing there. */
export function findMissingEnvVar(
  names: readonly string[],
  env: NodeJS.ProcessEnv,
  opts: { localAnvil?: boolean } = {},
): string | null {
  const classified = classifyRequiredEnvVars(names, env, { localAnvil: opts.localAnvil === true });
  return classified.find((entry) => !entry.present)?.name ?? null;
}
