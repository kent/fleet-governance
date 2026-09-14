import { buildBriefing } from "../../../../lib/briefing.js";
import { repoRoot } from "../../../../lib/paths.js";
import { parseRunId } from "../../../../lib/run-id.js";
import { resolveRunContext } from "../../../../lib/run-context.js";

/**
 * `/runs/[id]/briefing`: what the fleet was told before it acted. The live view shows what the
 * fleet did and the report shows how it came out; this page shows the instructions those were
 * answers to, so a reader can judge a vote against the rules the voter was given.
 */
export default async function BriefingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const runId = parseRunId(id);
  if (runId === null) {
    return (
      <main>
        <h1>Briefing</h1>
        <p>Invalid run id.</p>
      </main>
    );
  }

  const ctx = await resolveRunContext(runId, repoRoot, process.env["RUNNER_PG_URL"]);
  const briefing = buildBriefing(repoRoot, runId, { experiment: ctx.experiment, recordConfig: ctx.record?.config ?? null });
  const charter = briefing.charter;

  return (
    <main>
      <h1>What the fleet was told: {runId}</h1>
      <p>
        <a href={`/runs/${runId}`}>Live view</a> · <a href={`/runs/${runId}/report`}>Report</a>
      </p>

      <section aria-label="The task">
        <h2>1. The task</h2>
        {charter ? (
          <>
            <p>
              <strong>Goal.</strong> {charter.goal}
            </p>
            <p>
              Charter read from the {briefing.charterSource === "record" ? "run's own record" : "experiment config"}.
            </p>
            <table>
              <tbody>
                <tr>
                  <th scope="row">May do</th>
                  <td>{charter.allowedActionClasses.join(", ") || "nothing"}</td>
                </tr>
                <tr>
                  <th scope="row">May not do</th>
                  <td>{charter.forbiddenActions.join(", ") || "nothing named"}</td>
                </tr>
                <tr>
                  <th scope="row">Hosts it may reach</th>
                  <td>{charter.externalAllowlist.join(", ") || "none"}</td>
                </tr>
                <tr>
                  <th scope="row">Budget</th>
                  <td>
                    {charter.budget.toolCalls} tool calls, {charter.budget.inferenceTokens} inference tokens
                  </td>
                </tr>
                <tr>
                  <th scope="row">Stops when</th>
                  <td>{charter.stopConditions.join("; ") || "not specified"}</td>
                </tr>
              </tbody>
            </table>
            <p>
              Every tool call is checked against this charter before it runs. Changing any of it takes a vote the
              fleet records onchain.
            </p>
          </>
        ) : (
          <p>No charter found for this run yet.</p>
        )}
        {briefing.taskReadme !== null ? (
          <>
            <h3>The repository the fleet works in{briefing.repoFixture ? `: ${briefing.repoFixture}` : ""}</h3>
            <pre>{briefing.taskReadme}</pre>
          </>
        ) : null}
      </section>

      <section aria-label="The constitution">
        <h2>2. The constitution</h2>
        <p>Every member shares this text. It is the rule they vote by.</p>
        {briefing.constitution !== null ? <pre>{briefing.constitution}</pre> : <p>constitution.md not found.</p>}
      </section>

      <section aria-label="The roles">
        <h2>3. The members and their roles</h2>
        {briefing.roles.length === 0 ? (
          <p>No fleet members found for this run.</p>
        ) : (
          briefing.roles.map((role) => (
            <article key={role.agentId}>
              <h3>
                Agent {role.agentId}: {role.role}
              </h3>
              <p>
                {role.provider} · {role.model} · prompt version {role.promptVersion} · {role.promptFile}
              </p>
              {role.prompt !== null ? <pre>{role.prompt}</pre> : <p>No role prompt file for this role.</p>}
            </article>
          ))
        )}
      </section>

      <section aria-label="The questions">
        <h2>4. The four questions a member is asked</h2>
        <p>
          A member is never asked an open question. It is asked one of these, with the task, the charter, and its own
          role, and it answers with a structured object code turns into an action or a ballot.
        </p>
        {briefing.templates.map((template) => (
          <article key={template.file}>
            <h3>{template.name}</h3>
            <p>{template.file}</p>
            <pre>{template.body}</pre>
          </article>
        ))}
      </section>
    </main>
  );
}
