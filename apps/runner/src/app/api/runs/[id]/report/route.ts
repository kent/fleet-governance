import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "../../../../../lib/paths.js";
import { parseRunId, resolveConfinedRunDir } from "../../../../../lib/run-id.js";

/** `GET /api/runs/[id]/report`: serves `report.md` as plain text (task 6 controller notes: the
 *  report page renders it with `marked`). `404` before `REPORTED` has run. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id: rawId } = await context.params;
  const id = parseRunId(rawId);
  if (id === null) {
    return Response.json({ error: "invalid run id" }, { status: 400 });
  }
  const runDir = resolveConfinedRunDir(path.join(repoRoot, "experiments", "reports"), id);
  if (runDir === null) {
    return Response.json({ error: "invalid run id" }, { status: 400 });
  }
  const reportPath = path.join(runDir, "report.md");
  if (!existsSync(reportPath)) {
    return Response.json({ error: `no report.md found for run ${id}` }, { status: 404 });
  }
  const text = readFileSync(reportPath, "utf8");
  return new Response(text, { headers: { "content-type": "text/markdown; charset=utf-8" } });
}
