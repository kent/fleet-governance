import { BatchPlan, BATCH_ACTIVE, batchPath } from "./batch-authority.js";
import { BatchState } from "./batches.js";
import { protectedRecord, putProtected, deleteProtected } from "./protected-records.js";
import { readComputeAllocation, readComputeState, isComputeRunBlocked } from "./compute-store.js";
import { readSimulationRequest, queueSimulation } from "./simulation.js";
import { COMPUTE_TARGET, releaseComputeAllocation } from "./compute-admin.js";
import { googleRequest, CloudError } from "./google.js";

const CONTROLLER = "v2/projects/fleet-governance/locations/us-central1/services/fleet-compute-controller";
type Retirement = { batchId: string; runId: string; allocationId: string; image: string; createdAt: string };
export async function batchContext() {
  const active = await protectedRecord<{ batchId: string }>(BATCH_ACTIVE);
  if (!active) return null;
  const id = active.value.batchId;
  const plan = BatchPlan.parse((await protectedRecord(batchPath(id, "plan")))?.value);
  const approval = await protectedRecord<{ requestedBy: string; runIds: string[] }>(batchPath(id, "approval"));
  if (approval?.value.requestedBy !== plan.requestedBy || JSON.stringify(approval.value.runIds) !== JSON.stringify(plan.runIds)) throw new Error("Missing exact human batch authorisation.");
  const storedState = await protectedRecord(batchPath(id, "state"));
  const state = storedState ? BatchState.parse(storedState.value) : { batchId: id, index: 0, phase: "queued" as const, updatedAt: plan.createdAt, message: "Waiting for GitHub Actions." };
  if (state.batchId !== id) throw new Error("Batch state identity mismatch.");
  return { active, plan, state, generation: storedState?.generation ?? "0" };
}
type Context = NonNullable<Awaited<ReturnType<typeof batchContext>>>;
async function save(context: Context, phase: typeof context.state.phase, message: string, index = context.state.index) {
  await putProtected(batchPath(context.plan.batchId, "state"), { batchId: context.plan.batchId, index, phase, message, updatedAt: new Date().toISOString() }, context.generation);
}
async function finish(context: Context, phase: "completed" | "cancelled" | "expired") {
  if (await readComputeAllocation() || await readSimulationRequest()) throw new Error("Cannot finish a batch while a worker reservation remains.");
  await save(context, phase, `Batch ${phase}. Previous halt records remain permanent.`);
  await deleteProtected(BATCH_ACTIVE, context.active.generation);
  return { action: "none" as const, phase };
}
export async function tickBatch() {
  const context = await batchContext();
  if (!context) return { action: "none" as const, phase: "idle" };
  const { plan, state } = context;
  if (state.phase === "blocked") return { action: "none" as const, phase: "blocked" };
  const runId = plan.runIds[state.index];
  if (!runId) return finish(context, "completed");
  // A retirement interrupted between deletion and recreation must complete before
  // cancellation, expiry, or any new allocation can be considered.
  const retirement = await protectedRecord<Retirement>(batchPath(plan.batchId, `retirement-${state.index}`));
  if (retirement) return { action: "retire" as const, batchId: plan.batchId, runId };
  const [allocation, request] = await Promise.all([readComputeAllocation(), readSimulationRequest()]);
  if (allocation && allocation.runId !== runId || request && request.runId !== runId) {
    await save(context, "blocked", "Another run owns the worker. No batch action was taken. Operator recovery is required.");
    return { action: "none" as const, phase: "blocked" };
  }
  if (allocation) {
    const [record, response] = await Promise.all([readComputeState(allocation.allocationId), googleRequest("compute", COMPUTE_TARGET)]);
    const vm = await response.json() as { id: string; status: string };
    if (record?.value.phase === "halted" && vm.status === "TERMINATED" && vm.id === allocation.instanceId) return { action: "retire" as const, batchId: plan.batchId, runId };
    await save(context, "running", "Waiting for the Guardian's durable halt and Compute Engine TERMINATED. Worker-written status cannot advance this batch.");
    return { action: "none" as const, phase: "running" };
  }
  if (request) {
    if (Date.now() - Date.parse(request.createdAt) > 20 * 60_000) await save(context, "blocked", "Preparation did not arm within 20 minutes. No retry or fresh spend was authorised. Operator recovery is required; the VM's native stop deadline remains in force.");
    return { action: "none" as const, phase: "preparing" };
  }
  if (await protectedRecord(batchPath(plan.batchId, "cancel"))) return finish(context, "cancelled");
  if (Date.parse(plan.expiresAt) <= Date.now()) return finish(context, "expired");
  // No automatic retry after an ambiguous dispatch. The protected queue reserves
  // this exact identity before any VM start or preparation-job invocation.
  await queueSimulation(runId, plan.experiments[state.index], plan.requestedBy, plan.batchId);
  await save(context, "running", `Started experiment ${state.index + 1} of ${plan.runIds.length}.`);
  return { action: "none" as const, phase: "running", runId };
}
export async function beginBatchRetirement() {
  const context = await batchContext();
  if (!context) throw new Error("No active batch.");
  const { plan, state } = context;
  const runId = plan.runIds[state.index];
  if (!runId) throw new Error("No run to retire.");
  const path = batchPath(plan.batchId, `retirement-${state.index}`);
  const prior = await protectedRecord<Retirement>(path);
  if (prior) {
    if (prior.value.runId !== runId || prior.value.batchId !== plan.batchId || !/^us-central1-docker.pkg.dev\/fleet-governance\/fleet\/runner@sha256:[a-f0-9]{64}$/.test(prior.value.image)) throw new Error("Invalid retirement record.");
    return prior.value;
  }
  const allocation = await readComputeAllocation();
  if (!allocation || allocation.runId !== runId) throw new Error("Cannot retire another allocation.");
  const record = await readComputeState(allocation.allocationId);
  const vm = await (await googleRequest("compute", COMPUTE_TARGET)).json() as { id: string; status: string };
  if (record?.value.phase !== "halted" || vm.status !== "TERMINATED" || vm.id !== allocation.instanceId) throw new Error("Retirement requires a durable Guardian halt and the same VM verified off.");
  const service = await (await googleRequest("run", CONTROLLER)).json() as { template: { containers: { image: string }[] } };
  const image = service.template.containers[0]?.image ?? "";
  if (!/^us-central1-docker.pkg.dev\/fleet-governance\/fleet\/runner@sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Guardian must use a pinned Fleet image.");
  const value: Retirement = { batchId: plan.batchId, runId, allocationId: allocation.allocationId, image, createdAt: new Date().toISOString() };
  await putProtected(path, value);
  await save(context, "retiring", "Draining the previous Guardian before permanently retiring this allocation.");
  return value;
}
export async function releaseBatchAllocation() {
  const context = await batchContext();
  if (!context) throw new Error("No active batch.");
  const retirement = (await protectedRecord<Retirement>(batchPath(context.plan.batchId, `retirement-${context.state.index}`)))?.value;
  if (!retirement || retirement.runId !== context.plan.runIds[context.state.index]) throw new Error("No exact retirement record.");
  // The workflow must delete the service and drain for >120 seconds first.
  try { await googleRequest("run", CONTROLLER); throw new Error("Guardian must be retired before release."); }
  catch (error) { if (!(error instanceof CloudError && error.status === 404)) throw error; }
  const allocation = await readComputeAllocation();
  if (allocation) {
    if (allocation.runId !== retirement.runId || allocation.allocationId !== retirement.allocationId) throw new Error("Allocation changed during retirement.");
    await releaseComputeAllocation(retirement.allocationId);
  } else if (!await isComputeRunBlocked(retirement.runId) || !await protectedRecord(`released/${retirement.allocationId}.json`)) throw new Error("Missing permanent retirement evidence.");
}
export async function completeBatchRetirement() {
  const context = await batchContext();
  if (!context) throw new Error("No active batch.");
  const retirement = (await protectedRecord<Retirement>(batchPath(context.plan.batchId, `retirement-${context.state.index}`)))?.value;
  if (!retirement || retirement.runId !== context.plan.runIds[context.state.index] || !await isComputeRunBlocked(retirement.runId) || await readComputeAllocation() || await readSimulationRequest()) throw new Error("The prior allocation is not fully retired.");
  const service = await (await googleRequest("run", CONTROLLER)).json() as { terminalCondition?: { state: string }; reconciling?: boolean };
  if (service.reconciling || service.terminalCondition?.state !== "CONDITION_SUCCEEDED") throw new Error("Guardian has not been restored.");
  await save(context, "queued", "Previous allocation retired. The next run requires its own authorised manifest entry.", context.state.index + 1);
}
