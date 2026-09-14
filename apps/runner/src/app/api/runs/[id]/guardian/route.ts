import { handleGuardianAction } from "../../../../../lib/guardian-route.js";

/**
 * `POST /api/runs/[id]/guardian`: pause, unpause, or cancel a queued proposal, labeled a human
 * intervention (spec 12.3). Body: `{ action: "pause" | "unpause" | "cancel", proposalId?: string }`.
 * The actual logic lives in `src/lib/guardian-route.ts` (same reason as `runs-handler.ts`: Next's
 * generated route types reject any export besides the HTTP method handlers).
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  const result = await handleGuardianAction(id, body);
  return Response.json(result.body, { status: result.status });
}
