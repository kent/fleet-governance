import { loadRunnerEnv } from "../../../lib/env.js";
import { requiredEnvVarNames } from "../../../lib/required-env.js";

export type EnvVarStatus = { name: string; present: boolean };

/**
 * `GET /api/env?n=<fleet size>&openrouter=<0|1>`: presence, never value, of every environment
 * variable the current draft config would need (controller notes item 4). The form calls this
 * whenever fleet size or a member's provider changes, so the key section's markers track the
 * draft rather than a fixed list.
 */
export async function GET(request: Request): Promise<Response> {
  loadRunnerEnv();
  const url = new URL(request.url);
  const memberCountParam = Number.parseInt(url.searchParams.get("n") ?? "5", 10);
  const memberCount = Number.isFinite(memberCountParam) ? Math.min(64, Math.max(0, memberCountParam)) : 5;
  const anyOpenRouter = url.searchParams.get("openrouter") === "1";

  const names = requiredEnvVarNames({ memberCount, anyOpenRouter });
  const vars: EnvVarStatus[] = names.map((name) => ({
    name,
    present: process.env[name] !== undefined && process.env[name] !== "",
  }));
  return Response.json({ vars });
}
