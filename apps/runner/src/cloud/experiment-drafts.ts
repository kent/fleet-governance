import { z } from "zod";
import { ExperimentSettings } from "./experiment-settings.js";
import { OperatorEmail } from "./operators.js";
import { protectedRecord, putProtected } from "./protected-records.js";
import { buildExperimentCharter, experimentConstitution } from "./experiment-charter.js";
import { readObject, writeObject, CloudError } from "./google.js";
import { createBatch, startBatch } from "./batches.js";

export const RunId = z.string().regex(/^run-[0-9a-f-]{36}$/);
const Draft = z.object({ runId: RunId, settings: ExperimentSettings, requestedBy: OperatorEmail, createdAt: z.string().datetime(), expiresAt: z.string().datetime() }).strict();
export async function createExperimentDraft(runId: string, input: unknown, requestedBy: OperatorEmail) {
  const settings = ExperimentSettings.parse(input);
  buildExperimentCharter(settings, experimentConstitution(settings));
  const name = `drafts/${RunId.parse(runId)}.json`;
  OperatorEmail.parse(requestedBy);
  const prior = await protectedRecord(name);
  if (prior) {
    const draft = Draft.parse(prior.value);
    if (draft.requestedBy !== requestedBy || JSON.stringify(draft.settings) !== JSON.stringify(settings)) throw new Error("This draft identity has another owner or configuration.");
    return draft;
  }
  const draft = Draft.parse({ runId, settings, requestedBy, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString() });
  await putProtected(name, draft);
  return draft;
}
export async function runExperimentDraft(runId: string, requestedBy: OperatorEmail) {
  const draft = Draft.parse((await protectedRecord(`drafts/${RunId.parse(runId)}.json`))?.value);
  if (draft.requestedBy !== OperatorEmail.parse(requestedBy)) throw new Error("Only this draft's creator can run it.");
  const batchId = runId.replace(/^run-/, "batch-");
  await createBatch(batchId, { name: draft.settings.name, experiments: [draft.settings], maxBudgetUsd: draft.settings.budgetUsd, expiresAt: draft.expiresAt }, requestedBy, [runId]);
  const result = await startBatch(batchId, requestedBy);
  const statusPath = `demo/simulations/${runId}/status.json`;
  if (!await readObject(statusPath)) {
    try { await writeObject(statusPath, { runId, settings: draft.settings, goal: draft.settings.goal, createdAt: draft.createdAt, updatedAt: new Date().toISOString(), phase: "queued", terminal: false, message: "Authorised. Waiting for the next GitHub Actions batch check. The worker has not started yet.", agents: [] }, true); }
    catch (error) { if (!(error instanceof CloudError && error.status === 412)) throw error; }
  }
  return { ...result, runId, url: `https://fleet-governance-449245570324.us-central1.run.app/experiments/${runId}` };
}
