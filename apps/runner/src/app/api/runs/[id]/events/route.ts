import path from "node:path";
import { openRunStore } from "../../../../../pipeline/state.js";
import { buildRunEventsStream } from "../../../../../lib/sse.js";
import { loadRunnerEnv } from "../../../../../lib/env.js";
import { repoRoot } from "../../../../../lib/paths.js";

/**
 * `GET /api/runs/[id]/events`: Server-Sent Events for the live run view (task 6 controller notes).
 * Emits `{type:"log",line}` for each new `run.log` line, `{type:"stage",stage,updatedAt}` when the
 * pipeline's own run store reports a new stage, and `{type:"ping"}` every 15s. See
 * `src/lib/sse.ts` for the polling implementation.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  loadRunnerEnv();
  const { id } = await context.params;
  const runDir = path.join(repoRoot, "experiments", "reports", id);
  const logPath = path.join(runDir, "run.log");
  const pipelineStore = await openRunStore({ pgUrl: process.env["RUNNER_PG_URL"], runDir });

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
