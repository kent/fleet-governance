import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { marked } from "marked";
import { repoRoot } from "../../../../lib/paths.js";

/**
 * `/runs/[id]/report` (task 6 controller notes): renders `report.md` with `marked`, and links
 * `record.json`.
 */
export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const reportPath = path.join(repoRoot, "experiments", "reports", id, "report.md");
  const exists = existsSync(reportPath);
  const html = exists ? marked.parse(readFileSync(reportPath, "utf8"), { async: false }) : null;

  return (
    <main>
      <h1>Report: {id}</h1>
      <p>
        <a href={`/runs/${id}`}>Back to live view</a> · <a href={`/api/runs/${id}/record`}>record.json</a>
      </p>
      {html !== null ? (
        // eslint-disable-next-line react/no-danger
        <article dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <p>No report.md found for run {id} yet (the run has not reached REPORTED).</p>
      )}
    </main>
  );
}
