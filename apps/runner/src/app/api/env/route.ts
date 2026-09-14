import { MAX_FLEET_MEMBERS } from "@fleet/schemas";
import { loadRunnerEnv } from "../../../lib/env.js";
import { classifyRequiredEnvVars, requiredEnvVarNames } from "../../../lib/required-env.js";
import type { EnvVarSource } from "../../../lib/required-env.js";

export type EnvVarStatus = { name: string; present: boolean; source: EnvVarSource; anvilAccountIndex?: number };

/**
 * `GET /api/env?n=<fleet size>&openrouter=<0|1>&target=<local-anvil|base-sepolia>`: presence, never
 * value, of every environment variable the current draft config would need (controller notes item
 * 4). The form calls this whenever fleet size, a member's provider, or the target changes, so the
 * key section's markers track the draft rather than a fixed list.
 *
 * `target=local-anvil` reports an unset private-key variable as satisfied by the well-known public
 * Anvil test account rather than as missing, because that is what `fleet run` will actually do
 * there. Anything else reports it missing, as before.
 */
export async function GET(request: Request): Promise<Response> {
  loadRunnerEnv();
  const url = new URL(request.url);
  const memberCountParam = Number.parseInt(url.searchParams.get("n") ?? "5", 10);
  const memberCount = Number.isFinite(memberCountParam) ? Math.min(MAX_FLEET_MEMBERS, Math.max(0, Math.floor(memberCountParam))) : 5;
  const anyOpenRouter = url.searchParams.get("openrouter") === "1";
  const localAnvil = url.searchParams.get("target") === "local-anvil";

  const names = requiredEnvVarNames({ memberCount, anyOpenRouter });
  const vars: EnvVarStatus[] = classifyRequiredEnvVars(names, process.env, { localAnvil });
  return Response.json({ vars });
}
