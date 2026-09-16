import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BatchPlan, BatchId, BATCH_ACTIVE, batchPath, validateBatch } from "./batch-authority.js";
import { OperatorEmail } from "./operators.js";
import { protectedRecord, putProtected } from "./protected-records.js";
import { readComputeAllocation, readComputeState } from "./compute-store.js";
import { readSimulationRequest, readSimulationWork } from "./simulation.js";
import { experimentRecord } from "./experiment-records.js";

export const BatchState = z.object({ batchId: BatchId, index: z.number().int().min(0).max(25),
  phase: z.enum(["queued", "running", "retiring", "completed", "cancelled", "expired", "blocked"]),
  updatedAt: z.string().datetime(), message: z.string(),
}).strict();
export async function getBatch(batchId: string) {
  const stored = await protectedRecord(batchPath(batchId, "plan"));
  if (!stored) return null;
  const plan = BatchPlan.parse(stored.value);
  const [state, approved, cancellation] = await Promise.all([protectedRecord(batchPath(batchId, "state")), protectedRecord(batchPath(batchId, "approval")), protectedRecord(batchPath(batchId, "cancel"))]);
  const experiments = [];
  for (const id of plan.runIds) {
    const [record, work] = await Promise.all([experimentRecord(id), readSimulationWork(id)]);
    const guardian = work ? (await readComputeState(work.allocationId))?.value : null;
    experiments.push({ ...(record?.experiment ?? { runId: id, phase: "not-started", url: `/experiments/${id}` }),
      guardian: guardian ? { phase: guardian.phase, reason: guardian.reason, observedVmStatus: guardian.observedVmStatus,
        stopAcceptedAt: guardian.stopAcceptedAt, stoppedAt: guardian.stoppedAt } : null });
  }
  return { plan, state: state?.value ?? { phase: cancellation ? "cancelled" : approved ? "queued" : "draft" }, approved: !!approved, cancellationRequested: !!cancellation, experiments };
}
export async function createBatch(id: string, input: unknown, requestedBy: OperatorEmail, runIds?: string[]) {
  BatchId.parse(id); OperatorEmail.parse(requestedBy);
  const validated = validateBatch(input);
  const { reservedBudgetUsd: _, allocatedAgentMinutes: __, ...settings } = validated;
  const previous = await protectedRecord(batchPath(id, "plan"));
  if (previous) {
    const prior = BatchPlan.parse(previous.value);
    if (prior.requestedBy !== requestedBy || JSON.stringify({ name: prior.name, experiments: prior.experiments, maxBudgetUsd: prior.maxBudgetUsd, expiresAt: prior.expiresAt }) !== JSON.stringify(settings)) throw new Error("This batch identity already has a different owner or configuration.");
    return prior;
  }
  const plan = BatchPlan.parse({ ...settings, schema: "fleet.batch-plan.v1", batchId: id, requestedBy, createdAt: new Date().toISOString(), runIds: runIds ?? settings.experiments.map(() => `run-${randomUUID()}`) });
  await putProtected(batchPath(id, "plan"), plan);
  return plan;
}
export async function startBatch(id: string, requestedBy: OperatorEmail) {
  const plan = BatchPlan.parse((await protectedRecord(batchPath(id, "plan")))?.value);
  if (plan.requestedBy !== OperatorEmail.parse(requestedBy)) throw new Error("Only this batch's creator can authorise it.");
  if (Date.parse(plan.expiresAt) <= Date.now() || await protectedRecord(batchPath(id, "cancel"))) throw new Error("This batch is expired or cancelled.");
  const current = await protectedRecord<{ batchId: string }>(BATCH_ACTIVE);
  if (current?.value.batchId === id) return { batchId: id, phase: "queued", message: "Batch already authorised. GitHub Actions will reconcile its progress." };
  if (current || await readComputeAllocation() || await readSimulationRequest()) throw new Error("Another batch or allocation owns the worker. Retire it before authorising a new batch.");
  if (await protectedRecord(batchPath(id, "approval"))) throw new Error("An approved batch cannot be restarted. Create a new batch.");
  await putProtected(batchPath(id, "approval"), { batchId: id, requestedBy, approvedAt: new Date().toISOString(), maxBudgetUsd: plan.maxBudgetUsd, runIds: plan.runIds });
  await putProtected(BATCH_ACTIVE, { batchId: id });
  return { batchId: id, phase: "queued", message: "Authorised. GitHub Actions checks every five minutes; scheduling can be delayed. This batch continues with your computer off." };
}
export async function cancelBatch(id: string, requestedBy: OperatorEmail) {
  OperatorEmail.parse(requestedBy);
  if (!await protectedRecord(batchPath(id, "plan"))) throw new Error("Batch not found.");
  if (!await protectedRecord(batchPath(id, "cancel"))) await putProtected(batchPath(id, "cancel"), { requestedBy, cancelledAt: new Date().toISOString() });
  return { batchId: id, message: "No further runs will start. A run already reserved or running remains under its original Guardian deadline and will be retired safely." };
}
