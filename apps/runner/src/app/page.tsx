import path from "node:path";
import ConfigForm from "../components/ConfigForm.js";
import { openUiRunStore } from "../lib/db.js";
import { loadRunnerEnv } from "../lib/env.js";
import { repoRoot } from "../lib/paths.js";

/** Reads the runs list from disk/DB on every request rather than once at build time: the whole
 *  point of this section is to show whichever runs exist *right now*, which a statically
 *  prerendered page would freeze at build time. */
export const dynamic = "force-dynamic";

/** Home page: the config panel, plus a list of every run started here, newest first (task 6
 *  controller notes: "`/` gains a runs list linking to both" the live view and the report). */
export default async function HomePage() {
  loadRunnerEnv();
  const store = await openUiRunStore({ pgUrl: process.env["RUNNER_PG_URL"], reportsDir: path.join(repoRoot, "experiments", "reports") });
  const runs = await store.list();

  return (
    <main>
      <h1>Fleet Governance Runner</h1>
      <p>Configure an experiment run, then press Run.</p>
      <ConfigForm />

      <section aria-label="Runs">
        <h2>Runs</h2>
        {runs.length === 0 ? (
          <p>No runs started yet.</p>
        ) : (
          <ul>
            {runs.map((run) => (
              <li key={run.runId}>
                {run.runId} ({run.createdAt}), <a href={`/runs/${run.runId}`}>live view</a> ·{" "}
                <a href={`/runs/${run.runId}/report`}>report</a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
