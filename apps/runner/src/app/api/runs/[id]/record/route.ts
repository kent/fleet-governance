import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "../../../../../lib/paths.js";

/** `GET /api/runs/[id]/record`: serves `record.json` verbatim (task 6 controller notes: "Report
 *  page renders report.md and links record.json"). `404` before `CAPTURED` has run. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  const recordPath = path.join(repoRoot, "experiments", "reports", id, "record.json");
  if (!existsSync(recordPath)) {
    return Response.json({ error: `no record.json found for run ${id}` }, { status: 404 });
  }
  const text = readFileSync(recordPath, "utf8");
  return new Response(text, { headers: { "content-type": "application/json" } });
}
