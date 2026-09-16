import { z } from "zod";
import { ExperimentSettings } from "./experiment-settings.js";
import { OperatorEmail } from "./operators.js";
import { protectedRecord } from "./protected-records.js";
import type { SimulationRequest } from "./simulation.js";
import { buildExperimentCharter, experimentConstitution } from "./experiment-charter.js";

export const BatchId = z.string().regex(/^batch-[0-9a-f-]{36}$/);
export const BatchInput = z.object({
  name: z.string().trim().min(3).max(100),
  experiments: z.array(ExperimentSettings).min(1).max(25),
  maxBudgetUsd: z.number().min(0.05).max(50).default(10),
  expiresAt: z.string().datetime(),
}).strict().superRefine((value, ctx) => {
  const cents = value.experiments.reduce((sum, run) => sum + Math.ceil(run.budgetUsd * 100), 0);
  if (cents > Math.floor(value.maxBudgetUsd * 100)) ctx.addIssue({ code: "custom", message: "The sum of run budget ceilings exceeds the batch ceiling." });
});
export const BatchPlan = BatchInput.innerType().extend({
  schema: z.literal("fleet.batch-plan.v1"), batchId: BatchId, requestedBy: OperatorEmail,
  createdAt: z.string().datetime(), runIds: z.array(z.string().regex(/^run-[0-9a-f-]{36}$/)).min(1).max(25),
}).strict().superRefine((plan, ctx) => {
  const parsed = BatchInput.safeParse({ name: plan.name, experiments: plan.experiments, maxBudgetUsd: plan.maxBudgetUsd, expiresAt: plan.expiresAt });
  if (!parsed.success || plan.runIds.length !== plan.experiments.length || new Set(plan.runIds).size !== plan.runIds.length) ctx.addIssue({ code: "custom", message: "Invalid bounded batch manifest." });
});
export type BatchPlan = z.infer<typeof BatchPlan>;
export const BATCH_ACTIVE = "batches/active.json";
export const batchPath = (id: string, file: string) => `batches/${BatchId.parse(id)}/${file}.json`;
export function validateBatch(input: unknown, now = Date.now()) {
  const plan = BatchInput.parse(input);
  const expiry = Date.parse(plan.expiresAt);
  if (expiry <= now || expiry > now + 24 * 3600_000) throw new Error("A batch must expire within the next 24 hours.");
  for (const settings of plan.experiments) buildExperimentCharter(settings, experimentConstitution(settings));
  return { ...plan, reservedBudgetUsd: plan.experiments.reduce((n, run) => n + Math.ceil(run.budgetUsd * 100), 0) / 100,
    allocatedAgentMinutes: plan.experiments.reduce((n, run) => n + run.durationMinutes, 0) };
}

/** Identity comes from IAP or a verified personal credential, never tool arguments.
 * A batch is a finite human authorisation for new runs, not a way to resume a halt. */
export async function assertBatchLaunch(request: SimulationRequest, batchId?: string): Promise<void> {
  const active = await protectedRecord<{ batchId: string }>(BATCH_ACTIVE);
  if (!active && !batchId) return;
  if (!batchId || active?.value.batchId !== batchId) throw new Error("An authorised batch owns this worker.");
  const stored = await protectedRecord(batchPath(batchId, "plan"));
  const plan = BatchPlan.parse(stored?.value);
  const index = plan.runIds.indexOf(request.runId);
  if (plan.requestedBy !== request.requestedBy || index < 0 || JSON.stringify(plan.experiments[index]) !== JSON.stringify(request.settings)
    || Date.parse(plan.expiresAt) <= Date.now() || await protectedRecord(batchPath(batchId, "cancel"))) {
    throw new Error("This run is outside the human-authorised batch.");
  }
}
