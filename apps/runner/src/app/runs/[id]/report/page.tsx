import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { marked } from "marked";
import { repoRoot } from "../../../../lib/paths.js";
import { parseRunId } from "../../../../lib/run-id.js";

/**
 * `/runs/[id]/report` (task 6 controller notes): renders `report.md` with `marked`, and links
 * `record.json`.
 */
export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Same allowlist every `[id]` route uses (fix round 1, F1): this page reads a file under
  // `experiments/reports/<id>`, so an id that never passed `parseRunId` must not reach `path.join`.
  const runId = parseRunId(id);
  if (runId === null) {
    return (
      <main>
        <h1>Report</h1>
        <p>Invalid run id.</p>
      </main>
    );
  }
  const reportPath = path.join(repoRoot, "experiments", "reports", runId, "report.md");
  const exists = existsSync(reportPath);
  const html = exists ? marked.parse(readFileSync(reportPath, "utf8"), { async: false }) : null;

  return (
    <main>
      <h1>Report: {runId}</h1>
      <p>
        <a href={`/runs/${runId}`}>Back to live view</a> · <a href={`/runs/${runId}/briefing`}>What the fleet was told</a> ·{" "}
        <a href={`/api/runs/${runId}/record`}>record.json</a>
      </p>
      {html !== null ? (
        // eslint-disable-next-line react/no-danger
        <article dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <p>No report.md found for run {runId} yet (the run has not reached REPORTED).</p>
      )}
    </main>
  );
}
