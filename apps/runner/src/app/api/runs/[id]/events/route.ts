import path from "node:path";
import { buildRunEventsStream } from "../../../../../lib/sse.js";
import { loadRunnerEnv } from "../../../../../lib/env.js";
import { repoRoot } from "../../../../../lib/paths.js";
import { parseRunId, resolveConfinedRunDir } from "../../../../../lib/run-id.js";
import { openRunStoreSafe } from "../../../../../lib/safe-stores.js";

/**
 * `GET /api/runs/[id]/events`: Server-Sent Events for the live run view (task 6 controller notes).
 * Emits `{type:"log",line}` for each new `run.log` line, `{type:"stage",stage,updatedAt}` when the
 * pipeline's own run store reports a new stage, and `{type:"ping"}` every 15s. See
 * `src/lib/sse.ts` for the polling implementation.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  loadRunnerEnv();
  const { id: rawId } = await context.params;
  const id = parseRunId(rawId);
  if (id === null) {
    return Response.json({ error: "invalid run id" }, { status: 400 });
  }

  const reportsDir = path.join(repoRoot, "experiments", "reports");
  const runDir = resolveConfinedRunDir(reportsDir, id);
  if (runDir === null) {
    return Response.json({ error: "invalid run id" }, { status: 400 });
  }
  const logPath = path.join(runDir, "run.log");
  const pipelineStore = await openRunStoreSafe({ pgUrl: process.env["RUNNER_PG_URL"], runDir });

  const stream = buildRunEventsStream({
    logPath,
    getStage: async () => {
      const record = await pipelineStore.get(id);
      return record ? { stage: record.stage, updatedAt: record.updatedAt } : null;
    },
    signal: request.signal,
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
