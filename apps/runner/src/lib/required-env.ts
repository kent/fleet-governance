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

/** The first name in `names` that is missing or empty in `env`, or null when every one is set.
 *  Returns the variable's name only, never its value. */
export function findMissingEnvVar(names: readonly string[], env: NodeJS.ProcessEnv): string | null {
  for (const name of names) {
    const value = env[name];
    if (value === undefined || value === "") return name;
  }
  return null;
}
