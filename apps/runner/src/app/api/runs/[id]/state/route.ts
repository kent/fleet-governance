import { buildRunState } from "../../../../../lib/run-state.js";
import { parseRunId } from "../../../../../lib/run-id.js";

/**
 * `GET /api/runs/[id]/state`: the assembled live-view model (task 6 controller notes), stage,
 * charter and version, proposals with trace-derived fields, agents, health, interventions. See
 * `src/lib/run-state.ts` for the full assembly (chain-first, `record.json` fallback).
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id: rawId } = await context.params;
  const id = parseRunId(rawId);
  if (id === null) {
    return Response.json({ error: "invalid run id" }, { status: 400 });
  }
  const state = await buildRunState(id);
  return Response.json(state);
}
