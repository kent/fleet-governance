import path from "node:path";
import { openUiRunStore } from "../../../lib/db.js";
import { loadRunnerEnv } from "../../../lib/env.js";
import { repoRoot } from "../../../lib/paths.js";
import { handleCreateRun } from "../../../lib/runs-handler.js";

/**
 * `POST /api/runs`: validates the posted `fleet.experiment.v1` config, writes it and its derived
 * `fleet.deploy.v1` deploy config, records the run, and spawns `fleet run` detached. The actual
 * logic lives in `src/lib/runs-handler.ts` (see the comment there for why: Next's generated route
 * types reject any export from this file besides the HTTP method handlers it recognizes).
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  const result = await handleCreateRun(body);
  return Response.json(result.body, { status: result.status });
}

/** `GET /api/runs`: every run the UI has started, newest first (task 6 controller notes), for the
 *  home page's runs list. */
export async function GET(): Promise<Response> {
  loadRunnerEnv();
  const store = await openUiRunStore({ pgUrl: process.env["RUNNER_PG_URL"], reportsDir: path.join(repoRoot, "experiments", "reports") });
  const runs = await store.list();
  return Response.json({ runs });
}
